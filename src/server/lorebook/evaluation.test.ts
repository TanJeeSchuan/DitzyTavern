import { createConversationWithHistory, openObservedDatabase } from "../test-fixtures/conversation";
import { executeConversationCommand } from "../conversation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createCharacter } from "../character-library/create";
import { importNativeLorebook } from "./library";
import { attachLorebookToCharacter, readLorebookAttachmentEligibility } from "./attachments";
import { evaluateScopedLore } from "./evaluation";

const prompt = {
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
};

describe("scoped Lore activation", () => {
	let database: Database;
	beforeEach(() => { database = openObservedDatabase(); });
	afterEach(() => database.close());

	test("inherits Character uses, resolves scope before deduplication, and scans pending text", () => {
		const character = createCharacter(database, { name: "Keeper", prompt, openings: [] });
		const book = importNativeLorebook(database, {
			name: "World",
			description: "",
			entries: [{
				title: "Keep",
				content: "The silver keep.",
				keywords: ["Silver Keep"],
				semanticTriggers: [],
				matchOperator: "or",
				always: false,
				requireAny: [], requireAll: [], excludeAny: [], excludeAll: [],
				caseSensitive: false, wholeWord: true, keywordMode: "literal", regexFlags: "",
				priority: 1, enabled: true,
			}],
		});
		attachLorebookToCharacter(database, { characterId: character.id, bookId: book.id, scope: "controlled-participant" });
		const chat = createConversationWithHistory(database, {
			name: "Story",
			participants: [
				{ sourceCharacterId: character.id, definition: { name: "Keeper", prompt, openings: [] } },
				{ definition: { name: "Writer", prompt, openings: [] } },
			],
			control: { human: 1, model: 0 },
		});
		executeConversationCommand(database, {
			conversationId: chat.id,
			expectedRevision: chat.revision,
			action: { type: "attach-chat", bookId: book.id },
		});
		const uses = readLorebookAttachmentEligibility(database, chat.id);
		expect(uses.filter((use) => use.eligible)).toHaveLength(2);
		const result = evaluateScopedLore({ database, conversationId: chat.id, messages: [], pendingHumanText: "Silver Keep" });
		expect(result.candidates).toHaveLength(1);
		expect(result.activation.mode).toBe("semantic");
		expect(result.activation.evidence).toHaveLength(2);
		const evidence = result.activation.evidence;
		if (!Array.isArray(evidence)) throw new Error("Lore activation evidence is not an array.");
		expect(evidence[0]).toMatchObject({
			books: [{
				bookId: book.id,
				selectedAttachmentId: uses[0]?.id,
				deduplicatedAttachmentIds: [uses[1]?.id],
				reason: "The first eligible use was selected; later eligible uses were deduplicated because this book is evaluated once by book identity.",
			}],
		});
		expect(evidence[1]).toMatchObject({
			attachmentIds: uses.filter((use) => use.eligible).map((use) => use.id),
			attachmentSelection: {
				selectedAttachmentId: uses[0]?.id,
				deduplicatedAttachmentIds: [uses[1]?.id],
			},
		});
	});
	test("stores the scan window once while retaining matched and unmatched entry evidence", () => {
		const book = importNativeLorebook(database, {
			name: "World", description: "",
			entries: ["matched", "unmatched", "also unmatched"].map((title) => ({
				title, content: "Lore.", keywords: [title === "matched" ? "signal" : "absent"],
				semanticTriggers: [], matchOperator: "or", always: false,
				requireAny: [], requireAll: [], excludeAny: [], excludeAll: [],
				caseSensitive: false, wholeWord: true, keywordMode: "literal", regexFlags: "",
				priority: 1, enabled: true,
			})),
		});
		const chat = createConversationWithHistory(database, {
			name: "Story",
			participants: ["Keeper", "Writer"].map((name) => ({ definition: { name, prompt, openings: [] } })),
			control: { human: 1, model: 0 },
		});
		executeConversationCommand(database, {
			conversationId: chat.id, expectedRevision: chat.revision,
			action: { type: "attach-chat", bookId: book.id },
		});
		const window = "distinctive-scan-window signal";
		const { activation, candidates } = evaluateScopedLore({ database, conversationId: chat.id, messages: [], pendingHumanText: window });
		expect(candidates).toHaveLength(1);
		expect(activation.evidence).toHaveLength(4);
		expect(JSON.stringify(activation).split(window)).toHaveLength(2);
	});

});
