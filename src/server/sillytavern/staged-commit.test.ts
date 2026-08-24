import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import {
	createCharacterLibraryModule,
	type CharacterDefinition,
} from "../character-library";
import { openDatabase } from "../database/database";
import {
	artifactTable,
	characterTable,
	characterPromptTable,
	chatDataTable,
	chatTable,
	messageTable,
	messageVariantTable,
	participantTable,
} from "../database/schema";
import { importSillyTavernChat } from "./import";
import {
	clearStagedImportRegistry,
	createChatImportModule,
	type ChatImportCommitInput,
	type ChatImportModule,
} from "./staged";
import { UNKNOWN_IMPORTED_AUTHOR_NAME } from "./import-projection";
import {
	StagedChatImportDuplicateConfirmationError,
	StagedChatImportExpiredError,
	StagedChatImportPlanError,
	StagedChatImportTokenMismatchError,
	StagedChatImportUnavailableError,
} from "./errors";
import {
	blankNameFixture as blankName,
	headerFixture as header,
	jsonl,
	rulershipFixture as rulership,
	writerFixture as writer,
} from "./fixtures";

// The staged commit behavioral matrix: the preview and the commit share the
// exact bound bytes, the user-confirmed resolution is validated through the
// public module seam, and the Chat, requested new Profiles, Participants,
// Roster membership, Author Stamps, Messages, Variants, canonical archive,
// report, and artifact metadata commit as one all-or-nothing operation
// through public domain seams.

const prompt = (): CharacterDefinition["prompt"] => ({
	systemInstruction: "System text.",
	identity: "Identity text.",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
});

const definition = (name: string, overrides: Partial<CharacterDefinition> = {}): CharacterDefinition => ({
	name,
	prompt: prompt(),
	openings: [],
	...overrides,
});

const sha256Of = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");

const chatOnly = (name: string, messagePositions: number[]): ChatImportCommitInput["participants"][number] => ({
	name,
	outcome: { type: "chat-only" },
	messagePositions,
});

describe("staged SillyTavern chat import commit", () => {
	let database: Database;
	let files: string[];
	let artifactDirectory: string;
	let module: ChatImportModule;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
		const directory = mkdtempSync(join(tmpdir(), "ditzytavern-commit-"));
		files = [directory];
		artifactDirectory = join(directory, "managed-artifacts");
		module = createChatImportModule(database, { artifactDirectory });
		clearStagedImportRegistry();
	});
	afterEach(() => {
		database.close();
		for (const path of files) rmSync(path, { recursive: true, force: true });
		clearStagedImportRegistry();
	});

	const stageBytes = (bytes: Buffer, filename = "lantern-house.jsonl") =>
		module.stageFile({
			// SAFETY: the copy into a fresh Uint8Array carries the exact bytes
			// while satisfying Blob's ArrayBuffer typing at the test boundary.
			bytes: new Blob([new Uint8Array(bytes)]).stream(),
			originalFilename: filename,
		});

	const stageText = async (records: unknown[], filename = "lantern-house.jsonl") => {
		const staged = await stageBytes(Buffer.from(jsonl(records), "utf8"), filename);
		return {
			...staged,
			records,
			filename,
			bytes: Buffer.from(jsonl(records), "utf8"),
		};
	};

	const committedArtifacts = () =>
		readdirSync(artifactDirectory)
			.filter((name) => name !== "staging")
			.sort();

	const stagingFiles = () =>
		readdirSync(join(artifactDirectory, "staging")).sort();

	const rowCounts = () => {
		const db = drizzle(database);
		return {
			chats: db.select().from(chatTable).all().length,
			participants: db.select().from(participantTable).all().length,
			characters: db.select().from(characterTable).all().length,
			messages: db.select().from(messageTable).all().length,
			variants: db.select().from(messageVariantTable).all().length,
			artifacts: db.select().from(artifactTable).all().length,
		};
	};

	const addCharacter = (overrides: Partial<CharacterDefinition> = {}) =>
		createCharacterLibraryModule(database).execute({
			type: "create",
			definition: definition(overrides.name ?? "Maren Voss", overrides),
		});

	const priorImport = (records: unknown[], filename = "prior.jsonl") => {
		const path = join(files[0] ?? "", filename);
		writeFileSync(path, jsonl(records), "utf8");
		return importSillyTavernChat(database, path, artifactDirectory).conversation;
	};

	const commit = (
		token: string,
		sha256: string,
		overrides: Partial<ChatImportCommitInput> = {},
	) =>
		module.commit(token, {
			sha256,
			title: "Lantern House",
			duplicateConfirmed: true,
			participants: [chatOnly("Writer", [1])],
			...overrides,
		});

	test("commits one ordinary Chat preserving every Message, Variant, Author Stamp, Roster, archive, report, and artifact", async () => {
		const staged = await stageText([header, writer, rulership, blankName]);
		const { token, preview } = staged;
		const result = commit(token, preview.sha256, {
			participants: [
				chatOnly("Writer", [1]),
				{
					name: "Rulership",
					outcome: { type: "chat-only" },
					messagePositions: [2],
				},
				{
					name: UNKNOWN_IMPORTED_AUTHOR_NAME,
					outcome: { type: "chat-only" },
					messagePositions: [3],
				},
			],
		});

		const { conversation, receipt } = result;
		// The receipt and the authoritative snapshot agree on what was created.
		expect(receipt.conversationId).toBe(conversation.id);
		expect(receipt.title).toBe("Lantern House");
		expect(receipt.counts).toEqual({ messages: 3, variants: 3 });
		expect(receipt.participants).toEqual([
			{ name: "Writer", outcome: "chat-only", sourceCharacterId: null },
			{ name: "Rulership", outcome: "chat-only", sourceCharacterId: null },
			{
				name: UNKNOWN_IMPORTED_AUTHOR_NAME,
				outcome: "chat-only",
				sourceCharacterId: null,
			},
		]);

		// Every resulting Participant is in the initial Roster and Cast.
		expect(conversation.cast.map((participant) => participant.name)).toEqual([
			"Writer",
			"Rulership",
			UNKNOWN_IMPORTED_AUTHOR_NAME,
		]);
		expect(conversation.cast.every((participant) => participant.id > 0)).toBe(true);

		// Native Author Stamps capture the resolved Participant identifier and
		// name; no historical Control pair is ever fabricated.
		expect(conversation.messages).toHaveLength(3);
		expect(
			conversation.messages.map((message) => ({
				participantId: message.author?.participantId,
				capturedName: message.author?.capturedName,
			})),
		).toEqual([
			{ participantId: conversation.cast[0]?.id, capturedName: "Writer" },
			{ participantId: conversation.cast[1]?.id, capturedName: "Rulership" },
			{
				participantId: conversation.cast[2]?.id,
				capturedName: UNKNOWN_IMPORTED_AUTHOR_NAME,
			},
		]);
		expect(
			conversation.messages.every((message) => message.historicalContext === null),
		).toBe(true);
		// The source-selected Swipe initialized the selected Variant.
		expect(
			conversation.messages.every(
				(message) => message.variants.filter((variant) => variant.selected).length === 1,
			),
		).toBe(true);

		// The canonical archive and the import report persist as Conversation
		// data, and the exact artifact metadata row committed with the Chat.
		const data = drizzle(database);
		const archive = data
			.select()
			.from(chatDataTable)
			.where(eq(chatDataTable.chat_id, conversation.id))
			.all()
			.find((entry) => entry.key === "source");
		expect(archive?.namespace).toBe("archive");
		expect(archive?.value).toContain('"name":"Writer"');

		const artifactRow = data
			.select()
			.from(artifactTable)
			.where(eq(artifactTable.chat_id, conversation.id))
			.all();
		expect(artifactRow).toHaveLength(1);
		expect(artifactRow[0]).toMatchObject({
			original_filename: "lantern-house.jsonl",
			byte_length: staged.bytes.length,
			sha256: preview.sha256,
		});

		// The exact staged bytes were moved into the managed artifact location
		// and the staging copy is gone.
		expect(committedArtifacts()).toHaveLength(1);
		const copied = readFileSync(
			join(artifactDirectory, artifactRow[0]?.relative_path ?? ""),
		);
		expect(copied).toEqual(staged.bytes);
		expect(sha256Of(copied)).toBe(preview.sha256);
		expect(stagingFiles()).toEqual([]);
	});

	test("commits only the exact staged bytes: changed, missing, or expired staging state is rejected", async () => {
		const staged = await stageText([header, writer]);
		const { token, preview } = staged;

		// A SHA-256 that does not match the binding rejects the commit.
		expect(() =>
			commit(token, sha256Of(Buffer.from("other")), {
				participants: [chatOnly("Writer", [1])],
			}),
		).toThrow(StagedChatImportTokenMismatchError);

		// Unknown tokens are expired.
		expect(() =>
			commit("never-staged", preview.sha256, {
				participants: [chatOnly("Writer", [1])],
			}),
		).toThrow(StagedChatImportExpiredError);

		// Altered staged bytes fail verification before any write.
		const stagedPath = join(artifactDirectory, "staging", stagingFiles()[0] ?? "");
		writeFileSync(stagedPath, Buffer.from("other bytes", "utf8"));
		expect(() => commit(token, preview.sha256)).toThrow(
			StagedChatImportUnavailableError,
		);
		expect(rowCounts()).toEqual({
			chats: 0,
			participants: 0,
			characters: 0,
			messages: 0,
			variants: 0,
			artifacts: 0,
		});

		rmSync(stagedPath);
		expect(() => commit(token, preview.sha256)).toThrow(
			StagedChatImportUnavailableError,
		);
	});

	test("forking an existing Character uses the Profile's current name and creates an independent Participant without a live link", async () => {
		const character = addCharacter({
			name: "Maren Voss",
			prompt: {
				...prompt(),
				identity: "A lighthouse keeper who reads the weather in birdsong.",
			},
		});
		const staged = await stageText([
			header,
			{ ...writer, name: "Maren", send_date: "2026-08-08T12:54:00.000Z" },
		]);
		const { conversation, receipt } = commit(staged.token, staged.preview.sha256, {
			participants: [
				{
					name: "Anything else is ignored",
					outcome: { type: "fork", characterId: character.id },
					messagePositions: [1],
				},
			],
		});

		// The Participant takes the Profile's current name and full copied
		// Definition with immutable provenance, but no live link.
		expect(conversation.cast).toHaveLength(1);
		const participant = conversation.cast[0];
		expect(participant?.name).toBe("Maren Voss");
		expect(participant?.sourceCharacterId).toBe(character.id);
		expect(participant?.prompt.identity).toBe(
			"A lighthouse keeper who reads the weather in birdsong.",
		);
		expect(conversation.messages[0]?.author).toEqual({
			participantId: participant?.id,
			capturedName: "Maren Voss",
			inCast: true,
		});
		expect(receipt.participants[0]).toEqual({
			name: "Maren Voss",
			outcome: "fork",
			sourceCharacterId: character.id,
		});
	});

	test("creating a new Character creates a minimal editable Profile and the Participant together, allowing duplicate names", async () => {
		// The library already holds a Profile with the requested name; the
		// import creates a second independent Profile without any suffix.
		addCharacter({ name: "Vesper" });
		const staged = await stageText([
			header,
			{ ...writer, name: "Vesper", send_date: "2026-08-08T12:54:00.000Z" },
			rulership,
		]);
		const { conversation, receipt } = commit(staged.token, staged.preview.sha256, {
			participants: [
				{
					name: "Vesper",
					outcome: { type: "new-character" },
					messagePositions: [1],
				},
				chatOnly("Rulership", [2]),
			],
		});

		const library = createCharacterLibraryModule(database);
		const profiles = library.list().filter((entry) => entry.name === "Vesper");
		expect(profiles).toHaveLength(2);

		const participant = conversation.cast.find(
			(entry) => entry.name === "Vesper",
		);
		// The new Profile is the Participant's immutable provenance source,
		// and the Participant carries the minimal editable empty Prompt.
		expect(participant?.sourceCharacterId).toBe(profiles[1]?.id);
		expect(participant?.prompt).toEqual({
			systemInstruction: "",
			identity: "",
			scenario: "",
			exampleDialogue: "",
			postHistoryInstruction: "",
		});
		expect(receipt.participants[0]).toEqual({
			name: "Vesper",
			outcome: "new-character",
			sourceCharacterId: profiles[1]?.id,
		});
		expect(conversation.messages[0]?.author?.capturedName).toBe("Vesper");
	});

	test("keeps Chat-only Participants as complete native identities without Profiles", async () => {
		const staged = await stageText([header, writer]);
		const { conversation, receipt } = commit(staged.token, staged.preview.sha256, {
			participants: [chatOnly("Writer", [1])],
		});

		expect(conversation.cast[0]).toMatchObject({
			name: "Writer",
			sourceCharacterId: null,
			position: 1,
		});
		expect(receipt.participants[0]).toEqual({
			name: "Writer",
			outcome: "chat-only",
			sourceCharacterId: null,
		});
		expect(rowCounts().characters).toBe(0);
	});

	test("merged and split plans commit with exact per-Message assignment while source author strings stay untouched", async () => {
		// One captured name used for two different identities: "Maren Voss"
		// and " Maren Voss " are separate exact groups, merged into one
		// Participant here; "Writer" stays chat-only.
		const staged = await stageText([
			header,
			{ ...writer, name: "Maren Voss", send_date: "2026-08-08T12:54:00.000Z" },
			{ ...writer, name: " Maren Voss ", send_date: "2026-08-08T12:55:00.000Z" },
			writer,
		]);
		const { conversation } = commit(staged.token, staged.preview.sha256, {
			participants: [
				chatOnly("Maren Voss", [1, 2]),
				chatOnly("Writer", [3]),
			],
		});

		expect(conversation.cast.map((entry) => entry.name)).toEqual([
			"Maren Voss",
			"Writer",
		]);
		expect(
			conversation.messages.map((message) => ({
				author: message.author?.capturedName,
				source: message.data.find((entry) => entry.key === "author.name")?.value,
			})),
		).toEqual([
			{ author: "Maren Voss", source: "Maren Voss" },
			{ author: "Maren Voss", source: " Maren Voss " },
			{ author: "Writer", source: "Writer" },
		]);

		// A split plan: the same captured name becomes two Participants, with
		// whole Messages (and their Variants) going to exactly one each.
		const split = await stageText([
			header,
			{ ...writer, name: "TANJS", send_date: "2026-08-08T12:54:00.000Z" },
			{ ...writer, name: "TANJS", send_date: "2026-08-08T12:55:00.000Z" },
		]);
		const splitResult = commit(split.token, split.preview.sha256, {
			title: "Split plan",
			participants: [
				chatOnly("Operator", [1]),
				chatOnly("Assistant", [2]),
			],
		});
		expect(splitResult.conversation.messages.map((message) => message.author?.capturedName)).toEqual([
			"Operator",
			"Assistant",
		]);
	});

	test("rejects plans that skip, duplicate, or mis-scope Messages and preserves the flow for recovery", async () => {
		const staged = await stageText([header, writer, rulership]);
		const { token, preview } = staged;

		// A Message is not assigned to any Participant.
		expect(() =>
			commit(token, preview.sha256, {
				title: "Missing",
				participants: [chatOnly("Writer", [1])],
			}),
		).toThrow(StagedChatImportPlanError);

		// Two Participants claim the same Message.
		expect(() =>
			commit(token, preview.sha256, {
				title: "Overlap",
				participants: [
					chatOnly("Writer", [1, 2]),
					chatOnly("Rulership", [2]),
				],
			}),
		).toThrow(StagedChatImportPlanError);

		// A Participant references a position outside the source.
		expect(() =>
			commit(token, preview.sha256, {
				title: "Out of range",
				participants: [
					chatOnly("Writer", [1]),
					chatOnly("Rulership", [2, 9]),
				],
			}),
		).toThrow(StagedChatImportPlanError);

		// A blank Participant name never commits.
		expect(() =>
			commit(token, preview.sha256, {
				title: "Blank name",
				participants: [
					chatOnly("Writer", [1]),
					{ name: "   ", outcome: { type: "chat-only" }, messagePositions: [2] },
				],
			}),
		).toThrow(StagedChatImportPlanError);

		// A fork referencing a vanished Profile is recoverable.
		expect(() =>
			commit(token, preview.sha256, {
				title: "Missing character",
				participants: [
					{
						name: "Ghost",
						outcome: { type: "fork", characterId: 9999 },
						messagePositions: [1],
					},
					chatOnly("Rulership", [2]),
				],
			}),
		).toThrow(StagedChatImportPlanError);

		// None of the rejected plans created any domain row.
		expect(rowCounts()).toEqual({
			chats: 0,
			participants: 0,
			characters: 0,
			messages: 0,
			variants: 0,
			artifacts: 0,
		});

		// The recoverable failure preserved the preview and the staged bytes:
		// the same handle still previews and commits after correction.
		expect(module.preview(token, preview.sha256)).toEqual(preview);
		const corrected = commit(token, preview.sha256, {
			title: "Corrected",
			participants: [chatOnly("Writer", [1, 2])],
		});
		expect(corrected.conversation.cast[0]?.name).toBe("Writer");
		expect(corrected.conversation.messages).toHaveLength(2);
	});

	test("blank captured groups require an explicitly usable Participant name", async () => {
		const staged = await stageText([header, blankName, writer]);
		const { token, preview } = staged;

		// A Participant named only with whitespace never commits.
		expect(() =>
			commit(token, preview.sha256, {
				title: "Blank group",
				participants: [chatOnly("Writer", [2])],
			}),
		).toThrow(StagedChatImportPlanError);

		// Supplying the usable default (or an edited name) commits.
		const result = commit(token, preview.sha256, {
			title: "Blank group",
			participants: [
				chatOnly("Writer", [2]),
				chatOnly(UNKNOWN_IMPORTED_AUTHOR_NAME, [1]),
			],
		});
		// Messages commit in source order: position 1 is the blank captured
		// name and position 2 is "Writer".
		expect(
			result.conversation.messages.map((message) => message.author?.capturedName),
		).toEqual([UNKNOWN_IMPORTED_AUTHOR_NAME, "Writer"]);
	});

	test("an exact duplicate requires explicit confirmation; related sources stay advisory", async () => {
		const prior = priorImport([header, writer]);
		const staged = await stageText([header, writer], "copy.jsonl");

		// The exact match blocks the commit until confirmed and creates no
		// database state.
		expect(() =>
			commit(staged.token, staged.preview.sha256, {
				title: "Copy",
				duplicateConfirmed: false,
				participants: [chatOnly("Writer", [1])],
			}),
		).toThrow(StagedChatImportDuplicateConfirmationError);
		expect(rowCounts().chats).toBe(1); // only the prior import

		// Confirming creates an independent native copy with its own identity
		// and a persisted copy warning in the receipt.
		const confirmed = commit(staged.token, staged.preview.sha256, {
			title: "Copy",
			duplicateConfirmed: true,
			participants: [chatOnly("Writer", [1])],
		});
		expect(confirmed.conversation.id).not.toBe(prior.id);
		expect(confirmed.receipt.duplicates.exact).toEqual([
			{ id: prior.id, name: prior.name },
		]);
		expect(confirmed.receipt.warnings).toContain(
			`Source was already imported as chat ${prior.id} ("${prior.name}"); this import creates an independent copy.`,
		);
	});

	test("a consumed token returns the original successful result on retry without creating another Chat", async () => {
		const staged = await stageText([header, writer]);
		const plan: ChatImportCommitInput = {
			sha256: staged.preview.sha256,
			title: "Once only",
			duplicateConfirmed: true,
			participants: [chatOnly("Writer", [1])],
		};

		const first = commit(staged.token, staged.preview.sha256, plan);
		// A lost response retries the same token and plan.
		const retry = commit(staged.token, staged.preview.sha256, plan);
		expect(retry.conversation.id).toBe(first.conversation.id);
		expect(retry.conversation.name).toBe(first.conversation.name);
		expect(retry.receipt).toEqual(first.receipt);
		expect(rowCounts()).toEqual({
			chats: 1,
			participants: 1,
			characters: 0,
			messages: 1,
			variants: 1,
			artifacts: 1,
		});
	});

	test("a failed domain creation leaves no Chat, Profile, Roster, Message, or Variant rows while the moved artifact may remain", async () => {
		const staged = await stageText([header, writer]);
		const { token, preview } = staged;

		// Simulate an in-transaction domain failure after the Profile branch
		// has written: the all-or-nothing operation must roll the new Profile
		// back together with the Chat, while the already moved filesystem
		// artifact may remain unused. The new-Character plan guarantees the
		// Profile branch runs inside the same transaction as the Chat; Bun's
		// nested transactions are savepoint-backed, so the inner Character
		// creation rolls back with the failed Conversation creation.
		addCharacter({ name: "Maren Voss" });
		const profilesBefore = createCharacterLibraryModule(database).list().length;
		database.exec("DROP TABLE participant");

		expect(() =>
			commit(token, preview.sha256, {
				title: "Fails mid-commit",
				participants: [
					{
						name: "Vesper",
						outcome: { type: "new-character" },
						messagePositions: [1],
					},
				],
			}),
		).toThrow();

		// The transaction rolled the Profile branch back: no new Profile row
		// exists and the pre-existing library is untouched. No Chat, Message,
		// Variant, or artifact metadata row exists either. Participant rows
		// cannot be counted because the table itself is gone.
		const db = drizzle(database);
		expect(db.select().from(chatTable).all()).toEqual([]);
		expect(db.select().from(characterTable).all()).toHaveLength(profilesBefore);
		expect(db.select().from(characterPromptTable).all()).toHaveLength(profilesBefore);
		expect(db.select().from(messageTable).all()).toEqual([]);
		expect(db.select().from(messageVariantTable).all()).toEqual([]);
		expect(db.select().from(artifactTable).all()).toEqual([]);
		// The rolled-back Profile is gone: no Character named "Vesper" exists
		// (queried by table so the dropped participant table cannot interfere).
		expect(
			db
				.select()
				.from(characterTable)
				.where(eq(characterTable.name, "Vesper"))
				.all(),
		).toEqual([]);
		expect(
			db
				.select()
				.from(characterTable)
				.where(eq(characterTable.name, "Maren Voss"))
				.all(),
		).toHaveLength(1);
		// The already moved exact artifact file is the accepted lifecycle
		// tradeoff: it remains on disk without any metadata row.
		expect(committedArtifacts()).toHaveLength(1);
		const orphaned = readFileSync(
			join(artifactDirectory, committedArtifacts()[0] ?? ""),
		);
		expect(orphaned).toEqual(staged.bytes);
		// The staging copy is gone, so the flow must reselect the file.
		expect(stagingFiles()).toEqual([]);
	});
});