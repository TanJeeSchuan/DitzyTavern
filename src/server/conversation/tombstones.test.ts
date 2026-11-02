import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { emptyPromptChannels } from "../../shared/definition";
import { createCharacterLibraryModule } from "../character-library";
import {
	characterTable, characterPromptTable, characterDataTable, characterLorebookAttachmentTable,
	participantTable, participantPromptTable, participantOpeningTable, participantDataTable, participantLorebookAttachmentTable,
	conversationLorebookAttachmentTable, messageTable,
} from "../database/schema";
import { readLorebookAttachmentImpact } from "../lorebook/attachments";
import { importNativeLorebook } from "../lorebook/library";
import { applyCommand, createConversationWithHistory, openObservedDatabase } from "../test-fixtures/conversation";
import { deleteConversation } from "./delete";
import { forkConversation } from ".";

let database: Database;
beforeEach(() => { database = openObservedDatabase(); });
afterEach(() => database.close());

const definition = (name: string, openings: string[] = []) => ({ name, prompt: emptyPromptChannels(), openings });
const setup = () => {
	const library = createCharacterLibraryModule(database);
	const source = library.execute({ type: "create", definition: definition("Source", ["Opening"]) });
	const chat = createConversationWithHistory(database, {
		name: "Tombstone Chat",
		participants: [
			{ definition: definition("Writer") },
			{ definition: source, sourceCharacterId: source.id },
			{ definition: definition("Replacement") },
		],
		control: { human: 0, model: 1 },
	});
	return { library, source, chat, participantId: chat.cast[1]!.id };
};

test("Lorebook impact excludes tombstoned owners and retains live Character, Participant and Chat uses", () => {
	const { source, chat, participantId } = setup();
	const db = drizzle(database);
	const book = importNativeLorebook(database, { name: "World", description: "", entries: [] });
	const live = createCharacterLibraryModule(database).execute({ type: "create", definition: definition("Live") });
	db.insert(characterLorebookAttachmentTable).values([source.id, live.id].map((character_id) => ({ character_id, lorebook_id: book.id }))).run();
	db.insert(participantLorebookAttachmentTable).values([participantId, chat.cast[0]!.id].map((participant_id) => ({ participant_id, lorebook_id: book.id }))).run();
	db.insert(conversationLorebookAttachmentTable).values({ conversation_id: chat.id, lorebook_id: book.id }).run();
	// Old persisted tombstones may still have attachments; filtering must not depend on the new writer.
	db.update(characterTable).set({ deleted_at: "2026-11-02" }).where(eq(characterTable.id, source.id)).run();
	db.update(participantTable).set({ deleted_at: "2026-11-02", position: 0 }).where(eq(participantTable.id, participantId)).run();
	expect(readLorebookAttachmentImpact(database, book.id)?.attachments.map(({ owner, ownerId }) => [owner, ownerId])).toEqual([
		["character", live.id], ["participant", chat.cast[0]!.id], ["conversation", chat.id],
	]);
});

test("tombstoning strips live data and lore uses without erasing fork definitions or historical identity", () => {
	const { library, source, chat, participantId } = setup();
	const db = drizzle(database);
	const book = importNativeLorebook(database, { name: "World", description: "", entries: [] });
	db.insert(characterDataTable).values({ character_id: source.id, namespace: "test", key: "value", value: "1" }).run();
	db.insert(participantDataTable).values({ participant_id: participantId, namespace: "test", key: "value", value: "2" }).run();
	db.insert(characterLorebookAttachmentTable).values({ character_id: source.id, lorebook_id: book.id }).run();
	db.insert(participantLorebookAttachmentTable).values({ participant_id: participantId, lorebook_id: book.id }).run();
	const pinned = library.execute({ type: "set-pinned", characterId: source.id, expectedRevision: source.revision, pinned: true });
	library.execute({ type: "delete", characterId: source.id, expectedRevision: pinned.revision });
	expect(db.select().from(characterTable).where(eq(characterTable.id, source.id)).get()?.pinned).toBe(false);
	expect(db.select().from(characterDataTable).all()).toEqual([]);
	expect(db.select().from(characterLorebookAttachmentTable).all()).toEqual([]);
	expect(db.select().from(participantPromptTable).where(eq(participantPromptTable.participant_id, participantId)).get()).toBeDefined();
	expect(db.select().from(participantDataTable).all().map(({ value }) => value)).toEqual(["2"]);
	const unseated = applyCommand(database, { conversationId: chat.id, expectedRevision: chat.revision, action: { type: "assign-control", seat: "model", participantId: chat.cast[2]!.id } });
	const removed = applyCommand(database, { conversationId: chat.id, expectedRevision: unseated.revision, action: { type: "remove-participant", participantId } });
	expect(db.select().from(participantDataTable).all()).toEqual([]);
	expect(db.select().from(participantLorebookAttachmentTable).all()).toEqual([]);
	expect(db.select().from(participantOpeningTable).where(eq(participantOpeningTable.participant_id, participantId)).all()).toEqual([]);
	expect(removed.messages[0]?.author).toMatchObject({ participantId, capturedName: source.name, inCast: false });
	expect(db.select().from(participantTable).where(eq(participantTable.id, participantId)).get()?.source_character_id).toBe(source.id);
});

test("deleting Chats collects a source tombstone only after its last provenance reference is released", () => {
	const { library, source, chat } = setup();
	const second = createConversationWithHistory(database, {
		name: "Second reference", participants: [{ definition: definition("Writer") }, { definition: source, sourceCharacterId: source.id }], control: { human: 0, model: 1 },
	});
	library.execute({ type: "delete", characterId: source.id, expectedRevision: source.revision });
	const sourceRow = () => drizzle(database).select().from(characterTable).where(eq(characterTable.id, source.id)).get();
	deleteConversation(database, chat.id);
	expect(sourceRow()?.name).toBe(source.name);
	deleteConversation(database, second.id);
	expect(sourceRow()).toBeUndefined();
});

test("a live Character without its Prompt is rejected instead of fabricating an empty Definition", () => {
	const { library, source } = setup();
	drizzle(database).delete(characterPromptTable).where(eq(characterPromptTable.character_id, source.id)).run();
	expect(() => library.get(source.id)).toThrow("has no Prompt");
});

test("tombstone collection keeps a Participant that a Box value still names", () => {
	const chat = createConversationWithHistory(database, {
		name: "Source Chat",
		participants: [{ definition: definition("Writer") }, { definition: definition("Model", ["Earlier message"]) }, { definition: definition("Guest") }],
		control: { human: 0, model: 1 },
	});
	const guest = chat.cast[2]!.id;
	database.query("INSERT INTO conversation_data (conversation_id, namespace, key, value) VALUES (?, 'box:memory', 'labels', ?)")
		.run(chat.id, JSON.stringify({ identities: { [guest]: { kind: "plays", person: "Alice" } }, merges: [] }));
	const written = applyCommand(database, { conversationId: chat.id, expectedRevision: chat.revision, action: { type: "create-message", timestamp: "2026-11-02T00:00:00Z", variantContents: ["Guest speaks"], authorParticipantId: guest } });
	const removed = applyCommand(database, { conversationId: chat.id, expectedRevision: written.revision, action: { type: "remove-participant", participantId: guest } });
	// The fork copies the Guest tombstone for the labels, but none of the Messages that name it.
	const fork = forkConversation(database, { conversationId: chat.id, expectedRevision: removed.revision, at: { through: chat.messages[0]!.id }, name: "Fork", trimVariants: false }).conversation;
	const added = applyCommand(database, { conversationId: fork.id, expectedRevision: fork.revision, action: { type: "create-message", timestamp: "2026-11-02T00:01:00Z", variantContents: ["Aside"], authorParticipantId: fork.cast[0]!.id } });
	const aside = drizzle(database).select({ id: messageTable.id }).from(messageTable).where(eq(messageTable.conversation_id, fork.id)).orderBy(desc(messageTable.position)).limit(1).get()!;
	const deleted = applyCommand(database, { conversationId: fork.id, expectedRevision: added.revision, action: { type: "delete-message", messageId: aside.id } });

	expect(drizzle(database).select({ name: participantTable.name }).from(participantTable).where(eq(participantTable.conversation_id, fork.id)).all().map(({ name }) => name)).toContain("Guest");
	const first = drizzle(database).select({ id: messageTable.id }).from(messageTable).where(eq(messageTable.conversation_id, fork.id)).orderBy(messageTable.position).limit(1).get()!;
	const again = forkConversation(database, { conversationId: fork.id, expectedRevision: deleted.revision, at: { through: first.id }, name: "Fork again", trimVariants: false });
	expect(again.conversation.name).toBe("Fork again");
});
