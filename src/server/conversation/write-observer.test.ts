import { readTestConversationSnapshot, createConversationWithHistory } from "../test-fixtures/conversation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { ConversationWriteObserverMissingError, deleteConversation, observeConversationWrites } from ".";
import type { ConversationMemoryChange } from "../../shared/contract/conversation-memory-change";

const prompt = {
	systemInstruction: "Answer briefly.",
	identity: "I am {{self}}.",
	scenario: "The room is quiet.",
	exampleDialogue: "",
	postHistoryInstruction: "Continue.",
};

// The composition contract of the Conversation write seam: a composition
// owning a database registers its consumer with observeConversationWrites
// before any write reports a change, and a write that reports with no
// registered consumer throws loudly instead of silently dropping the report.
describe("Conversation write observer composition contract", () => {
	let database: Database;
	let second: Database;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		second = openInitializedDatabase({ path: ":memory:" });
	});

	afterEach(() => {
		database.close();
		second.close();
	});

	const createChatWithVariant = (db: Database) => {
		const module = db;
		const created = createConversationWithHistory(module, {
			name: "Observer Chat",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: ["Original answer."] } },
			],
			control: { human: 0, model: 1 },
		});
		const snapshot = readTestConversationSnapshot(module, created.id);
		const variantId = snapshot?.messages[0]?.variants[0]?.id;
		if (variantId === undefined) throw new Error("Opening Variant missing.");
		return { id: created.id, variantId };
	};

	test("a write reporting a change without a registered observer throws the named composition error", () => {
		const chat = createChatWithVariant(database);
		expect(() => deleteConversation(database, chat.id)).toThrow(
			ConversationWriteObserverMissingError,
		);
		const after = readTestConversationSnapshot(database, chat.id);
		// The throwing delivery rolls the write back; the Chat still exists.
		expect(after).not.toBeUndefined();
		expect(after?.messages).toHaveLength(1);
	});

	test("the registered observer for this database receives the report of its own transaction", () => {
		const chat = createChatWithVariant(database);
		const delivered: { database: Database; change: ConversationMemoryChange }[] = [];
		observeConversationWrites(database, (observedDatabase, change) => {
			delivered.push({ database: observedDatabase, change });
		});

		deleteConversation(database, chat.id);

		const report = delivered[0];
		if (report === undefined) throw new Error("No report delivered.");
		expect(delivered).toHaveLength(1);
		expect(report.database).toBe(database);
		expect(report.change.conversationId).toBe(chat.id);
		expect([...report.change.removedVariantIds]).toEqual([chat.variantId]);
		expect(readTestConversationSnapshot(database, chat.id)).toBeUndefined();
	});

	test("compositions observe exactly their own database", () => {
		const deliveredForFirst: number[] = [];
		const deliveredForSecond: number[] = [];
		observeConversationWrites(database, (_observedDatabase, change) => {
			deliveredForFirst.push(change.conversationId);
		});
		observeConversationWrites(second, (_observedDatabase, change) => {
			deliveredForSecond.push(change.conversationId);
		});

		const firstChat = createChatWithVariant(database).id;
		const secondChat = createChatWithVariant(second).id;
		deleteConversation(database, firstChat);
		deleteConversation(second, secondChat);

		expect(deliveredForFirst).toEqual([firstChat]);
		expect(deliveredForSecond).toEqual([secondChat]);
	});
});
