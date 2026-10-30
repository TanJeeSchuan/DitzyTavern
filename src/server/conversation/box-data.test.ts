import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { characterDataTable, libraryDataTable, participantDataTable } from "../database/schema";
import { openInitializedDatabase } from "../database/database";
import { createCharacterLibraryModule } from "../character-library";
import { executeConversationCommand, InvalidConversationCommandError } from "../conversation";
import { createConversationWithHistory, insertBox } from "../test-fixtures/conversation";
import { boxStateEntry, readBoxSetups } from "../box/setup";
import { initialRaceSetup } from "../../boxes/race/shared-data";
import { raceSetup } from "../../boxes/race/contract";
import { boxSetupOf } from "../../shared/contract/box-value";

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
		expect(() => write({ box: "author-note", owner: { type: "participant", participantId: participantId! }, key: "stats", value: "{\"speed\":4}" })).toThrow("no declared participant value");

		expect(characterData()).toEqual([
			expect.objectContaining({ character_id: created.id, namespace: "box:race", key: "stats", value: "{\"speed\":1}" }),
		]);
		expect(storedParticipantData()).toEqual([
			{ participant_id: participantId!, namespace: "box:race", key: "stats", value: "{\"speed\":3}" },
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

	test("refuses data for a Box absent from the Chat and takes it for a disabled one, whose window stays open", () => {
		expect(() => write({ box: "phone", owner: { type: "library", revision: 0 }, key: "theme", value: "dark" })).toThrow(InvalidConversationCommandError);
		const off = boxStateEntry("race", false);
		database.query("UPDATE conversation_data SET value = ? WHERE conversation_id = ? AND namespace = ? AND key = ?").run(off.value, conversationId, off.namespace, off.key);
		write({ box: "race", owner: { type: "library", revision: 0 }, key: "avatar:Maren Voss", value: "lantern" });
		expect(drizzle(database).select().from(libraryDataTable).all()).toEqual([expect.objectContaining({ namespace: "box:race", value: "lantern" })]);
	});

	test("a setup save carries its scoped data writes, and a refused write keeps the setup and every other write out", () => {
		const character = createCharacterLibraryModule(database).execute({ type: "create", definition: definition("Maren Voss") });
		const participantId = participantIds[1]!;
		const runner = { name: "Maren Voss", participantId, style: "Pace Chaser", speed: 600, stamina: 600, power: 600, guts: 600, wit: 600 } as const;
		const save = (characterRevision: number) => executeConversationCommand(database, {
			conversationId,
			expectedRevision: revision,
			action: { type: "set-box-setup", box: "race", setup: { ...initialRaceSetup, slots: [runner] }, writes: [
				{ owner: { type: "participant", participantId }, key: "stats", value: "{\"speed\":600}" },
				{ owner: { type: "character", characterId: character.id, revision: characterRevision }, key: "stats", value: "{\"speed\":600}" },
			] },
		});

		expect(() => save(3)).toThrow(InvalidConversationCommandError);
		expect(participantData()).toEqual([]);
		expect(characterData()).toEqual([]);
		expect(boxSetupOf({ boxSetups: readBoxSetups(drizzle(database), conversationId) }, "race", raceSetup).slots).toEqual([]);

		save(0);
		expect(storedParticipantData()).toEqual([{ participant_id: participantId, namespace: "box:race", key: "stats", value: "{\"speed\":600}" }]);
		expect(characterData()).toEqual([expect.objectContaining({ character_id: character.id, value: "{\"speed\":600}", revision: 1 })]);
		expect(boxSetupOf({ boxSetups: readBoxSetups(drizzle(database), conversationId) }, "race", raceSetup).slots).toEqual([runner]);
	});

	test("copies Character data into a seeded Participant and later Character edits never reach it", () => {
		const library = createCharacterLibraryModule(database);
		const source = library.execute({
			type: "create",
			definition: definition("Special Week"),
		});
		revision = write({ box: "race", owner: { type: "character", characterId: source.id, revision: 0 }, key: "stats", value: "{\"speed\":800}" }).revision;
		revision = write({ box: "race", owner: { type: "character", characterId: source.id, revision: 0 }, key: "private", value: "secret" }).revision;
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
	test("generic data commands cannot address a Box namespace, loaded or not, at any scope", () => {
		const message = database.query<{ id: number }, [number]>("INSERT INTO messages (conversation_id, position, timestamp) VALUES (?, 0, '2026-01-01') RETURNING id").get(conversationId)!;
		const variant = database.query<{ id: number }, [number]>("INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 0, '', '2026-01-01', 1) RETURNING id").get(message.id)!;
		const row = (namespace: string) => ({
			conversation: database.query("SELECT key, value FROM conversation_data WHERE conversation_id = ? AND namespace = ? ORDER BY key").all(conversationId, namespace),
			message: database.query("SELECT key, value FROM messages_data WHERE message_id = ? AND namespace = ? ORDER BY key").all(message.id, namespace),
			variant: database.query("SELECT key, value FROM message_variant_data WHERE message_variant_id = ? AND namespace = ? ORDER BY key").all(variant.id, namespace),
		});
		const scopes = [
			{ type: "conversation" },
			{ type: "message", messageId: message.id },
			{ type: "variant", messageId: message.id, variantId: variant.id },
		] as const;
		for (const namespace of ["box:lantern", "box:race"]) {
			database.query("INSERT INTO conversation_data (conversation_id, namespace, key, value) VALUES (?, ?, 'instance', 'insertion-a') ON CONFLICT DO NOTHING").run(conversationId, namespace);
			database.query("INSERT INTO messages_data (message_id, namespace, key, value) VALUES (?, ?, 'moves', '[]') ON CONFLICT DO NOTHING").run(message.id, namespace);
			database.query("INSERT INTO message_variant_data (message_variant_id, namespace, key, value) VALUES (?, ?, 'record:insertion-a', '{}') ON CONFLICT DO NOTHING").run(variant.id, namespace);
			const before = row(namespace);
			for (const scope of scopes) {
				expect(() => executeConversationCommand(database, { conversationId, expectedRevision: revision, action: { type: "put-data", scope, namespace, key: "instance", value: "corrupted" } })).toThrow(InvalidConversationCommandError);
				expect(() => executeConversationCommand(database, { conversationId, expectedRevision: revision, action: { type: "delete-data", scope, namespace, key: "instance" } })).toThrow(InvalidConversationCommandError);
			}
			expect(row(namespace)).toEqual(before);
		}
	});
});
