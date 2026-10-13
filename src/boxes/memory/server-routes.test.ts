import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import { openInitializedDatabase } from "../../server/database/database";
import { messageTable, messageVariantTable } from "../../server/database/schema";
import { createChat } from "../../server/contract/prompt-preset-test-fixtures";
import { memoryRoutes } from "./server-routes";
import { memorySources } from "./contract";

let database: Database;
beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
afterEach(() => database.close());

const passage = (conversationId: number, position: number) => {
	const db = drizzle(database);
	const message = db.insert(messageTable).values({ conversation_id: conversationId, position, timestamp: "2026-10-13T00:00:00Z" }).returning().get();
	const variant = db.insert(messageVariantTable).values({ message_id: message.id, position: 0, timestamp: message.timestamp, content: "Maren kept the key.", selected: true }).returning().get();
	return { messageId: message.id, variantId: variant.id };
};

test("a trace's view links only to the Messages and Variants still in its Chat", async () => {
	const chat = createChat(database);
	const kept = passage(chat.id, 1);
	const edited = passage(chat.id, 2);
	const foreign = passage(createChat(database).id, 1);
	database.run("DELETE FROM message_variant WHERE id = ?", [edited.variantId]);
	const ids = (...values: number[]) => values.join(",");
	const response = await memoryRoutes(database).handle(new Request(`http://localhost/conversations/${chat.id}/memories/sources?messageIds=${ids(kept.messageId, edited.messageId, foreign.messageId)}&variantIds=${ids(kept.variantId, edited.variantId, foreign.variantId)}`));
	const sources = Value.Parse(memorySources, await response.json());
	expect({ messageIds: sources.messageIds.toSorted(), variantIds: sources.variantIds }).toEqual({ messageIds: [kept.messageId, edited.messageId].toSorted(), variantIds: [kept.variantId] });
	const none = await memoryRoutes(database).handle(new Request(`http://localhost/conversations/${chat.id}/memories/sources?messageIds=&variantIds=`));
	expect(await none.json()).toEqual({ messageIds: [], variantIds: [] });
});
