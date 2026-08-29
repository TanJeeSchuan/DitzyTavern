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
import { clearStagedImportRegistry } from "../server/sillytavern/staged";
import { openDatabase } from "../server/database/database";
import {
	createChatImportTransport,
	type ChatImportCommitInput,
	type ChatImportTransport,
} from "./import-chat";

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
		database = openDatabase({ path: ":memory:" });
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
		clearStagedImportRegistry();
	});
	afterEach(() => {
		database.close();
		for (const path of files) rmSync(path, { recursive: true, force: true });
		clearStagedImportRegistry();
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
