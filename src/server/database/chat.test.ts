import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createConversationModule, type ConversationModule, type ConversationSnapshot } from "../conversation";
import { applyCommand } from "../conversation/test-fixtures";
import { listChatSummaries } from "./chat";
import { openInitializedDatabase } from "./database";

const prompt = {
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
};

describe("Chat list summaries", () => {
	let database: Database;
	let module: ConversationModule;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		module = createConversationModule(database);
	});
	afterEach(() => database.close());

	const createChat = (name: string, names: string[]) =>
		module.create({
			name,
			participants: names.map((participantName) => ({ definition: { name: participantName, prompt, openings: [] } })),
			control: { human: 0, model: 1 },
		});

	const compose = (chat: ConversationSnapshot, timestamp: string, variantContents: string[], selectedVariantIndex = 0, authorParticipantId = chat.cast[0]?.id ?? 0) =>
		applyCommand(module, {
			conversationId: chat.id,
			expectedRevision: chat.revision,
			action: { type: "create-message", timestamp, variantContents, selectedVariantIndex, authorParticipantId },
		});

	test("lists the active Cast in position order, leaving removed Participants out", () => {
		const chat = createChat("Cast Order", ["Writer", "Maren", "Juno"]);
		const authored = compose(chat, "2026-09-26T10:00:00Z", ["Juno speaks."], 0, chat.cast[2]?.id ?? 0);
		const removed = applyCommand(module, {
			conversationId: chat.id,
			expectedRevision: authored.revision,
			action: { type: "remove-participant", participantId: chat.cast[2]?.id ?? 0 },
		});
		expect(removed.messages[0]?.author?.inCast).toBe(false);

		expect(listChatSummaries(database).find((summary) => summary.id === chat.id)?.castNames).toEqual(["Writer", "Maren"]);
	});

	test("excerpts the last Message's selected Variant with whitespace collapsed and a 160-character cap", () => {
		const chat = createChat("Excerpt", ["Writer", "Maren"]);
		const first = compose(chat, "2026-09-26T10:00:00Z", ["An earlier Message."]);
		const long = `${" \n\t".repeat(200)}Chosen${" \n".repeat(300)}swipe ${"word ".repeat(60)}`;
		compose(first, "2026-09-26T10:01:00Z", ["Unselected swipe.", long], 1);

		const summary = listChatSummaries(database).find((candidate) => candidate.id === chat.id);

		expect(summary?.excerpt).toBe(long.replace(/\s+/g, " ").trim().slice(0, 160));
		expect(summary?.excerpt.startsWith("Chosen swipe word")).toBe(true);
	});

	test("a Chat without Messages has an empty excerpt", () => {
		const chat = createChat("Empty", ["Writer", "Maren"]);

		expect(listChatSummaries(database).find((summary) => summary.id === chat.id)?.excerpt).toBe("");
	});
});
