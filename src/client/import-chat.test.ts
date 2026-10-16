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
const { commitImport, discardImport, previewImport, stageImport } = await import("./import-chat");

const installFetch = (handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void => {
	globalThis.fetch = Object.assign(handler, { preconnect: () => {} });
};

const json = (status: number, payload: WirePayload): Response =>
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

describe("Chat import gone outcomes", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("maps gone outcomes for preview and commit requests", async () => {
		installFetch(() => Promise.resolve(json(410, { outcome: "expired" })));
		expect(await previewImport("gone", "abc123")).toEqual({ outcome: "expired" });
		expect(
			await commitImport("gone", "abc123", {
				title: "T",
				duplicateConfirmed: false,
				participants: [],
			}),
		).toEqual({ outcome: "expired" });

		for (const reason of ["missing", "corrupt"] as const) {
			installFetch(() => Promise.resolve(json(410, { outcome: "unavailable", reason })));
			expect(await previewImport("tok", "abc123")).toEqual({
				outcome: "unavailable",
				reason,
			});
		}
	});
});
