import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import { openInitializedDatabase } from "../../server/database/database";
import { messageTable, messageVariantTable } from "../../server/database/schema";
import { createChat } from "../../server/contract/prompt-preset-test-fixtures";
import { memoryRoutes } from "./server-routes";
import { mergeMemoryLabels, readConversationMemories } from "./server-memories";
import { sha256 } from "../../server/hash";
import { writeAutomaticRecord } from "../../server/box/records";
import { readBoxInstances } from "../../server/box/setup";
import { conversationMemories, memoryLabelsConflict, memoryLabelsMerged, type MemoryCandidateJudgment, type MemoryIdentity } from "./contract";

const claim = (messageId: number, people: string[]): MemoryCandidateJudgment => ({ claim: "Maren promised a key.", attribution: "Narrated event", people, evidence: [{ messageId, excerpt: "I promised a key." }], judgment: { support: "supported", attribution: "correct", usefulness: "retain", probabilities: {}, confidence: {} } });
const source = (database: Database, conversationId: number, position: number, author: { id: number; name: string }, people?: string[], selected = true) => {
	const db = drizzle(database);
	const message = db.insert(messageTable).values({ conversation_id: conversationId, position, timestamp: "2026-10-07T00:00:00Z", author_participant_id: author.id, author_name: author.name }).returning().get();
	const variant = db.insert(messageVariantTable).values({ message_id: message.id, position: 0, timestamp: message.timestamp, content: "I promised a key.", selected }).returning().get();
	if (people) writeAutomaticRecord(db, "memory", readBoxInstances(db, conversationId).memory!, variant.id, { claims: [claim(message.id, people)] }, sha256(variant.content));
	return { messageId: message.id, variantId: variant.id };
};
const save = (database: Database, conversationId: number, participantId: number, identity: MemoryIdentity, expectedRevision = readConversationMemories(database, conversationId).labelRevision) => memoryRoutes(database).handle(new Request(`http://localhost/conversations/${conversationId}/memories/identity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ participantId, identity, expectedRevision }) }));

describe("Cast Memory identities", () => {
	let database: Database;
	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("exposes current and captured Memory names in first-seen order for each participant", async () => {
		const chat = createChat(database);
		const writer = chat.cast[0]!;
		source(database, chat.id, 4, writer);
		source(database, chat.id, 1, { ...writer, name: "Guide" });
		source(database, chat.id, 2, writer);
		database.run("UPDATE participant SET name = 'Director' WHERE id = ?", [writer.id]);
		source(database, chat.id, 3, { ...writer, name: "Director" });
		const unknown = source(database, chat.id, 5, writer);
		database.run("UPDATE messages SET author_name = NULL WHERE id = ?", [unknown.messageId]);
		const response = await memoryRoutes(database).handle(new Request(`http://localhost/conversations/${chat.id}/memories`));
		expect(response.status).toBe(200);
		expect(Value.Parse(conversationMemories, await response.json()).cast).toEqual([{ id: writer.id, names: ["Director", "Guide", "Writer"] }, { id: chat.cast[1]!.id, names: ["Maren"] }]);
	});

	test("an author who is not in the story leaves the read, Swipes included, and returns with every claim intact", async () => {
		const chat = createChat(database);
		const writer = chat.cast[0]!;
		const maren = chat.cast[1]!;
		source(database, chat.id, 1, writer, ["Writer"]);
		source(database, chat.id, 2, writer, ["Writer"], false);
		const story = source(database, chat.id, 3, maren, ["Writer", "Maren"]);
		const before = readConversationMemories(database, chat.id).sources;
		const response = await save(database, chat.id, writer.id, { kind: "excluded" });
		const { memories } = Value.Parse(memoryLabelsMerged, await response.json());
		expect(memories.identities).toEqual({ [writer.id]: { kind: "excluded" } });
		expect(memories.sources).toEqual([before.find((entry) => entry.variantId === story.variantId)!]);
		expect((await save(database, chat.id, writer.id, { kind: "themselves" })).status).toBe(200);
		expect(readConversationMemories(database, chat.id).sources).toEqual(before);
	});

	test("identities and label merges share conflicts and reject invalid names and foreign participants atomically", async () => {
		const chat = createChat(database);
		const writer = chat.cast[0]!;
		source(database, chat.id, 1, writer, ["Writer", "Maren"]);
		mergeMemoryLabels(database, chat.id, { expectedRevision: 0, labels: ["Maren"], destination: "Mary" });
		const before = readConversationMemories(database, chat.id);
		const conflict = await save(database, chat.id, writer.id, { kind: "excluded" }, 0);
		expect(conflict.status).toBe(409);
		expect(Value.Parse(memoryLabelsConflict, await conflict.json()).memories).toEqual(before);
		expect((await save(database, chat.id, writer.id, { kind: "plays", person: "   " })).status).toBe(422);
		const other = createChat(database);
		expect((await save(database, chat.id, other.cast[0]!.id, { kind: "excluded" })).status).toBe(422);
		expect(readConversationMemories(database, chat.id)).toEqual(before);
		expect((await save(database, chat.id, writer.id, { kind: "excluded" })).status).toBe(200);
		expect(() => mergeMemoryLabels(database, chat.id, { expectedRevision: 1, labels: ["Mary"], destination: "Maren" })).toThrow();
	});
});
