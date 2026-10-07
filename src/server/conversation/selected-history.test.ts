import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConversationModule } from "./index";
import { macroWritesToData } from "../prompt-macros";

const prompt = {
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
};

describe("Conversation selected history", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => { database.close(); });

	test("returns only the bounded selected path and requested Variant data", () => {
		const conversation = createConversationModule(database).create({
			authorNote: "",
			name: "Focused history",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Model", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
			messages: [1, 2, 3].map((position) => ({
				timestamp: `2026-01-01T00:0${position}:00.000Z`,
				variants: [
					{
						content: `Selected ${position}`,
						timestamp: `2026-01-01T00:0${position}:00.000Z`,
						selected: true,
						data: [
							...macroWritesToData(1, [{ name: "turn", operation: "set", value: position }]),
							{ namespace: "unrelated", key: "large", value: "discarded" },
						],
					},
					{
						content: `Alternative ${position}`,
						timestamp: `2026-01-01T00:0${position}:01.000Z`,
						selected: false,
						data: [{ namespace: "prompt-macro", key: "write:1", value: JSON.stringify([{ name: "turn", operation: "set", value: "discarded" }]) }],
					},
				],
			})),
		});

		const read = createConversationModule(database).readSelectedHistory(conversation.id, {
			position: 2,
			conversationDataNamespace: "prompt-macro",
			variantDataNamespace: "prompt-macro",
			variantDataKeys: ["write:1"],
		});
		expect(read?.position).toBe(2);
		expect(read?.messages.map((message) => message.variant?.content)).toEqual([
			"Selected 1",
			"Selected 2",
		]);
		expect(read?.messages[0]?.variant?.data).toEqual([
			{ namespace: "prompt-macro", key: "write:1", value: JSON.stringify([{ name: "turn", operation: "set", value: 1 }]) },
		]);
		expect(read?.messages[0]?.variant?.data).not.toContainEqual(
			{ namespace: "unrelated", key: "large", value: "discarded" },
		);

		const target = createConversationModule(database).readSelectedHistory(conversation.id, {
			targetMessageId: read?.messages[1]?.id,
			variantDataNamespace: "prompt-macro",
			variantDataKeys: ["write:1"],
		});
		expect(target?.position).toBe(1);
		expect(target?.messages.map((message) => message.variant?.content)).toEqual(["Selected 1"]);
		expect(target?.target?.id).toBe(read?.messages[1]?.id);
	});
});
