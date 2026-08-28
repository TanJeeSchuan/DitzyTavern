import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createConnectionSettingsModule } from "../connection-settings";
import { createConversationModule } from "../conversation";
import { openDatabase } from "../database/database";
import { createGenerationCoordinator } from "./generation-coordinator";

const key = new Uint8Array(32).fill(31);
const prompt = {
	systemInstruction: "Write briefly.",
	identity: "I am {{self}}.",
	scenario: "A quiet room.",
	exampleDialogue: "",
	postHistoryInstruction: "Continue.",
};
const profile = {
	displayName: "Coordinator Test",
	apiFormat: "chat-completions" as const,
	requestUrl: "http://127.0.0.1:43127/v1/",
	modelsUrl: "",
	modelBackend: "automatic" as const,
	adapter: "deepseek" as const,
	outputTokenRepresentation: "automatic" as const,
	timeoutMs: 120_000,
	pinnedModels: [],
};

const streamResponse = () => new Response(
	["data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Coordinator output.\"},\"finish_reason\":null}]}\n\n", "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n", "data: [DONE]\n\n"].join(""),
	{ headers: { "content-type": "text/event-stream" } },
);

describe("GenerationCoordinator", () => {
	let database: Database;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
	});

	afterEach(() => database.close());

	test("shares runtime and transport setup across tail, continuation, and sibling starts", async () => {
		const conversation = createConversationModule(database).create({
			name: "Coordinator Chat",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "coordinator-test-secret",
		});
		const coordinator = createGenerationCoordinator(database, {
			masterKey: key,
			fetch: async () => streamResponse(),
		});

		const first = await coordinator.startSendGeneration({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			content: "Start the scene.",
		});
		const firstResult = await first.result;
		expect(first.runtime.state.status).toBe("complete");
		expect(firstResult.conversation.messages).toHaveLength(2);

		const continuation = await coordinator.startContinuationGeneration({
			conversationId: conversation.id,
			expectedRevision: firstResult.conversation.revision,
		});
		const continuationResult = await continuation.result;
		expect(continuation.runtime.state.status).toBe("complete");
		expect(continuationResult.conversation.messages).toHaveLength(3);

		const targetMessageId = firstResult.modelMessageId;
		const sibling = await coordinator.startSiblingGeneration({
			conversationId: conversation.id,
			messageId: targetMessageId,
		});
		await sibling.result;
		expect(sibling.runtime.state.status).toBe("complete");
	});
});
