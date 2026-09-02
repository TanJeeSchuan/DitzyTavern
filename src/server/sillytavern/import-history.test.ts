import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createConversationModule } from "../conversation";
import { openDatabase } from "../database/database";
import { artifactTable, chatDataTable } from "../database/schema";
import { importSillyTavernChat } from "./import";
import {
	createChatImportDetailsModule,
	type ChatImportDetails,
	type ChatImportDetailsModule,
} from "./import-details";
import { IMPORT_KEYS, IMPORT_NAMESPACE } from "./adapter";
import { findPriorImportsBySource } from "./prior-imports";
import {
	clearStagedImportRegistry,
	createChatImportModule,
	type ChatImportCommitInput,
	type ChatImportModule,
} from "./staged";
import {
	headerFixture as header,
	jsonl,
	rulershipFixture as rulership,
	swipeRecordFixture as swipeRecord,
	writerFixture as writer,
} from "./fixtures";

// Graduated reading and Import Details: an imported Chat opens through the
// same paginated native read model as every other Chat, swipe navigation is
// the existing revisioned Variant-selection command, both preserved source
// representations stay immutable under native edits, and Import Details
// loads the receipt, source identity, duplicate evidence, and exact-artifact
// availability on demand without ever breaking normal reading or commands.

const sha256Of = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");

const readableDetails = (details: ChatImportDetails | undefined) => {
	if (details?.provenanceState !== "readable") {
		throw new Error("expected readable import details");
	}
	return details;
};

describe("graduated Chat history and Import Details", () => {
	let database: Database;
	let files: string[];
	let artifactDirectory: string;
	let module: ChatImportModule;
	let details: ChatImportDetailsModule;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
		const directory = mkdtempSync(join(tmpdir(), "ditzytavern-history-"));
		files = [directory];
		artifactDirectory = join(directory, "managed-artifacts");
		module = createChatImportModule(database, { artifactDirectory });
		details = createChatImportDetailsModule(database, artifactDirectory);
		clearStagedImportRegistry();
	});
	afterEach(() => {
		database.close();
		for (const path of files) rmSync(path, { recursive: true, force: true });
		clearStagedImportRegistry();
	});

	const stageBytes = (bytes: Buffer, filename = "lantern-house.jsonl") =>
		module.stageFile({
			bytes: new Blob([new Uint8Array(bytes)]).stream(),
			originalFilename: filename,
		});

	const stageText = (records: unknown[], filename = "lantern-house.jsonl") => {
		const bytes = Buffer.from(jsonl(records), "utf8");
		return { bytes, staged: () => stageBytes(bytes, filename) };
	};

	const commitAll = (
		token: string,
		sha256: string,
		participants: ChatImportCommitInput["participants"],
		title = "Lantern House",
	) =>
		module.commit(token, {
			sha256,
			title,
			duplicateConfirmed: true,
			participants,
		});

	const chatOnly = (name: string, messagePositions: number[]): ChatImportCommitInput["participants"][number] => ({
		name,
		outcome: { type: "chat-only" },
		messagePositions,
	});

	const exactArtifactPath = (conversationId: number): string => {
		const owned = drizzle(database)
			.select()
			.from(artifactTable)
			.where(eq(artifactTable.chat_id, conversationId))
			.all();
		const artifact = owned.find((entry) => entry.namespace === "import.sillytavern");
		if (artifact === undefined) throw new Error("missing artifact metadata row");
		return join(artifactDirectory, artifact.relative_path);
	};

	const archiveText = (conversationId: number): string => {
		const db = drizzle(database);
		const entries = db
			.select()
			.from(chatDataTable)
			.where(eq(chatDataTable.chat_id, conversationId))
			.all();
		const archive = entries.find(
			(entry) => entry.namespace === "archive" && entry.key === "source",
		);
		if (archive === undefined) throw new Error("missing canonical archive");
		return archive.value;
	};

	const priorImport = (records: unknown[], filename = "prior.jsonl") => {
		const path = join(files[0] ?? "", filename);
		writeFileSync(path, jsonl(records), "utf8");
		return importSillyTavernChat(database, path, artifactDirectory).conversation;
	};

	test("a committed import reads as ordinary paginated history with resolved Author Stamps", async () => {
		const source = stageText([header, writer, swipeRecord]);
		const staged = await source.staged();
		const { token, preview } = staged;
		const result = commitAll(token, preview.sha256, [
			chatOnly("Writer", [1]),
			chatOnly("TANJS", [2]),
		]);

		const conversations = createConversationModule(database);
		const history = conversations.readHistory(result.conversation.id, {
			pageSize: 10,
		});
		expect(history?.cast.map((participant) => participant.name)).toEqual([
			"Writer",
			"TANJS",
		]);
		expect(history?.messages).toHaveLength(2);

		// Transcript authorship uses the native Author Stamp created from the
		// resolved Participant name; the source role flags (is_user, is_system)
		// never shape identity.
		expect(history?.messages[0]?.author).toEqual({
			participantId: result.conversation.cast[0]?.id,
			capturedName: "Writer",
			inCast: true,
		});
		expect(history?.messages[1]?.author).toEqual({
			participantId: result.conversation.cast[1]?.id,
			capturedName: "TANJS",
			inCast: true,
		});

		// The source-selected Swipe (swipe_id 1) initialized the selected
		// native Variant, and the empty and duplicate alternatives remain
		// distinct positions with their exact content.
		const swipes = history?.messages[1]?.variants ?? [];
		expect(swipes.map((variant) => variant.content)).toEqual([
			"First alternative text",
			"Second alternative, still saved",
			"Second alternative, still saved",
			"",
		]);
		expect(
			swipes.map((variant) => variant.selected),
		).toEqual([false, true, false, false]);
	});

	test("revisioned Variant selection persists natively and never touches either preserved source", async () => {
		const source = stageText([header, writer, swipeRecord]);
		const staged = await source.staged();
		const { token, preview } = staged;
		const result = commitAll(token, preview.sha256, [
			chatOnly("Writer", [1]),
			chatOnly("TANJS", [2]),
		]);

		const conversations = createConversationModule(database);
		const before = conversations.readHistory(result.conversation.id, {
			pageSize: 10,
		});
		const swipedMessage = before?.messages[1];
		const target = swipedMessage?.variants.find(
			(variant) => variant.content === "",
		);
		expect(target).toBeDefined();
		const archiveBefore = archiveText(result.conversation.id);
		const artifactPath = exactArtifactPath(result.conversation.id);
		const bytesBefore = readFileSync(artifactPath);

		// Normal swipe navigation executes the existing revisioned Variant
		// selection command: selection persists and later Messages are kept.
		const applied = conversations.execute({
			conversationId: result.conversation.id,
			expectedRevision: result.conversation.revision,
			action: {
				type: "select-variant",
				messageId: swipedMessage?.id ?? 0,
				variantId: target?.id ?? 0,
			},
		});
		expect(applied.revision).toBe(result.conversation.revision + 1);

		const after = conversations.readHistory(result.conversation.id, {
			pageSize: 10,
		});
		const selection = after?.messages[1]?.variants;
		expect(
			selection?.map((variant) => variant.selected),
		).toEqual([false, false, false, true]);

		// Neither source representation changed: the canonical archive JSON
		// and the exact stored bytes are bit-for-bit identical.
		expect(archiveText(result.conversation.id)).toBe(archiveBefore);
		expect(readFileSync(artifactPath)).toEqual(bytesBefore);
		expect(sha256Of(bytesBefore)).toBe(preview.sha256);
	});

	test("normal native edits and Participant renames leave canonical and exact source immutable", async () => {
		const source = stageText([header, writer, rulership]);
		const staged = await source.staged();
		const { token, preview } = staged;
		const result = commitAll(token, preview.sha256, [
			chatOnly("Writer", [1]),
			chatOnly("Rulership", [2]),
		]);

		const archiveBefore = archiveText(result.conversation.id);
		const artifactPath = exactArtifactPath(result.conversation.id);
		const bytesBefore = readFileSync(artifactPath);

		const conversations = createConversationModule(database);
		let snapshot = conversations.execute({
			conversationId: result.conversation.id,
			expectedRevision: result.conversation.revision,
			action: {
				type: "edit-variant",
				messageId: result.conversation.messages[0]?.variants[0]?.id ?? 0,
				variantId: result.conversation.messages[0]?.variants[0]?.id ?? 0,
				content: "Edited native text",
			},
		});
		snapshot = conversations.execute({
			conversationId: result.conversation.id,
			expectedRevision: snapshot.revision,
			action: {
				type: "rename-participant",
				participantId: result.conversation.cast[0]?.id ?? 0,
				name: "Renamed Writer",
			},
		});

		// Native reads reflect the edits; both preserved sources stay frozen.
		const history = conversations.readHistory(result.conversation.id, {
			pageSize: 10,
		});
		expect(history?.messages[0]?.variants[0]?.content).toBe("Edited native text");
		expect(history?.cast[0]?.name).toBe("Renamed Writer");
		expect(archiveText(result.conversation.id)).toBe(archiveBefore);
		expect(readFileSync(artifactPath)).toEqual(bytesBefore);
		expect(sha256Of(bytesBefore)).toBe(preview.sha256);
	});

	test("Import Details shows the receipt, source identity, byte length, counts, warnings, and artifact availability", async () => {
		const source = stageText([header, writer, rulership], "lantern-house.jsonl");
		const staged = await source.staged();
		const { token, preview } = staged;
		const result = commitAll(token, preview.sha256, [
			chatOnly("Writer", [1]),
			chatOnly("Rulership", [2]),
		]);

		const loaded = readableDetails(details.importDetails(result.conversation.id));
		expect(loaded.title).toBe("Lantern House");
		expect(loaded.receipt).toMatchObject({
			originalFilename: "lantern-house.jsonl",
			sha256: preview.sha256,
			byteLength: source.bytes.length,
			integrity: "9543f21f-8aab-42c8-92a4-1f6453d4b63c",
			counts: { messages: 2, variants: 2 },
			importerVersion: "0.2.0",
		});
		// The persisted warning for the blank captured author is present… the
		// fixture carries none, so warnings may be empty; never fabricate.
		expect(Array.isArray(loaded.receipt.warnings)).toBe(true);
		// Duplicate evidence excludes this Chat itself.
		expect(loaded.duplicates).toEqual({ exact: [], related: [] });
		expect(loaded.artifact).toMatchObject({
			originalFilename: "lantern-house.jsonl",
			byteLength: source.bytes.length,
			sha256: preview.sha256,
			availability: { status: "available" },
		});

		// A Chat without import provenance has no Import Details.
		const native = createConversationModule(database).create({
			name: "Native Chat",
			participants: [{ definition: { name: "Writer", prompt: {
				systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "",
			}, openings: [] } }],
		});
		expect(details.importDetails(native.id)).toBeUndefined();
		expect(details.importDetails(999999)).toBeUndefined();
	});

	test("missing or corrupt exact artifacts report cleaned up and never break reading or commands", async () => {
		const source = stageText([header, writer, rulership]);
		const staged = await source.staged();
		const { token, preview } = staged;
		const result = commitAll(token, preview.sha256, [
			chatOnly("Writer", [1]),
			chatOnly("Rulership", [2]),
		]);
		const artifactPath = exactArtifactPath(result.conversation.id);

		// The exact bytes vanish; normal paginated reading still works.
		rmSync(artifactPath, { force: true });
		const conversations = createConversationModule(database);
		const history = conversations.readHistory(result.conversation.id, {
			pageSize: 10,
		});
		expect(history?.messages).toHaveLength(2);

		const loaded = readableDetails(details.importDetails(result.conversation.id));
		expect(loaded.artifact?.availability).toEqual({
			status: "cleaned-up",
			reason: "missing",
		});
		const download = details.downloadExactSource(result.conversation.id);
		expect(download).toMatchObject({
			status: "cleaned-up",
			reason: "missing",
		});

		// Normal commands keep working after provenance loss.
		const applied = conversations.execute({
			conversationId: result.conversation.id,
			expectedRevision: result.conversation.revision,
			action: {
				type: "edit-variant",
				messageId: result.conversation.messages[0]?.variants[0]?.id ?? 0,
				variantId: result.conversation.messages[0]?.variants[0]?.id ?? 0,
				content: "Still editable",
			},
		});
		expect(applied.revision).toBe(result.conversation.revision + 1);

		// A corrupt artifact (bytes changed) reports cleaned up as corrupt and
		// disables only exact download.
		writeFileSync(artifactPath, Buffer.from("not the original bytes", "utf8"));
		const afterCorrupt = readableDetails(details.importDetails(result.conversation.id));
		expect(afterCorrupt.artifact?.availability).toEqual({
			status: "cleaned-up",
			reason: "corrupt",
		});
		expect(details.downloadExactSource(result.conversation.id)).toMatchObject({
			status: "cleaned-up",
			reason: "corrupt",
		});
	});

	test("corrupt persisted provenance is explicit and never makes a Chat a prior import", () => {
		const conversations = createConversationModule(database);
		const corrupt = conversations.create({
			name: "Corrupt Import",
			participants: [{
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
			}],
			messages: [{
				timestamp: "2026-08-08T12:53:02.008Z",
				variants: [{
					content: "Still a normal Chat",
					timestamp: "2026-08-08T12:53:02.008Z",
					selected: true,
				}],
			}],
			data: [{
				namespace: IMPORT_NAMESPACE,
				key: IMPORT_KEYS.reportJson,
				value: "not valid JSON",
			}],
		});

		expect(details.importDetails(corrupt.id)).toEqual({
			provenanceState: "unreadable",
			conversationId: corrupt.id,
			title: "Corrupt Import",
		});
		expect(findPriorImportsBySource(database, {
			filename: "corrupt.jsonl",
			sha256: "corrupt-sha256",
		})).toEqual({ exact: [], related: [] });
		expect(conversations.readHistory(corrupt.id)?.messages).toHaveLength(1);
	});

	test("duplicate evidence in Import Details excludes this Chat and classifies related sources", async () => {
		// A committed prior Chat importing the exact same bytes becomes the
		// exact duplicate evidence of a second imported copy.
		const prior = priorImport([header, writer], "first.jsonl");

		const staged = await stageText([header, writer], "copy.jsonl");
		const { token, preview } = await staged.staged();
		const result = commitAll(token, preview.sha256, [
			chatOnly("Writer", [1]),
		]);

		const loaded = readableDetails(details.importDetails(result.conversation.id));
		// The prior Chat is the exact duplicate; this Chat is excluded.
		expect(loaded.duplicates).toEqual({
			exact: [{ id: prior.id, name: prior.name }],
			related: [],
		});
		expect(loaded.artifact?.availability).toEqual({ status: "available" });
	});

	test("imported Chats receive the same availability rules as ordinary Chats: no imported read-only state", async () => {
		const source = stageText([header, writer, rulership]);
		const staged = await source.staged();
		const { token, preview } = staged;
		const result = commitAll(token, preview.sha256, [
			chatOnly("Writer", [1]),
			chatOnly("Rulership", [2]),
		]);

		const conversations = createConversationModule(database);
		// Control assignment and Cast management work exactly like native
				// Chats; nothing imported-specific blocks them. Import Control set the
		// model seat on the second Participant, so assigning the human seat to
		// it performs the atomic seat swap.
		const snapshot = conversations.getSnapshot(result.conversation.id);
		expect(snapshot?.playable).toBe(true);
		const changed = conversations.execute({
			conversationId: result.conversation.id,
			expectedRevision: result.conversation.revision,
			action: {
				type: "assign-control",
				seat: "human",
				participantId: result.conversation.cast[1]?.id ?? 0,
			},
		});
		expect(changed.revision).toBe(result.conversation.revision + 1);
		expect(changed.control.humanParticipantId).toBe(
			result.conversation.cast[1]?.id,
		);
		expect(changed.control.modelParticipantId).toBe(
			result.conversation.cast[0]?.id,
		);
	});
});
