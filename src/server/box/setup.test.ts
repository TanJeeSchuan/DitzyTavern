import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConversationWithHistory, insertBox } from "../test-fixtures/conversation";
import { readBoxStates } from "./setup";

const definition = (name: string) => ({
	name,
	prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" },
	openings: [],
});

describe("readBoxStates", () => {
	let database: Database;
	let conversationId: number;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		conversationId = createConversationWithHistory(database, {
			name: "Box states",
			participants: [{ definition: definition("Writer") }],
		}).id;
		insertBox(database, conversationId, "race");
	});

	afterEach(() => {
		database.close();
	});

	test.each(["enabled", "instance"])("rejects a lifecycle missing its %s row", (key) => {
		database.query("DELETE FROM conversation_data WHERE conversation_id = ? AND namespace = ? AND key = ?").run(conversationId, "box:race", key);
		expect(() => readBoxStates(drizzle(database), conversationId)).toThrow(`Stored Box lifecycle at Chat ${conversationId} box:race needs both enabled and instance.`);
	});

	test("rejects a stored enablement that is not a boolean", () => {
		database.query("UPDATE conversation_data SET value = ? WHERE conversation_id = ? AND namespace = ? AND key = ?")
			.run(JSON.stringify("true"), conversationId, "box:race", "enabled");
		expect(() => readBoxStates(drizzle(database), conversationId)).toThrow("box:race enabled does not match its schema.");
	});
});
