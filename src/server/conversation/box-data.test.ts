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
import type { BoxDataExpectation, BoxDataWrite } from "../../shared/contract/box-actions";

const prompt = () => ({
	systemInstruction: "",
	identity: "Lighthouse archivist on the northern coast.",
	appearance: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
});

const definition = (name: string) => ({ name, prompt: prompt(), sendAppearanceImages: true, openings: [] });
const stats = (speed: number) => JSON.stringify({ style: "Pace Chaser", speed, stamina: 600, power: 600, guts: 600, wit: 600 });
type Commit = { box: "race" | "author-note" | "phone"; setup?: typeof initialRaceSetup; writes?: BoxDataWrite[]; expected?: BoxDataExpectation[] };

describe("commit-box and the Character seed copy", () => {
	let database: Database;
	let conversationId: number;
	let revision: number;
	let participantIds: readonly number[];
	let characterId: number;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		characterId = createCharacterLibraryModule(database).execute({ type: "create", definition: definition("Maren Voss") }).id;
		const conversation = createConversationWithHistory(database, {
			name: "Box data",
			participants: [{ definition: definition("Writer") }, { definition: definition("Maren Voss"), sourceCharacterId: characterId }],
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

	const commit = (action: Commit, chat = conversationId, expectedRevision = revision) =>
		executeConversationCommand(database, { conversationId: chat, expectedRevision, action: { type: "commit-box", ...action } });
	const write = (action: Commit) => { revision = commit(action).revision; };
	const library = { type: "library" } as const;
	const character = () => ({ type: "character", characterId } as const);

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
		const [participantId] = participantIds;
		write({ box: "race", writes: [{ owner: library, key: "avatar:Special Week", value: "abc" }], expected: [{ owner: library, key: "avatar:Special Week", revision: 0 }] });
		write({ box: "race", writes: [{ owner: character(), key: "stats", value: stats(1) }], expected: [{ owner: character(), key: "stats", revision: 0 }] });
		write({ box: "race", writes: [{ owner: { type: "participant", participantId: participantId! }, key: "stats", value: stats(2) }] });
		write({ box: "race", writes: [{ owner: { type: "participant", participantId: participantId! }, key: "stats", value: stats(3) }] });
		expect(() => commit({ box: "author-note", writes: [{ owner: { type: "participant", participantId: participantId! }, key: "stats", value: stats(4) }] })).toThrow();

		expect(characterData()).toEqual([expect.objectContaining({ character_id: characterId, namespace: "box:race", key: "stats", value: stats(1) })]);
		expect(storedParticipantData()).toEqual([{ participant_id: participantId!, namespace: "box:race", key: "stats", value: stats(3) }]);
	});

	test("refuses a Participant value its declared schema rejects", () => {
		expect(() => commit({ box: "race", writes: [{ owner: { type: "participant", participantId: participantIds[0]! }, key: "stats", value: "{\"speed\":1}" }] }))
			.toThrow("The race Box's stats value does not match its schema.");
		expect(participantData()).toEqual([]);
	});

	test("refuses a Participant of another Chat, and a Character that is gone or seeds no one in this Cast", () => {
		const other = createConversationWithHistory(database, { name: "Other", participants: [{ definition: definition("Elsewhere") }] });
		const stranger = createCharacterLibraryModule(database).execute({ type: "create", definition: definition("Stranger") });
		expect(() => commit({ box: "race", writes: [{ owner: { type: "participant", participantId: other.cast[0]!.id }, key: "stats", value: stats(1) }] })).toThrow(InvalidConversationCommandError);
		for (const id of [999, stranger.id]) {
			const owner = { type: "character", characterId: id } as const;
			expect(() => commit({ box: "race", writes: [{ owner, key: "stats", value: "{}" }], expected: [{ owner, key: "stats", revision: 0 }] })).toThrow("is not the source of anyone in this Chat's Cast.");
		}
		expect(characterData()).toEqual([]);
	});

	test("a Library or Character write needs the revision it read, and a stale one from another Chat is refused", () => {
		const other = createConversationWithHistory(database, { name: "Other", participants: [{ definition: definition("Maren Voss"), sourceCharacterId: characterId }] });
		insertBox(database, other.id, "race");
		const elsewhere = (action: Commit) => commit(action, other.id, other.revision);
		const avatar = { owner: library, key: "avatar:Special Week" } as const;
		const sheet = { owner: character(), key: "stats" } as const;

		expect(() => commit({ box: "race", writes: [{ ...avatar, value: "unguarded" }] })).toThrow("A library write needs the revision it was read at in expected.");
		write({ box: "race", writes: [{ ...avatar, value: "first" }], expected: [{ ...avatar, revision: 0 }] });
		write({ box: "race", writes: [{ ...sheet, value: stats(1) }], expected: [{ ...sheet, revision: 0 }] });
		expect(() => elsewhere({ box: "race", writes: [{ ...avatar, value: "stale" }], expected: [{ ...avatar, revision: 0 }] })).toThrow(InvalidConversationCommandError);
		expect(() => elsewhere({ box: "race", writes: [{ ...sheet, value: stats(2) }], expected: [{ ...sheet, revision: 0 }] })).toThrow(InvalidConversationCommandError);
		expect(characterData()).toEqual([expect.objectContaining({ value: stats(1), revision: 1 })]);

		elsewhere({ box: "race", writes: [{ ...avatar, value: "current" }], expected: [{ ...avatar, revision: 1 }] });
		expect(drizzle(database).select().from(libraryDataTable).all()).toEqual([expect.objectContaining({ value: "current", revision: 2 })]);
	});

	test("refuses data for a Box absent from the Chat and takes it for a disabled one, whose window stays open", () => {
		const avatar = { owner: library, key: "avatar:Maren Voss" } as const;
		expect(() => commit({ box: "phone", writes: [{ ...avatar, value: "dark" }], expected: [{ ...avatar, revision: 0 }] })).toThrow(InvalidConversationCommandError);
		const off = boxStateEntry("race", false);
		database.query("UPDATE conversation_data SET value = ? WHERE conversation_id = ? AND namespace = ? AND key = ?").run(off.value, conversationId, off.namespace, off.key);
		write({ box: "race", writes: [{ ...avatar, value: "lantern" }], expected: [{ ...avatar, revision: 0 }] });
		expect(drizzle(database).select().from(libraryDataTable).all()).toEqual([expect.objectContaining({ namespace: "box:race", value: "lantern" })]);
	});

	test("a setup commit carries its scoped data writes, and a refused write keeps the setup and every other write out", () => {
		const participantId = participantIds[1]!;
		const runner = { name: "Maren Voss", participantId, style: "Pace Chaser", speed: 600, stamina: 600, power: 600, guts: 600, wit: 600 } as const;
		const save = (characterRevision: number) => commit({
			box: "race", setup: { ...initialRaceSetup, slots: [runner] },
			writes: [{ owner: { type: "participant", participantId }, key: "stats", value: stats(600) }, { owner: character(), key: "stats", value: stats(600) }],
			expected: [{ owner: character(), key: "stats", revision: characterRevision }],
		});
		/** @approved SAFETY: the host checked each stored setup against the Race's setup schema. */
		const slots = () => (readBoxSetups(drizzle(database), conversationId).race as typeof initialRaceSetup).slots;

		expect(() => save(3)).toThrow(InvalidConversationCommandError);
		expect(participantData()).toEqual([]);
		expect(characterData()).toEqual([]);
		expect(slots()).toEqual([]);

		save(0);
		expect(storedParticipantData()).toEqual([{ participant_id: participantId, namespace: "box:race", key: "stats", value: stats(600) }]);
		expect(characterData()).toEqual([expect.objectContaining({ character_id: characterId, value: stats(600), revision: 1 })]);
		expect(slots()).toEqual([runner]);
	});

	test("copies Character data into a seeded Participant and later Character edits never reach it", () => {
		const sheet = (key: string, value: string, revisionRead: number) =>
			write({ box: "race", writes: [{ owner: character(), key, value }], expected: [{ owner: character(), key, revision: revisionRead }] });
		sheet("stats", stats(800), 0);
		sheet("private", "secret", 0);
		const seeded = createConversationWithHistory(database, {
			name: "Seeded Chat",
			participants: [
				{ definition: definition("Writer") },
				{ definition: definition("Maren Voss"), sourceCharacterId: characterId },
			],
		});
		const participantId = seeded.cast[1]!.id;

		expect(storedParticipantData()).toEqual([
			{ participant_id: participantId, namespace: "box:race", key: "stats", value: stats(800) },
		]);

		sheet("stats", stats(12), 1);
		expect(storedParticipantData().find(({ participant_id }) => participant_id === participantId)?.value).toBe(stats(800));
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
