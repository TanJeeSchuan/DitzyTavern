import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConnectionSettingsModule } from "../connection-settings";
import { createConversationModule } from "../conversation";
import { createConversationRoutes } from "./conversation";

const key = new Uint8Array(32).fill(31);
const prompt = {
	systemInstruction: "Continue carefully.",
	identity: "I am {{self}}.",
	scenario: "A quiet room.",
	exampleDialogue: "",
	postHistoryInstruction: "",
};
const profile = {
	displayName: "DeepSeek",
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
	new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Continued." }, finish_reason: null }] })}\n\n`));
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`));
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
		}),
	{ headers: { "content-type": "text/event-stream" } },
);

describe("Continuation transport contract", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("accepts Continue without a human Message and uses the instruction strategy", async () => {
		const conversation = createConversationModule(database).create({
			name: "Continuation Contract",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
			messages: [{
				timestamp: "2026-08-27T00:00:00Z",
				variants: [{ content: "Previous model writing.", timestamp: "2026-08-27T00:00:00Z", selected: true }],
				authorParticipantIndex: 1,
			}],
		});
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "not returned",
		});
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: async () => streamResponse(),
		});
		const acceptedResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/continue/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversation.revision }),
			},
		));
		// SAFETY: this contract test controls the typed acceptance response.
		const accepted = await acceptedResponse.json() as { generationId: number };
		const response = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
		));
		const body = await response.text();
		const after = createConversationModule(database).getSnapshot(conversation.id);
		expect(acceptedResponse.status).toBe(200);
		expect(response.status).toBe(200);
		expect(body).toContain('"outcome":"applied"');
		expect(after?.messages).toHaveLength(2);
		expect(after?.messages.at(-1)?.variants[0]?.content).toBe("Continued.");
	});
});
