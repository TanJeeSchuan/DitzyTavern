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
import {
	createChatImportTransport,
	type ChatImportCommitInput,
	type ChatImportTransport,
} from "./import-chat";
import type { JsonValue } from "./lib/json-guards";

// Narrow client-boundary tests for the transport's own concerns only:
// uploading exactly once, parsing wire responses into typed outcomes, and
// best-effort cancellation. The wire contract (statuses, reasons, receipts)
// is pinned by shared/chat-import-routes.test.ts and the domain matrix by
// the SillyTavern module seam tests, so no ground-truth payloads are
// re-asserted here.

const base = "http://localhost";
describe("Chat import client boundary", () => {
	let database: Database;
	let files: string[];
	let artifactDirectory: string;
	let transport: ChatImportTransport;
	let stageRequestCount: number;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		const directory = mkdtempSync(join(tmpdir(), "ditzytavern-client-"));
		files = [directory];
		artifactDirectory = join(directory, "managed-artifacts");
		const app = createChatImportRoutes(database, artifactDirectory);
		stageRequestCount = 0;
		transport = createChatImportTransport({
			base,
			fetchImpl: (input, init) => {
				if (String(input).includes("/stage")) {
					stageRequestCount += 1;
				}
				return app.handle(new Request(input, init));
			},
		});
	});
	afterEach(() => {
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
		const stageOutcome = await transport.stage(
			file([header, writer]),
			"lantern-house.jsonl",
		);
		expect(stageOutcome.status).toBe("staged");
		if (stageOutcome.status !== "staged") return;
		expect(stageRequestCount).toBe(1);
		expect(stageOutcome.preview.groups[0]?.suggestion?.confirmed).toBe(false);

		// A recoverable refresh reuses the token and hash; the file is never
		// re-uploaded.
		const refreshed = await transport.preview(
			stageOutcome.token,
			stageOutcome.preview.sha256,
		);
		expect(refreshed.status).toBe("available");
		if (refreshed.status !== "available") return;
		expect(refreshed.preview).toEqual(stageOutcome.preview);
		expect(stageRequestCount).toBe(1);
	});

	test("maps stage and preview rejections to typed outcomes and cancels idempotently", async () => {
		const broken = await transport.stage(
			// SAFETY: the copy into a fresh Uint8Array carries the exact bytes
			// while satisfying Blob's ArrayBuffer typing at the test boundary.
			new Blob([
				new Uint8Array(Buffer.from(`${JSON.stringify(header)}\n{"broken`, "utf8")),
			]),
			"broken.jsonl",
		);
		expect(broken.status).toBe("invalid");

		const staged = await transport.stage(file([header, writer]), "a.jsonl");
		expect(staged.status).toBe("staged");
		if (staged.status !== "staged") return;
		expect(stageRequestCount).toBe(2);

		const wrongHash = await transport.preview(staged.token, "0000");
		expect(wrongHash.status).toBe("invalid");

		const unknown = await transport.preview("never-staged", staged.preview.sha256);
		expect(unknown.status).toBe("expired");

		await transport.discard(staged.token);
		await transport.discard(staged.token);

		const afterDiscard = await transport.preview(
			staged.token,
			staged.preview.sha256,
		);
		expect(afterDiscard.status).toBe("expired");
	});

	test("commits the resolved plan, retries a lost response, and maps commit failures to typed outcomes", async () => {
		const staged = await transport.stage(
			file([header, writer, rulershipFixture]),
			"two.jsonl",
		);
		expect(staged.status).toBe("staged");
		if (staged.status !== "staged") return;

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
		const invalidPlan = await transport.commit(
			staged.token,
			staged.preview.sha256,
			commitPlan([1]),
		);
		expect(invalidPlan.status).toBe("invalid");

		// The corrected plan commits, and a lost response retried with the
		// same token and payload returns the same committed Chat instead of
		// a second one.
		const committed = await transport.commit(
			staged.token,
			staged.preview.sha256,
			commitPlan([1, 2]),
		);
		expect(committed.status).toBe("committed");
		if (committed.status !== "committed") return;
		expect(committed.conversationId).toBe(committed.receipt.conversationId);

		const retry = await transport.commit(
			staged.token,
			staged.preview.sha256,
			commitPlan([1, 2]),
		);
		expect(retry.status).toBe("committed");
		if (retry.status !== "committed") return;
		expect(retry.conversationId).toBe(committed.conversationId);
		expect(retry.receipt).toEqual(committed.receipt);

		const unknown = await transport.commit(
			"never-staged",
			staged.preview.sha256,
			commitPlan([1, 2]),
		);
		expect(unknown.status).toBe("expired");
	});

	test("surfaces network failures without losing the typed outcome shape", async () => {
		const failing = createChatImportTransport({
			base,
			fetchImpl: () => {
				throw new Error("connection refused");
			},
		});
		expect(
			(
				await failing.stage(
					// SAFETY: the copy into a fresh Uint8Array carries the exact
					// bytes while satisfying Blob's ArrayBuffer typing at the
					// test boundary.
					new Blob([new Uint8Array(bytes([header, writer]))]),
					"x.jsonl",
				)
			).status,
		).toBe("network");
		expect((await failing.preview("tok", "sha")).status).toBe("network");
		// Discard is best-effort: a lost request never rejects the caller.
		await expect(failing.discard("tok")).resolves.toBeUndefined();
	});
});

// Focused decoder tests for the transport seam: canned fetch responses
// exercise the shared-schema decoding of every import response — valid
// payloads, missing fields, malformed nested values, and unexpected shapes
// — without standing up the server. A payload that fails its contract must
// normalize to a recoverable outcome instead of entering the import flow.
describe("Chat import response decoding", () => {
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
	const json = (status: number, payload: JsonValue) =>
		new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		});

	const transportFor = (respond: (url: string) => Response) =>
		createChatImportTransport({
			base,
			fetchImpl: (input) => Promise.resolve(respond(String(input))),
		});

	test("decodes a valid staged response into the typed staged outcome", async () => {
		const transport = transportFor((url) =>
			url.endsWith("/stage")
				? json(200, { outcome: "staged", token: "tok_1", preview })
				: json(500, {}),
		);
		const outcome = await transport.stage(new Blob([new Uint8Array(4)]), "lantern-house.jsonl");
		expect(outcome.status).toBe("staged");
		if (outcome.status !== "staged") return;
		expect(outcome.token).toBe("tok_1");
		expect(outcome.preview.title).toBe("Lantern House");
		expect(outcome.preview.groups[0]?.suggestion?.match).toBe("case-insensitive");
		expect(outcome.preview.duplicates.related).toEqual([
			{ id: 5, name: "Lantern House" },
		]);
	});

	test("decodes a valid preview response into the typed available outcome", async () => {
		const transport = transportFor((url) =>
			url.includes("/preview")
				? json(200, { outcome: "available", preview })
				: json(500, {}),
		);
		const outcome = await transport.preview("tok_1", "abc123");
		expect(outcome.status).toBe("available");
		if (outcome.status !== "available") return;
		expect(outcome.preview.sha256).toBe("abc123");
		expect(outcome.preview.groups[0]?.messagePositions).toEqual([1, 2]);
	});

	test("decodes a valid committed response with its receipt", async () => {
		const transport = transportFor((url) =>
			url.includes("/commit")
				? json(200, { outcome: "committed", conversation: conversationSummary, receipt })
				: json(500, {}),
		);
		const outcome = await transport.commit("tok_1", "abc123", {
			title: "Lantern House",
			duplicateConfirmed: true,
			participants: [],
		});
		expect(outcome.status).toBe("committed");
		if (outcome.status !== "committed") return;
		expect(outcome.conversationId).toBe(7);
		expect(outcome.receipt.participants[0]?.outcome).toBe("new-character");
	});

	test("maps typed invalid outcomes with their contextual reason", async () => {
		const invalid = (reason: string) => json(422, { outcome: "invalid", reason });
		const staged = transportFor((url) =>
			url.endsWith("/stage") ? invalid("A file name is required with this upload.") : json(500, {}),
		);
		const stageOutcome = await staged.stage(new Blob([new Uint8Array(4)]), "x.jsonl");
		expect(stageOutcome).toEqual({
			status: "invalid",
			reason: "A file name is required with this upload.",
		});

		const preview = transportFor(() => invalid("Token hash mismatch."));
		const previewOutcome = await preview.preview("tok_1", "0000");
		expect(previewOutcome).toEqual({ status: "invalid", reason: "Token hash mismatch." });

		const commit = transportFor(() => invalid("A Message position is not covered."));
		const commitOutcome = await commit.commit("tok_1", "abc123", {
			title: "T",
			duplicateConfirmed: false,
			participants: [],
		});
		expect(commitOutcome).toEqual({
			status: "invalid",
			reason: "A Message position is not covered.",
		});
	});

	test("normalizes unexpected top-level response bodies to the network outcome", async () => {
		const unexpectedBodies: JsonValue[] = [null, "staged", 42, [], {}, "<html>"];
		for (const payload of unexpectedBodies) {
			const transport = transportFor(() => json(200, payload));
			const outcome = await transport.stage(new Blob([new Uint8Array(4)]), "x.jsonl");
			expect(outcome).toEqual({ status: "network" });
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
			const transport = transportFor(() =>
				json(200, { outcome: "staged", token: "tok_1", preview: broken }));
			const outcome = await transport.stage(new Blob([new Uint8Array(4)]), "x.jsonl");
			expect(outcome).toEqual({ status: "network" });
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
			const transport = transportFor(() =>
				json(200, { outcome: "committed", conversation: conversationSummary, receipt: brokenReceipt }));
			const outcome = await transport.commit("tok_1", "abc123", {
				title: "T",
				duplicateConfirmed: false,
				participants: [],
			});
			expect(outcome).toEqual({ status: "network" });
		}
	});

	test("maps gone outcomes for preview and commit requests", async () => {
		const expired = transportFor(() => json(410, { outcome: "expired" }));
		expect(await expired.preview("gone", "abc123")).toEqual({ status: "expired" });
		expect(
			await expired.commit("gone", "abc123", {
				title: "T",
				duplicateConfirmed: false,
				participants: [],
			}),
		).toEqual({ status: "expired" });

		for (const reason of ["missing", "corrupt"] as const) {
			const unavailable = transportFor(() =>
				json(410, { outcome: "unavailable", reason }));
			expect(await unavailable.preview("tok", "abc123")).toEqual({
				status: "unavailable",
				reason,
			});
		}
	});

	test("fails closed when a gone response cannot be decoded", async () => {
		const malformedGone: JsonValue[] = [
			{},
			{ outcome: "unavailable" },
			{ outcome: "unavailable", reason: "vanished" },
			{ outcome: "deleted" },
		];
		for (const payload of malformedGone) {
			const transport = transportFor(() => json(410, payload));
			// The handle is gone regardless of how the body failed; reselect
			// is the only recovery a malformed gone-state supports.
			expect(await transport.preview("tok", "abc123")).toEqual({ status: "expired" });
		}
	});

	test("normalizes a malformed invalid-outcome body to the network outcome", async () => {
		const malformedInvalid: JsonValue[] = [
			{ outcome: "invalid" },
			{ outcome: "invalid", reason: 42 },
			{ outcome: "boom" },
		];
		for (const payload of malformedInvalid) {
			const transport = transportFor(() => json(422, payload));
			const outcome = await transport.preview("tok_1", "abc123");
			expect(outcome).toEqual({ status: "network" });
		}
	});
});
