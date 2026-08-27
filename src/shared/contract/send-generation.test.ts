import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../../server/database/database";
import { createConnectionSettingsModule } from "../../server/connection-settings";
import { createConversationModule } from "../../server/conversation";
import { createConversationRoutes } from "./conversation";

const prompt = {
	systemInstruction: "Answer briefly.",
	identity: "I am {{self}}.",
	scenario: "The room is quiet.",
	exampleDialogue: "",
	postHistoryInstruction: "Continue.",
};

const profile = {
	displayName: "Send test profile",
	apiFormat: "chat-completions" as const,
	requestUrl: "http://127.0.0.1:43127/v1/",
	modelsUrl: "",
	modelBackend: "automatic" as const,
	adapter: "deepseek" as const,
	outputTokenRepresentation: "automatic" as const,
	timeoutMs: 120_000,
	pinnedModels: [],
};

const streamResponse = () => {
	const encoder = new TextEncoder();
	return new Response(new ReadableStream({
		start(controller) {
			for (const frame of [
				`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Answer." }, finish_reason: null }] })}\n\n`,
				`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
				"data: [DONE]\n\n",
			]) controller.enqueue(encoder.encode(frame));
			controller.close();
		},
	}), { headers: { "content-type": "text/event-stream" } });
};

describe("Send generation transport", () => {
	let database: Database;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
	});
	afterEach(() => database.close());

	test("accepts the draft with its revision and exposes the authoritative human/model pair", async () => {
		const conversation = createConversationModule(database).create({
			name: "Send contract",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		createConnectionSettingsModule(database, { masterKey: new Uint8Array(32).fill(9) }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "send-contract-secret",
		});
		let providerSawHuman = false;
		const app = createConversationRoutes(database, {
			masterKey: new Uint8Array(32).fill(9),
			fetch: async () => {
				providerSawHuman = createConversationModule(database).getSnapshot(conversation.id)?.messages.at(-1)?.author?.capturedName === "Maren";
				return streamResponse();
			},
		});

		const acceptedResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversation.revision, content: "Open the door." }),
			},
		));
		// SAFETY: this contract test controls the typed acceptance response.
		const accepted = await acceptedResponse.json() as { generationId: number };
		const response = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
		));
		await response.text();
		const persisted = createConversationModule(database).getSnapshot(conversation.id);
		expect(acceptedResponse.status).toBe(200);
		expect(response.status).toBe(200);
		expect(providerSawHuman).toBe(true);
		expect(persisted?.messages).toHaveLength(2);
		expect(persisted?.messages[0]?.variants[0]?.content).toBe("Open the door.");
		expect(persisted?.messages[1]?.variants[0]?.content).toBe("Answer.");
	});
});
