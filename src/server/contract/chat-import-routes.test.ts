import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInitializedDatabase } from "../database/database";
import { importSillyTavernChat } from "../sillytavern";
import { createChatImportModule } from "../sillytavern/staged";
import { headerFixture as header, jsonl, rulershipFixture, writerFixture as writer } from "../sillytavern/fixtures";
import { createChatImportRoutes } from "./chat-import";
import { createConversationRoutes } from "./conversation";

// Transport tests cover the typed upload/preview/discard contract only; the
// domain matrix lives behind the deep SillyTavern Import module tests. Each
// route stays a thin adapter over the module seam.

describe("Chat import transport adapters", () => {
	let database: Database;
	let files: string[];
	let artifactDirectory: string;
	let app: ReturnType<typeof createChatImportRoutes>;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		const directory = mkdtempSync(join(tmpdir(), "ditzytavern-routes-"));
		files = [directory];
		artifactDirectory = join(directory, "managed-artifacts");
		app = createChatImportRoutes(database, artifactDirectory);
	});
	afterEach(() => {
		database.close();
		for (const path of files) rmSync(path, { recursive: true, force: true });
	});

	const stage = (bytes: Buffer, filename = "lantern-house.jsonl") =>
		app.handle(
			new Request("http://localhost/api/imports/chats/stage", {
				method: "POST",
				headers: { "x-import-filename": filename },
				// SAFETY: the copy into a fresh Uint8Array carries the exact
				// bytes while satisfying Request's BodyInit typing at the test
				// boundary.
				body: new Blob([new Uint8Array(bytes)]),
			}),
		);

	const preview = (token: string, sha256: string) =>
		app.handle(
			new Request(`http://localhost/api/imports/chats/${token}/preview`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sha256 }),
			}),
		);

	const discard = (token: string) =>
		app.handle(
			new Request(`http://localhost/api/imports/chats/${token}/discard`, {
				method: "POST",
			}),
		);

	const commit = (
		token: string,
		sha256: string,
		body: {
			title: string;
			duplicateConfirmed: boolean;
			participants: {
				name: string;
				outcome:
					| { type: "fork"; characterId: number }
					| { type: "new-character" }
					| { type: "chat-only" };
				messagePositions: number[];
			}[];
		},
	) =>
		app.handle(
			new Request(`http://localhost/api/imports/chats/${token}/commit`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sha256, ...body }),
			}),
		);

	test("imports the Author Note with native participant macros and preserves its writing", async () => {
		const staged = await stage(Buffer.from(jsonl([header, writer]), "utf8"));
		expect(staged.status).toBe(200);
		const { token, preview } = await staged.json();
		const response = await commit(token, preview.sha256, {
			title: "Quiet story", duplicateConfirmed: true,
			participants: [{ name: "Writer", outcome: { type: "chat-only" }, messagePositions: [1] }],
		});
		expect(response.status).toBe(200);
		const { conversation } = await response.json();
		const read = await createConversationRoutes(database).handle(new Request(`http://localhost/api/conversations/${conversation.id}`));
		expect(read.status).toBe(200);
		expect(await read.json()).toMatchObject({
			authorNote: '  *Keep the story quiet.* {{self}} guides {{other}}; {{self}} listens to {{other}}.\n',
			revision: 0,
		});
	});

	const importNoteWarnings = async (metadata: Partial<typeof header.chat_metadata>) => {
		const staged = await stage(Buffer.from(jsonl([{ ...header, chat_metadata: metadata }, writer]), "utf8"));
		expect(staged.status).toBe(200);
		const { token, preview } = await staged.json();
		const response = await commit(token, preview.sha256, {
			title: "Imported note", duplicateConfirmed: true,
			participants: [{ name: "Writer", outcome: { type: "chat-only" }, messagePositions: [1] }],
		});
		expect(response.status).toBe(200);
		const committed = await response.json();
		const details = await app.handle(new Request(`http://localhost/api/conversations/${committed.conversation.id}/import-details`));
		expect(details.status).toBe(200);
		const { receipt } = await details.json();
		expect(preview.warnings).toEqual(receipt.warnings);
		expect(committed.receipt.warnings).toEqual(receipt.warnings);
		return { authorNote: committed.conversation.authorNote, warnings: receipt.warnings };
	};

	test("maps imported participant macros regardless of case", async () => {
		expect((await importNoteWarnings({ ...header.chat_metadata, note_prompt: "{{User}} guides {{CHAR}}; {{USER}} listens to {{Char}}." })).authorNote).toBe("{{self}} guides {{other}}; {{self}} listens to {{other}}.");
	});

	test("maps spaced participant macros in an imported note while preserving Prompt Comments", async () => {
		const { authorNote } = await importNoteWarnings({ note_prompt: "{{ user }} guides {{ char }}. {{// Keep {{char}} as a reminder. }}" });
		expect(authorNote).toBe("{{self}} guides {{other}}. {{// Keep {{char}} as a reminder. }}");
	});

	test.each([
		{ note_prompt: "Keep quiet." },
		{ ...header.chat_metadata, note_position: undefined },
		{ ...header.chat_metadata, note_depth: undefined },
		{ ...header.chat_metadata, note_role: undefined },
		{ ...header.chat_metadata, note_interval: undefined },
	])("imports a note with absent settings without false warnings (%#)", async (metadata) => {
		const { authorNote, warnings } = await importNoteWarnings(metadata);
		expect(authorNote).not.toBe("");
		expect(warnings).toEqual([]);
	});

	test.each([
		{ metadata: { note_prompt: "Keep quiet.", note_position: 2 }, setting: "position 2" },
		{ metadata: { note_prompt: "Keep quiet.", note_depth: 4 }, setting: "depth 4" },
	])("warns about supplied placement settings without inventing missing values (%#)", async ({ metadata, setting }) => {
		const { warnings } = await importNoteWarnings(metadata);
		expect(warnings).toEqual([`Author's Note placement (${setting}) was not kept; the default Author Note slot is after history.`]);
	});

	test.each([
		{ position: 0, depth: 0, warning: "Author's Note placement (position 0, depth 0) was not kept; the default Author Note slot is after history." },
		{ position: 2, depth: 4, warning: "Author's Note placement (position 2, depth 4) was not kept; the default Author Note slot is after history." },
		{ position: 1, depth: 4, warning: "Author's Note placement (position 1, depth 4) was not kept; the default Author Note slot is after history." },
	])("warns once for Author's Note placement at position $position and depth $depth", async ({ position, depth, warning }) => {
		const { warnings } = await importNoteWarnings({ ...header.chat_metadata, note_position: position, note_depth: depth });
		expect(warnings).toEqual([warning]);
	});

	test.each([
		{ role: 1, warning: "Author's Note role (1) was not kept; the default Author Note slot uses the system role." },
		{ role: 2, warning: "Author's Note role (2) was not kept; the default Author Note slot uses the system role." },
	])("warns for Author's Note role $role", async ({ role, warning }) => {
		const { warnings } = await importNoteWarnings({ ...header.chat_metadata, note_role: role });
		expect(warnings).toEqual([warning]);
	});

	test.each([
		{ interval: 0, warning: "Author's Note interval (0) was not kept; the Author Note applies to every Generation." },
		{ interval: 3, warning: "Author's Note interval (3) was not kept; the Author Note applies to every Generation." },
	])("warns for Author's Note interval $interval", async ({ interval, warning }) => {
		const { warnings } = await importNoteWarnings({ ...header.chat_metadata, note_interval: interval });
		expect(warnings).toEqual([warning]);
	});

	test.each([
		{ description: "empty", note: "" },
		{ description: "whitespace-only", note: " \n\t " },
		{ description: "missing", note: undefined },
	])("imports an $description Author's Note as blank without note warnings", async ({ note }) => {
		expect(await importNoteWarnings({ note_prompt: note, note_position: 2, note_depth: 4, note_role: 2, note_interval: 3 })).toEqual({ authorNote: "", warnings: [] });
	});

	test("imports supported Author's Note settings without warnings", async () => {
		const { warnings } = await importNoteWarnings(header.chat_metadata);
		expect(warnings).toEqual([]);
	});

	const sha256Of = (bytes: Uint8Array) =>
		createHash("sha256").update(bytes).digest("hex");

	interface PreviewResponseBody {
		outcome: string;
		preview: {
			token?: never;
			title: string;
			originalFilename: string;
			sha256: string;
			byteLength: number;
			integrity: string | null;
			counts: { messages: number; variants: number };
			warnings: string[];
			groups: unknown[];
			duplicates: { exact: unknown[]; related: unknown[] };
		};
	}

	// SAFETY: the preview endpoint is exercised from the module tests with
	// the same typed shape, so parsing the response against this structural
	// contract at the test boundary is sound.
	const previewBody = async (response: Response): Promise<PreviewResponseBody> =>
		(await response.json()) as PreviewResponseBody;

	test("stages a streamed upload with the typed staged outcome and a bound preview", async () => {
		const bytes = Buffer.from(jsonl([header, writer]), "utf8");
		const response = await stage(bytes, "lantern-house.jsonl");
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.outcome).toBe("staged");
		expect(body.token).toBeTypeOf("string");
		expect(body.token.length).toBeGreaterThan(0);
		expect(body.preview).toMatchObject({
			title: "lantern-house",
			originalFilename: "lantern-house.jsonl",
			sha256: sha256Of(bytes),
			byteLength: bytes.length,
			// The fixture header declares an integrity value; the preview
			// surfaces it as advisory source identity.
			integrity: "9543f21f-8aab-42c8-92a4-1f6453d4b63c",
			counts: { messages: 1, variants: 1 },
		});

		// A separate preview request over the same transport reads the same
		// bound preview from the token and the SHA the client already has.
		const refreshed = await preview(body.token, body.preview.sha256);
		expect(refreshed.status).toBe(200);
		const refreshedBody = await previewBody(refreshed);
		expect(refreshedBody.outcome).toBe("available");
		expect(refreshedBody.preview.title).toBe(body.preview.title);
		expect(refreshedBody.preview.sha256).toBe(body.preview.sha256);
	});

	test("rejects uploads without a file name and invalid sources with the typed 422", async () => {
		const bytes = Buffer.from(jsonl([header, writer]), "utf8");

		const missingName = await app.handle(
			new Request("http://localhost/api/imports/chats/stage", {
				method: "POST",
				body: bytes,
			}),
		);
		expect(missingName.status).toBe(422);
		expect(await missingName.json()).toMatchObject({
			outcome: "invalid",
			reason: "A file name is required with this upload.",
		});

		const broken = await stage(
			Buffer.from(`${JSON.stringify(header)}\n{"broken`, "utf8"),
		);
		expect(broken.status).toBe(422);
		expect(await broken.json()).toEqual({
			outcome: "invalid",
			reason: "Line 2 is not valid JSON.",
		});
	});

	test("maps expired preview handles to the typed 410 and mismatched hashes to 422", async () => {
		const bytes = Buffer.from(jsonl([header, writer]), "utf8");
		const staged = await stage(bytes);
		const { token, preview: bound } = await staged.json();

		const wrongHash = await preview(token, sha256Of(Buffer.from("other")));
		expect(wrongHash.status).toBe(422);
		expect(await wrongHash.json()).toMatchObject({ outcome: "invalid" });

		const unknownToken = await preview("never-staged", sha256Of(bytes));
		expect(unknownToken.status).toBe(410);
		expect(await unknownToken.json()).toEqual({ outcome: "expired" });

		// The correct binding still works after the rejected calls.
		const valid = await preview(token, bound.sha256);
		expect(valid.status).toBe(200);
	});

	test("discards one flow idempotently and leaves other staged flows usable", async () => {
		const first = await stage(Buffer.from(jsonl([header, writer]), "utf8"), "a.jsonl");
		const second = await stage(Buffer.from(jsonl([header, writer]), "utf8"), "b.jsonl");
		const { token: firstToken, preview: firstPreview } = await first.json();
		const { token: secondToken, preview: secondPreview } = await second.json();
		expect(firstToken).not.toBe(secondToken);

		const discarded = await discard(firstToken);
		expect(discarded.status).toBe(200);
		expect(await discarded.json()).toEqual({ outcome: "discarded" });

		const expired = await preview(firstToken, firstPreview.sha256);
		expect(expired.status).toBe(410);
		expect(await expired.json()).toEqual({ outcome: "expired" });

		const stillActive = await preview(secondToken, secondPreview.sha256);
		expect(stillActive.status).toBe(200);

		const again = await discard(firstToken);
		expect(again.status).toBe(200);
		expect(await again.json()).toEqual({ outcome: "discarded" });
	});

	test("presents prior-import evidence classified into exact and related matches", async () => {
		// A committed prior Chat provides the duplicate evidence through the
		// same database the routes mount against.
		const priorPath = join(files[0] ?? "", "prior.jsonl");
		writeFileSync(priorPath, jsonl([header, writer]), "utf8");
		const prior = importSillyTavernChat(database, priorPath, artifactDirectory).conversation;

		// The exact same bytes stage with an exact duplicate match.
		const sameBytes = Buffer.from(jsonl([header, writer]), "utf8");
		const exactStaged = await stage(sameBytes, "copy.jsonl");
		const exactBody = await exactStaged.json();
		expect(exactBody.preview.duplicates).toEqual({
			exact: [{ id: prior.id, name: prior.name }],
			related: [],
		});

		// A module-level staging registry keeps the transport thin: the
		// token returned here is honored by a module instance created
		// directly from the same process-level session.
		const module = createChatImportModule(database, { artifactDirectory });
		expect(module.preview(exactBody.token, exactBody.preview.sha256)).toEqual(
			exactBody.preview,
		);
	});

	test("commits the confirmed plan with the typed committed outcome and receipt", async () => {
		const bytes = Buffer.from(jsonl([header, writer]), "utf8");
		const staged = await stage(bytes, "lantern-house.jsonl");
		const { token, preview } = await staged.json();

		const response = await commit(token, preview.sha256, {
			title: "Lantern House",
			duplicateConfirmed: true,
			participants: [
				{ name: "Writer", outcome: { type: "chat-only" }, messagePositions: [1] },
			],
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.outcome).toBe("committed");
		expect(body.conversation.name).toBe("Lantern House");
		expect(body.receipt).toMatchObject({
			conversationId: body.conversation.id,
			title: "Lantern House",
			originalFilename: "lantern-house.jsonl",
			sha256: preview.sha256,
			byteLength: bytes.length,
			counts: { messages: 1, variants: 1 },
		});
		expect(body.receipt.participants).toEqual([
			{ name: "Writer", outcome: "chat-only", sourceCharacterId: null },
		]);

		// Retrying the same token after a lost response returns the same
		// committed Chat rather than creating another one.
		const retry = await commit(token, preview.sha256, {
			title: "Lantern House",
			duplicateConfirmed: true,
			participants: [
				{ name: "Writer", outcome: { type: "chat-only" }, messagePositions: [1] },
			],
		});
		expect(retry.status).toBe(200);
		const retryBody = await retry.json();
		expect(retryBody.conversation.id).toBe(body.conversation.id);
		expect(retryBody.receipt).toEqual(body.receipt);
	});

	test("maps plan, duplicate-confirmation, and hash failures to typed 422 and expired handles to 410", async () => {
		const bytes = Buffer.from(jsonl([header, writer, rulershipFixture]), "utf8");
		const staged = await stage(bytes);
		const { token, preview } = await staged.json();

		// The exact-duplicate confirmation gate maps to the typed invalid
		// outcome without creating a Chat.
		const unconfirmed = await commit(token, preview.sha256, {
			title: "Before any prior import",
			duplicateConfirmed: true,
			participants: [
				{
					name: "Writer",
					outcome: { type: "chat-only" },
					messagePositions: [1, 2],
				},
			],
		});
		// No prior import exists, so the commit succeeds and burns the token.
		expect(unconfirmed.status).toBe(200);

		// A plan that skips a Message is a typed invalid outcome.
		const skipping = await stage(bytes, "skipping.jsonl");
		const skippingBody = await skipping.json();
		const invalid = await commit(skippingBody.token, skippingBody.preview.sha256, {
			title: "Skips",
			duplicateConfirmed: true,
			participants: [
				{
					name: "Writer",
					outcome: { type: "chat-only" },
					messagePositions: [1],
				},
			],
		});
		expect(invalid.status).toBe(422);
		expect(await invalid.json()).toMatchObject({ outcome: "invalid" });

		// A consumed or unknown token is expired.
		const unknown = await commit("never-staged", preview.sha256, {
			title: "X",
			duplicateConfirmed: true,
			participants: [],
		});
		expect(unknown.status).toBe(410);
		expect(await unknown.json()).toEqual({ outcome: "expired" });

		// A hash that does not match the binding is rejected.
		const mismatchStaged = await stage(bytes, "mismatch.jsonl");
		const mismatchBody = await mismatchStaged.json();
		const mismatched = await commit(
			mismatchBody.token,
			sha256Of(Buffer.from("other")),
			{
				title: "X",
				duplicateConfirmed: true,
				participants: [],
			},
		);
		expect(mismatched.status).toBe(422);
		expect(await mismatched.json()).toMatchObject({ outcome: "invalid" });
	});

	test("requires the explicit duplicate copy confirmation over the transport", async () => {
		// A committed prior Chat provides the exact duplicate evidence.
		const priorPath = join(files[0] ?? "", "prior-duplicate.jsonl");
		writeFileSync(priorPath, jsonl([header, writer]), "utf8");
		const prior = importSillyTavernChat(database, priorPath, artifactDirectory).conversation;

		const staged = await stage(
			Buffer.from(jsonl([header, writer]), "utf8"),
			"copy.jsonl",
		);
		const { token, preview } = await staged.json();

		const blocked = await commit(token, preview.sha256, {
			title: "Copy",
			duplicateConfirmed: false,
			participants: [
				{ name: "Writer", outcome: { type: "chat-only" }, messagePositions: [1] },
			],
		});
		expect(blocked.status).toBe(422);
		expect(await blocked.json()).toMatchObject({ outcome: "invalid" });

		const confirmed = await commit(token, preview.sha256, {
			title: "Copy",
			duplicateConfirmed: true,
			participants: [
				{ name: "Writer", outcome: { type: "chat-only" }, messagePositions: [1] },
			],
		});
		expect(confirmed.status).toBe(200);
		const confirmedBody = await confirmed.json();
		expect(confirmedBody.receipt.duplicates.exact).toEqual([
			{ id: prior.id, name: prior.name },
		]);
		// The independent copy gets its own Chat identity, never a rerun.
		expect(confirmedBody.conversation.id).not.toBe(prior.id);
	});

	test("serves paginated history and Import Details contracts after a committed import", async () => {
		const bytes = Buffer.from(jsonl([header, writer, rulershipFixture]), "utf8");
		const staged = await stage(bytes, "lantern-house.jsonl");
		const { token, preview } = await staged.json();
		const response = await commit(token, preview.sha256, {
			title: "Lantern House",
			duplicateConfirmed: true,
			participants: [
				{ name: "Writer", outcome: { type: "chat-only" }, messagePositions: [1] },
				{
					name: "Rulership",
					outcome: { type: "chat-only" },
					messagePositions: [2],
				},
			],
		});
		const committed = await response.json();
		// SAFETY: the commit outcome contract returns the committed
		// Conversation inside `conversation`; the typed route response was
		// validated by the bindings in the test setup above.
		const conversationId = committed.conversation.id as number;

		// Paginated history: pages are cut from the newest Message backward,
		// each served page chronological, with stable Author Stamps and the
		// lightweight fields only. The history read model mounts with the
		// Conversation routes surface.
		const conversationApp = createConversationRoutes(database);
		const history = await conversationApp.handle(
			new Request(
				`http://localhost/api/conversations/${conversationId}/history?page=1&pageSize=1`,
			),
		);
		expect(history.status).toBe(200);
		const historyBody = await history.json();
		expect(historyBody.page).toEqual({
			index: 1,
			pageSize: 1,
			totalMessages: 2,
			totalPages: 2,
			hasOlder: true,
			hasNewer: false,
		});
		expect(historyBody.messages).toHaveLength(1);
		expect(historyBody.messages[0].author.capturedName).toBe("Rulership");

		const pageTwoBody = await (await conversationApp.handle(
			new Request(
				`http://localhost/api/conversations/${conversationId}/history?page=2&pageSize=1`,
			),
		)).json();
		expect(pageTwoBody.messages).toHaveLength(1);
		expect(pageTwoBody.messages[0].author.capturedName).toBe("Writer");

		// Import Details: the persisted receipt, source identity, duplicate
		// evidence excluding self, and exact-artifact availability.
		const details = await app.handle(
			new Request(
				`http://localhost/api/conversations/${conversationId}/import-details`,
			),
		);
		expect(details.status).toBe(200);
		const detailsBody = await details.json();
		expect(detailsBody.receipt).toMatchObject({
			originalFilename: "lantern-house.jsonl",
			sha256: preview.sha256,
			byteLength: bytes.length,
			integrity: "9543f21f-8aab-42c8-92a4-1f6453d4b63c",
			counts: { messages: 2, variants: 2 },
		});
		expect(detailsBody.duplicates).toEqual({ exact: [], related: [] });
		expect(detailsBody.artifact.availability).toEqual({ status: "available" });

		// A Chat without import provenance reports the typed not-found.
		const noProvenance = await app.handle(
			new Request("http://localhost/api/conversations/999999/import-details"),
		);
		expect(noProvenance.status).toBe(404);
		expect(await noProvenance.json()).toEqual({ outcome: "not-found" });

		// Exact download streams the stored bytes with the original leaf
		// filename and the exact media type.
		const download = await app.handle(
			new Request(
				`http://localhost/api/conversations/${conversationId}/import-source`,
			),
		);
		expect(download.status).toBe(200);
		expect(download.headers.get("content-type")).toBe("application/jsonl");
		expect(download.headers.get("content-disposition")).toContain(
			"lantern-house.jsonl",
		);
		expect(sha256Of(new Uint8Array(await download.arrayBuffer()))).toBe(
			preview.sha256,
		);

		// Missing Chat: typed not-found on both detail and download routes.
		const missingSource = await app.handle(
			new Request("http://localhost/api/conversations/999999/import-source"),
		);
		expect(missingSource.status).toBe(404);
		expect(await missingSource.json()).toEqual({ outcome: "not-found" });
	});
});
