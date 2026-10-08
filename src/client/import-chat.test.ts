import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatImportRoutes } from "../server/contract";
import { createCharacterLibraryModule } from "../server/character-library";
import {
	headerFixture as header,
	jsonl,
	rulershipFixture,
	writerFixture as writer,
} from "../server/sillytavern/fixtures";
import { openInitializedDatabase } from "../server/database/database";
import type { ChatImportCommitInput } from "./import-chat";
import type { WirePayload } from "./lib/wire-decode";
import type { JsonValue } from "./conversation-stream";

// Narrow client-boundary tests for the transport's own concerns only:
// uploading exactly once, decoding wire responses into typed outcomes, and
// best-effort cancellation. The wire contract (statuses, reasons, receipts)
// is pinned by shared/chat-import-routes.test.ts and the domain matrix by
// the SillyTavern module seam tests, so no ground-truth payloads are
// re-asserted here.

Object.defineProperty(globalThis, "window", {
	configurable: true,
	// SAFETY: the test supplies the minimal browser location read by Eden.
	value: { location: { origin: "http://localhost" } } as Window,
});
const originalFetch = globalThis.fetch;
const { commitImport, discardImport, discardStagedImport, previewImport, stageImport } = await import("./import-chat");

const installFetch = (handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void => {
	globalThis.fetch = Object.assign(handler, { preconnect: () => {} });
};

const json = (status: number, payload: JsonValue): Response =>
	new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});

describe("Chat import client boundary", () => {
	let database: Database;
	let files: string[];
	let artifactDirectory: string;
	let stageRequestCount: number;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		const directory = mkdtempSync(join(tmpdir(), "ditzytavern-client-"));
		files = [directory];
		artifactDirectory = join(directory, "managed-artifacts");
		const app = createChatImportRoutes(database, artifactDirectory);
		stageRequestCount = 0;
		installFetch((input, init) => {
			if (String(input).includes("/stage")) {
				stageRequestCount += 1;
			}
			return app.handle(new Request(input, init));
		});
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		database.close();
		for (const path of files) rmSync(path, { recursive: true, force: true });
	});

	const bytes = (records: unknown[]) => Buffer.from(jsonl(records), "utf8");
	const file = (records: unknown[], _name = "lantern-house.jsonl") =>
		// SAFETY: the copy into a fresh Uint8Array carries the exact bytes
		// while satisfying Blob's ArrayBuffer typing at the test boundary.
		new Blob([new Uint8Array(bytes(records))]);

	test("uploads the selected file once and refreshes the preview from token and hash", async () => {
		// A matching Character arrives as a pre-filled but unconfirmed
		// suggestion; asserting it proves the parser carries the nested
		// group shape through, not just the scalar preview fields.
		createCharacterLibraryModule(database).execute({
			type: "create",
			definition: {
				name: "Writer",
				prompt: {
					systemInstruction: "",
					identity: "",
					scenario: "",
					exampleDialogue: "",
					postHistoryInstruction: "",
				},
				openings: [],
			},
		});
		const stageOutcome = await stageImport(
			file([header, writer]),
			"lantern-house.jsonl",
		);
		expect(stageOutcome.outcome).toBe("available");
		if (stageOutcome.outcome !== "available") return;
		const staged = stageOutcome.value;
		expect(stageRequestCount).toBe(1);
		expect(staged.preview.groups[0]?.suggestion?.confirmed).toBe(false);

		// A recoverable refresh reuses the token and hash; the file is never
		// re-uploaded.
		const refreshed = await previewImport(
			staged.token,
			staged.preview.sha256,
		);
		expect(refreshed.outcome).toBe("available");
		if (refreshed.outcome !== "available") return;
		expect(refreshed.value.preview).toEqual(staged.preview);
		expect(stageRequestCount).toBe(1);
	});

	test("maps stage and preview rejections to typed outcomes and cancels idempotently", async () => {
		const broken = await stageImport(
			// SAFETY: the copy into a fresh Uint8Array carries the exact bytes
			// while satisfying Blob's ArrayBuffer typing at the test boundary.
			new Blob([
				new Uint8Array(Buffer.from(`${JSON.stringify(header)}\n{"broken`, "utf8")),
			]),
			"broken.jsonl",
		);
		expect(broken.outcome).toBe("invalid");

		const staged = await stageImport(file([header, writer]), "a.jsonl");
		expect(staged.outcome).toBe("available");
		if (staged.outcome !== "available") return;
		expect(stageRequestCount).toBe(2);

		const wrongHash = await previewImport(staged.value.token, "0000");
		expect(wrongHash.outcome).toBe("invalid");

		const unknown = await previewImport("never-staged", staged.value.preview.sha256);
		expect(unknown.outcome).toBe("expired");

		await discardImport(staged.value.token);
		await discardImport(staged.value.token);

		const afterDiscard = await previewImport(
			staged.value.token,
			staged.value.preview.sha256,
		);
		expect(afterDiscard.outcome).toBe("expired");
	});

	test("commits the resolved plan, retries a lost response, and maps commit failures to typed outcomes", async () => {
		const staged = await stageImport(
			file([header, writer, rulershipFixture]),
			"two.jsonl",
		);
		expect(staged.outcome).toBe("available");
		if (staged.outcome !== "available") return;

		const commitPlan = (messagePositions: number[]): ChatImportCommitInput => ({
			title: "Two",
			duplicateConfirmed: true,
			participants: [
				{
					name: "Writer",
					outcome: { type: "chat-only" },
					messagePositions,
				},
			],
		});

		// A plan skipping a Message is a recoverable invalid outcome.
		const invalidPlan = await commitImport(
			staged.value.token,
			staged.value.preview.sha256,
			commitPlan([1]),
		);
		expect(invalidPlan.outcome).toBe("invalid");

		// The corrected plan commits, and a lost response retried with the
		// same token and payload returns the same committed Chat instead of
		// a second one.
		const committed = await commitImport(
			staged.value.token,
			staged.value.preview.sha256,
			commitPlan([1, 2]),
		);
		expect(committed.outcome).toBe("available");
		if (committed.outcome !== "available") return;
		expect(committed.value.conversation.id).toBe(committed.value.receipt.conversationId);

		const retry = await commitImport(
			staged.value.token,
			staged.value.preview.sha256,
			commitPlan([1, 2]),
		);
		expect(retry.outcome).toBe("available");
		if (retry.outcome !== "available") return;
		expect(retry.value.receipt.conversationId).toBe(committed.value.receipt.conversationId);
		expect(retry.value.receipt).toEqual(committed.value.receipt);

		const unknown = await commitImport(
			"never-staged",
			staged.value.preview.sha256,
			commitPlan([1, 2]),
		);
		expect(unknown.outcome).toBe("expired");
	});

	test("surfaces network failures without losing the typed outcome shape", async () => {
		installFetch(async () => {
			throw new Error("connection refused");
		});
		expect(
			(
				await stageImport(
					// SAFETY: the copy into a fresh Uint8Array carries the exact
					// bytes while satisfying Blob's ArrayBuffer typing at the
					// test boundary.
					new Blob([new Uint8Array(bytes([header, writer]))]),
					"x.jsonl",
				)
			).outcome,
		).toBe("network");
		expect((await previewImport("tok", "sha")).outcome).toBe("network");
		// Discard is best-effort: a lost request never rejects the caller.
		await expect(discardImport("tok")).resolves.toBeUndefined();
	});
});

// Focused decoder tests for the transport seam: canned fetch responses
// exercise the shared-schema decoding of every import response — valid
// payloads, missing fields, malformed nested values, and unexpected shapes
// — without standing up the server. A payload that fails its contract must
// normalize to a recoverable outcome instead of entering the import flow.
describe("Chat import response decoding", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	const previewGroup = {
		key: "Writer",
		isBlank: false,
		messagePositions: [1, 2],
		messageVariantCounts: [1, 1],
		messageCount: 2,
		variantCount: 2,
		participantNameDefault: "Writer",
		suggestion: {
			characterId: 3,
			name: "Writer",
			match: "case-insensitive",
			confirmed: false,
		},
	};

	const preview = {
		title: "Lantern House",
		originalFilename: "lantern-house.jsonl",
		sha256: "abc123",
		byteLength: 42,
		integrity: null,
		counts: { messages: 2, variants: 2 },
		warnings: ["Importer notice"],
		groups: [previewGroup],
		duplicates: {
			exact: [],
			related: [{ id: 5, name: "Lantern House" }],
		},
	};

	// The committed response also carries the new Conversation summary; a
	// minimal summary literal proves the nested summary decodes too.
	const conversationSummary = {
		authorNote: "",
		id: 7,
		name: "Lantern House",
		revision: 1,
		cast: [],
		control: { humanParticipantId: null, modelParticipantId: null },
		controlValidity: { valid: false, reason: "missing-seat" },
		playable: false,
		capabilities: {
			compose: { available: false, reason: "conversation-not-playable" },
			generate: { available: false, reason: "conversation-not-playable" },
			swipe: { available: false, reason: "conversation-not-playable" },
		},
		activeGenerations: [],
	};

	const receipt = {
		conversationId: 7,
		title: "Lantern House",
		originalFilename: "lantern-house.jsonl",
		sha256: "abc123",
		byteLength: 42,
		counts: { messages: 2, variants: 2 },
		participants: [
			{ name: "Writer", outcome: "new-character", sourceCharacterId: null },
		],
		warnings: [],
		duplicates: { exact: [], related: [] },
	};

	// The canned-body payload union: every shape the crafted responses
	// need, including deliberately malformed wire bodies (missing fields,
	// wrong literals) that the decoder must reject.
	const installResponder = (respond: (url: string) => Response): void => {
		installFetch((input) => Promise.resolve(respond(String(input))));
	};

	test("decodes a valid staged response into the typed staged outcome", async () => {
		installResponder((url) =>
			url.endsWith("/stage")
				? json(200, { outcome: "staged", token: "tok_1", preview } satisfies WirePayload)
				: json(500, {}),
		);
		const outcome = await stageImport(new Blob([new Uint8Array(4)]), "lantern-house.jsonl");
		expect(outcome.outcome).toBe("available");
		if (outcome.outcome !== "available") return;
		expect(outcome.value.token).toBe("tok_1");
		expect(outcome.value.preview.title).toBe("Lantern House");
		expect(outcome.value.preview.groups[0]?.suggestion?.match).toBe("case-insensitive");
		expect(outcome.value.preview.duplicates.related).toEqual([
			{ id: 5, name: "Lantern House" },
		]);
	});

	test("decodes a valid preview response into the typed available outcome", async () => {
		installResponder((url) =>
			url.includes("/preview")
				? json(200, { outcome: "available", preview } satisfies WirePayload)
				: json(500, {}),
		);
		const outcome = await previewImport("tok_1", "abc123");
		expect(outcome.outcome).toBe("available");
		if (outcome.outcome !== "available") return;
		expect(outcome.value.preview.sha256).toBe("abc123");
		expect(outcome.value.preview.groups[0]?.messagePositions).toEqual([1, 2]);
	});

	test("decodes a valid committed response with its receipt", async () => {
		installResponder((url) =>
			url.includes("/commit")
				? json(200, { outcome: "committed", conversation: conversationSummary, receipt } satisfies WirePayload)
				: json(500, {}),
		);
		const outcome = await commitImport("tok_1", "abc123", {
			title: "Lantern House",
			duplicateConfirmed: true,
			participants: [],
		});
		expect(outcome.outcome).toBe("available");
		if (outcome.outcome !== "available") return;
		expect(outcome.value.receipt.conversationId).toBe(7);
		expect(outcome.value.receipt.participants[0]?.outcome).toBe("new-character");
	});

	test("maps typed invalid outcomes with their contextual reason", async () => {
		const invalid = (reason: string) => json(422, { outcome: "invalid", reason });
		installResponder((url) =>
			url.endsWith("/stage") ? invalid("A file name is required with this upload.") : json(500, {}),
		);
		const stageOutcome = await stageImport(new Blob([new Uint8Array(4)]), "x.jsonl");
		expect(stageOutcome).toEqual({
			outcome: "invalid",
			reason: "A file name is required with this upload.",
		});

		installResponder(() => invalid("Token hash mismatch."));
		const previewOutcome = await previewImport("tok_1", "0000");
		expect(previewOutcome).toEqual({ outcome: "invalid", reason: "Token hash mismatch." });

		installResponder(() => invalid("A Message position is not covered."));
		const commitOutcome = await commitImport("tok_1", "abc123", {
			title: "T",
			duplicateConfirmed: false,
			participants: [],
		});
		expect(commitOutcome).toEqual({
			outcome: "invalid",
			reason: "A Message position is not covered.",
		});
	});

	test("normalizes unexpected top-level response bodies to the network outcome", async () => {
		const unexpectedBodies: JsonValue[] = [null, "staged", 42, [], {}, "<html>"];
		for (const payload of unexpectedBodies) {
			installResponder(() => json(200, payload));
			const outcome = await stageImport(new Blob([new Uint8Array(4)]), "x.jsonl");
			expect(outcome).toEqual({ outcome: "network" });
		}
	});

	test("fails malformed nested values instead of coercing them", async () => {
		for (const broken of [
			// A suggestion match outside the closed literal union.
			{
				...preview,
				groups: [{
					...previewGroup,
					suggestion: { ...previewGroup.suggestion, match: "levenshtein" },
				}],
			},
			// A message position that is not an integer.
			{
				...preview,
				groups: [{ ...previewGroup, messagePositions: ["1", 2] }],
			},
			// A duplicate match without its name.
			{
				...preview,
				duplicates: { exact: [], related: [{ id: 5 }] },
			},
		] satisfies JsonValue[]) {
			installResponder(() =>
				json(200, { outcome: "staged", token: "tok_1", preview: broken } satisfies WirePayload));
			const outcome = await stageImport(new Blob([new Uint8Array(4)]), "x.jsonl");
			expect(outcome).toEqual({ outcome: "network" });
		}

		// The same holds for a committed receipt: a participant outcome
		// outside the closed union and an uninterpretable source character
		// id both reject the whole response.
		for (const brokenReceipt of [
			{
				...receipt,
				participants: [{ name: "Writer", outcome: "merged", sourceCharacterId: null }],
			},
			{
				...receipt,
				participants: [{ ...receipt.participants[0], sourceCharacterId: "3" }],
			},
		] satisfies JsonValue[]) {
			installResponder(() =>
				json(200, { outcome: "committed", conversation: conversationSummary, receipt: brokenReceipt } satisfies WirePayload));
			const outcome = await commitImport("tok_1", "abc123", {
				title: "T",
				duplicateConfirmed: false,
				participants: [],
			});
			expect(outcome).toEqual({ outcome: "network" });
		}
	});

	test("maps gone outcomes for preview and commit requests", async () => {
		installResponder(() => json(410, { outcome: "expired" }));
		expect(await previewImport("gone", "abc123")).toEqual({ outcome: "expired" });
		expect(
			await commitImport("gone", "abc123", {
				title: "T",
				duplicateConfirmed: false,
				participants: [],
			}),
		).toEqual({ outcome: "expired" });

		for (const reason of ["missing", "corrupt"] as const) {
			installResponder(() =>
				json(410, { outcome: "unavailable", reason }));
			expect(await previewImport("tok", "abc123")).toEqual({
				outcome: "unavailable",
				reason,
			});
		}
	});

	test("fails closed to network when a gone response cannot be decoded", async () => {
		const malformedGone: JsonValue[] = [
			{},
			{ outcome: "unavailable" },
			{ outcome: "unavailable", reason: "vanished" },
			{ outcome: "deleted" },
		];
		for (const payload of malformedGone) {
			installResponder(() => json(410, payload));
			// An error body outside the modeled unicode is a network-class
			// seam failure, symmetric with the 200 path: the view retries,
			// and the next gone response carries the typed recovery.
			expect(await previewImport("tok", "abc123")).toEqual({ outcome: "network" });
		}
	});

	test("normalizes a malformed invalid-outcome body to the network outcome", async () => {
		const malformedInvalid: JsonValue[] = [
			{ outcome: "invalid" },
			{ outcome: "invalid", reason: 42 },
			{ outcome: "boom" },
		];
		for (const payload of malformedInvalid) {
			installResponder(() => json(422, payload));
			const outcome = await previewImport("tok_1", "abc123");
			expect(outcome).toEqual({ outcome: "network" });
		}
	});

	test("cancellation through every Back/Cancel path is a no-op without a handle", () => {
		expect(() => discardStagedImport(null)).not.toThrow();
	});
});
