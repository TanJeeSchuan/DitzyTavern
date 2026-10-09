import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { memoryCollectionTable, messageTable, messageVariantTable } from "../database/schema";
import { executeConversationCommand } from "../conversation";
import { executePromptPresetCommand } from "../prompt-preset";
import { configureMemoryEmbeddings, createChat, key } from "../contract/prompt-preset-test-fixtures";
import { sha256 } from "./hash";
import { claimMemoryIndexJob } from "./indexing";
import { isMemoryEnabledForConversation } from "./settings";

const claim = (messageId: number, text: string) => JSON.stringify([{
	claim: text,
	attribution: "Narrated event",
	people: [],
	evidence: [{ messageId, excerpt: text }],
	judgment: {
		support: "supported",
		attribution: "correct",
		usefulness: "retain",
		probabilities: {},
		confidence: { support: 1, attribution: 1, usefulness: 1 },
	},
}]);

// One complete collection waiting for its index, with the row's own timestamp
// so an older row is the one an unfiltered claim would reach first.
const seedIndexableCollection = (database: Database, conversationId: number, text: string, updatedAt: string): number => {
	const db = drizzle(database);
	const message = db.insert(messageTable)
		.values({ conversation_id: conversationId, position: 1, timestamp: updatedAt, author_name: "Writer" })
		.returning({ id: messageTable.id })
		.get();
	const variant = db.insert(messageVariantTable)
		.values({ message_id: message.id, position: 0, timestamp: updatedAt, content: text, selected: true })
		.returning({ id: messageVariantTable.id })
		.get();
	db.insert(memoryCollectionTable).values({
		variant_id: variant.id,
		conversation_id: conversationId,
		message_id: message.id,
		source_hash: sha256(text),
		revision: 1,
		status: "complete",
		source_snapshot_json: JSON.stringify({ source: { messageId: message.id, variantId: variant.id, speaker: "Writer", content: text }, context: [] }),
		claims_json: claim(message.id, text),
		updated_at: updatedAt,
	}).run();
	return variant.id;
};

describe("Memory index claiming", () => {
	let database: Database;
	beforeEach(() => {
		database = openObservedDatabase();
		initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
	});
	afterEach(() => database.close());

	test("claims a queued enabled job behind older candidates whose Conversations have no enabled Memory slot", () => {
		const bare = executePromptPresetCommand(database, { type: "create", name: "No Memory" });
		if (bare.kind !== "preset") throw new Error("Prompt Preset creation failed.");
		const disabledConversationIds: number[] = [];
		for (const [index, name] of ["Disabled A", "Disabled B", "Disabled C"].entries()) {
			const chat = createChat(database, { name });
			disabledConversationIds.push(chat.id);
			seedIndexableCollection(database, chat.id, `${name} source.`, `2026-10-01T00:00:0${index}.000Z`);
			executeConversationCommand(database, {
				conversationId: chat.id,
				expectedRevision: chat.revision,
				action: { type: "select-prompt-preset", promptPresetId: bare.preset.id },
			});
		}
		const enabled = createChat(database, { name: "Enabled" });
		const enabledVariantId = seedIndexableCollection(database, enabled.id, "Maren returned Writer's key.", "2026-10-02T00:00:00.000Z");
		configureMemoryEmbeddings(database, "http://embedding.test/v1/embeddings", "memory-v1");

		expect(isMemoryEnabledForConversation(database, enabled.id)).toBe(true);
		expect(disabledConversationIds.map((id) => isMemoryEnabledForConversation(database, id))).toEqual([false, false, false]);
		expect(claimMemoryIndexJob(database)?.variantId).toBe(enabledVariantId);
	});
});
