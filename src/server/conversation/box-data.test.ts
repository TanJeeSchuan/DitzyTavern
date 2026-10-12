import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { characterDataTable, libraryDataTable, participantDataTable } from "../database/schema";
import { openInitializedDatabase } from "../database/database";
import { createCharacterLibraryModule } from "../character-library";
import { executeConversationCommand, InvalidConversationCommandError } from "../conversation";
import { createConversationWithHistory, insertBox } from "../test-fixtures/conversation";

const prompt = () => ({
	systemInstruction: "",
	identity: "Lighthouse archivist on the northern coast.",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
});

const definition = (name: string) => ({ name, prompt: prompt(), openings: [] });

interface BoxDataWrite {
	box: "race" | "author-note" | "phone";
	owner:
		| { type: "library"; revision: number }
		| { type: "character"; characterId: number; revision: number }
		| { type: "participant"; participantId: number };
	key: string;
	value: string;
}

describe("put-box-data and the Character seed copy", () => {
	let database: Database;
	let conversationId: number;
	let revision: number;
	let participantIds: readonly number[];

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		const conversation = createConversationWithHistory(database, {
			name: "Box data",
			participants: [{ definition: definition("Writer") }, { definition: definition("Maren Voss") }],
			control: { human: 0, model: 1 },
		});
		conversationId = conversation.id;
		revision = conversation.revision;
		participantIds = conversation.cast.map(({ id }) => id);
		insertBox(database, conversationId, "race");
	});

	afterEach(() => {
		database.close();
	});

	const write = (action: BoxDataWrite) =>
		executeConversationCommand(database, {
			conversationId,
			expectedRevision: revision,
			action: { type: "put-box-data", ...action },
		});

	const storedParticipantData = () =>
		participantData().map(({ participant_id, namespace, key, value }) => ({
			participant_id,
			namespace,
			key,
			value,
		}));

	const characterData = () => drizzle(database).select().from(characterDataTable).all();
	const participantData = () => drizzle(database).select().from(participantDataTable).all();

	test("writes each scope under the Box's own namespace and updates in place", () => {
		const created = createCharacterLibraryModule(database).execute({
			type: "create",
			definition: definition("Maren Voss"),
		});
		const [participantId] = participantIds;

		revision = write({ box: "race", owner: { type: "library", revision: 0 }, key: "avatar:Special Week", value: "abc" }).revision;
		revision = write({ box: "race", owner: { type: "character", characterId: created.id, revision: 0 }, key: "stats", value: "{\"speed\":1}" }).revision;
		revision = write({ box: "race", owner: { type: "participant", participantId: participantId! }, key: "stats", value: "{\"speed\":2}" }).revision;
		revision = write({ box: "race", owner: { type: "participant", participantId: participantId! }, key: "stats", value: "{\"speed\":3}" }).revision;
		write({ box: "author-note", owner: { type: "participant", participantId: participantId! }, key: "stats", value: "{\"speed\":4}" });

		expect(characterData()).toEqual([
			expect.objectContaining({ character_id: created.id, namespace: "box:race", key: "stats", value: "{\"speed\":1}" }),
		]);
		expect(storedParticipantData()).toEqual([
			{ participant_id: participantId!, namespace: "box:race", key: "stats", value: "{\"speed\":3}" },
			{ participant_id: participantId!, namespace: "box:author-note", key: "stats", value: "{\"speed\":4}" },
		]);
	});

	test("refuses an owner that is not a live Character or a Cast Participant", () => {
		const other = createConversationWithHistory(database, {
			name: "Other",
			participants: [{ definition: definition("Elsewhere") }],
		});
		expect(() =>
			write({ box: "race", owner: { type: "participant", participantId: other.cast[0]!.id }, key: "stats", value: "{}" }),
		).toThrow(InvalidConversationCommandError);
		expect(() =>
			write({ box: "race", owner: { type: "character", characterId: 999, revision: 0 }, key: "stats", value: "{}" }),
		).toThrow(InvalidConversationCommandError);
	});

	test("refuses a shared write made from a stale read in another Chat", () => {
		const character = createCharacterLibraryModule(database).execute({ type: "create", definition: definition("Maren Voss") });
		const other = createConversationWithHistory(database, { name: "Other", participants: [{ definition: definition("Elsewhere") }] });
		insertBox(database, other.id, "race");
		const writeElsewhere = (action: BoxDataWrite) =>
			executeConversationCommand(database, { conversationId: other.id, expectedRevision: other.revision, action: { type: "put-box-data", ...action } });
		const library = { box: "race", key: "avatar:Special Week" } as const;
		const stats = { box: "race", owner: { type: "character", characterId: character.id }, key: "stats" } as const;

		revision = write({ ...library, owner: { type: "library", revision: 0 }, value: "first" }).revision;
		revision = write({ ...stats, owner: { ...stats.owner, revision: 0 }, value: "first" }).revision;
		expect(() => writeElsewhere({ ...library, owner: { type: "library", revision: 0 }, value: "stale" })).toThrow(InvalidConversationCommandError);
		expect(() => writeElsewhere({ ...stats, owner: { ...stats.owner, revision: 0 }, value: "stale" })).toThrow(InvalidConversationCommandError);
		expect(characterData()).toEqual([expect.objectContaining({ value: "first", revision: 1 })]);

		writeElsewhere({ ...library, owner: { type: "library", revision: 1 }, value: "current" });
		expect(drizzle(database).select().from(libraryDataTable).all()).toEqual([expect.objectContaining({ value: "current", revision: 2 })]);
	});

	test("refuses data for a Box that is not enabled in the Chat", () => {
		expect(() => write({ box: "phone", owner: { type: "library", revision: 0 }, key: "theme", value: "dark" })).toThrow(InvalidConversationCommandError);
	});

	test("copies Character data into a seeded Participant and later Character edits never reach it", () => {
		const library = createCharacterLibraryModule(database);
		const source = library.execute({
			type: "create",
			definition: definition("Special Week"),
		});
		revision = write({ box: "race", owner: { type: "character", characterId: source.id, revision: 0 }, key: "stats", value: "{\"speed\":800}" }).revision;
		const seeded = createConversationWithHistory(database, {
			name: "Seeded Chat",
			participants: [
				{ definition: definition("Writer") },
				{ definition: definition("Special Week"), sourceCharacterId: source.id },
			],
		});
		const participantId = seeded.cast[1]!.id;

		expect(storedParticipantData()).toEqual([
			{ participant_id: participantId, namespace: "box:race", key: "stats", value: "{\"speed\":800}" },
		]);

		revision = write({ box: "race", owner: { type: "character", characterId: source.id, revision: 1 }, key: "stats", value: "{\"speed\":12}" }).revision;
		expect(storedParticipantData().find(({ participant_id }) => participant_id === participantId)?.value).toBe("{\"speed\":800}");
	});
});
