import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatImportRoutes } from "../shared/contract";
import { createCharacterLibraryModule } from "../server/character-library";
import { headerFixture as header, jsonl, writerFixture as writer } from "../server/sillytavern/fixtures";
import { clearStagedImportRegistry } from "../server/sillytavern/staged";
import { openDatabase } from "../server/database/database";
import { createChatImportTransport, type ChatImportTransport } from "./import-chat";

// Narrow adapter tests for the client boundary: the replaceable import
// client fetches against the same typed routes the browser would, backed by
// app.handle instead of a full server. The domain matrix stays behind the
// module seam tests; here the contracts (upload once, token/hash binding,
// error mapping, discard) are exercised through the one client boundary.

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
		// A matching Character gives the preview a name-only suggestion that
		// arrives pre-filled but visibly unconfirmed.
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

		const preview = stageOutcome.preview;
		expect(preview.title).toBe("lantern-house");
		expect(preview.sha256).toBe(
			createHash("sha256").update(bytes([header, writer])).digest("hex"),
		);
		expect(preview.groups[0]?.key).toBe("Writer");
		expect(preview.groups[0]?.suggestion?.confirmed).toBe(false);

		// A recoverable refresh reuses the token and hash; the file is never
		// re-uploaded.
		const refreshed = await transport.preview(
			stageOutcome.token,
			preview.sha256,
		);
		expect(refreshed.status).toBe("available");
		if (refreshed.status !== "available") return;
		expect(refreshed.preview).toEqual(preview);
		expect(stageRequestCount).toBe(1);
	});

	test("maps contextual validation failures and token or hash problems to typed outcomes", async () => {
		const broken = await transport.stage(
			// SAFETY: the copy into a fresh Uint8Array carries the exact bytes
			// while satisfying Blob's ArrayBuffer typing at the test boundary.
			new Blob([new Uint8Array(Buffer.from(`${JSON.stringify(header)}\n{"broken`, "utf8"))]),
			"broken.jsonl",
		);
		expect(broken).toEqual({
			status: "invalid",
			reason: "Line 2 is not valid JSON.",
		});

		const staged = await transport.stage(file([header, writer]), "ok.jsonl");
		expect(staged.status).toBe("staged");
		if (staged.status !== "staged") return;

		const wrongHash = await transport.preview(staged.token, "0000");
		expect(wrongHash.status).toBe("invalid");

		const unknown = await transport.preview("never-staged", staged.preview.sha256);
		expect(unknown.status).toBe("expired");
	});

	test("discard cancels the flow (idempotently) and the preview then expires", async () => {
		const staged = await transport.stage(file([header, writer]), "a.jsonl");
		expect(staged.status).toBe("staged");
		if (staged.status !== "staged") return;

		await transport.discard(staged.token);
		await transport.discard(staged.token);

		const afterDiscard = await transport.preview(
			staged.token,
			staged.preview.sha256,
		);
		expect(afterDiscard.status).toBe("expired");
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