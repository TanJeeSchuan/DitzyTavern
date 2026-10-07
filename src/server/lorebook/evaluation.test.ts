import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createCharacter } from "../character-library/create";
import { createConversationModule } from "../conversation";
import { importNativeLorebook } from "./library";
import { attachLorebookToCharacter, attachLorebookToConversation, readLorebookAttachmentEligibility } from "./attachments";
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
	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
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
		const chat = createConversationModule(database).create({
			authorNote: "",
			name: "Story",
			participants: [
				{ sourceCharacterId: character.id, definition: { name: "Keeper", prompt, openings: [] } },
				{ definition: { name: "Writer", prompt, openings: [] } },
			],
			control: { human: 1, model: 0 },
		});
		attachLorebookToConversation(database, { conversationId: chat.id, bookId: book.id });
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
});
