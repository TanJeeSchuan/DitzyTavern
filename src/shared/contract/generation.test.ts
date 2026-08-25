import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../../server/database/database";
import { createConnectionSettingsModule } from "../../server/connection-settings";
import { createConversationModule } from "../../server/conversation";
import { createConversationRoutes } from "./conversation";

const key = new Uint8Array(32).fill(23);
const prompt = {
	systemInstruction: "Answer briefly.",
	identity: "I am {{self}}.",
	scenario: "The room is quiet.",
	exampleDialogue: "",
	postHistoryInstruction: "Continue.",
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
	backendOptions: {},
};

interface CapturedGenerationBody {
	model?: string;
	max_tokens?: number;
}

const streamResponse = () => {
	const encoder = new TextEncoder();
	const chunks = [
		`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Contract " }, finish_reason: null }] })}\n\n`,
		`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "reply." }, finish_reason: null }] })}\n\n`,
		`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
		"data: [DONE]\n\n",
	];
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
};

describe("Generation transport contract", () => {
	let database: Database;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
	});

	afterEach(() => {
		database.close();
	});

	test("persists Conversation settings and returns one streamed generated Variant with safe provenance", async () => {
		const conversation = createConversationModule(database).create({
			name: "Generation Contract",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const connection = createConnectionSettingsModule(database, { masterKey: key });
		connection.createProfile({
			expectedRevision: 0,
			profile,
			credential: "contract-secret-never-returned",
		});
		let requestBody: CapturedGenerationBody | undefined;
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: async (_input, init) => {
				// SAFETY: the controlled fake receives the AI SDK Chat Completions
				// body and this test reads only the model and token fields.
				requestBody = JSON.parse(String(init?.body)) as CapturedGenerationBody;
				return streamResponse();
			},
		});

		const settings = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}/generation-settings`),
		);
		expect(settings.status).toBe(200);
		expect((await settings.json()).modelId).toBe("deepseek-chat");

		const updated = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}/commands`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedRevision: conversation.revision,
					action: {
						type: "update-generation-settings",
						settings: {
							modelId: "free-text-model",
							temperature: 0.2,
							topP: null,
							frequencyPenalty: null,
							presencePenalty: null,
							contextLimit: 4096,
							responseBudget: 32,
							requestOverrides: {
								"chat-completions": {},
								responses: {},
								"anthropic-messages": {},
							},
						},
					},
				}),
			}),
		);
		expect(updated.status).toBe(200);

		const generated = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}/generate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		}),
		);
		expect(generated.status).toBe(200);
		const body = await generated.json();
		expect(body.variant.content).toBe("Contract reply.");
		expect(body.variant.data).toHaveLength(1);
		expect(JSON.stringify(body)).not.toContain("contract-secret-never-returned");
		expect(JSON.stringify(body)).not.toContain("127.0.0.1:43127");
		expect(requestBody?.model).toBe("free-text-model");
		expect(requestBody?.max_tokens).toBe(32);
	});

	test("does not contact a provider when no active Profile exists", async () => {
		const conversation = createConversationModule(database).create({
			name: "Unconfigured Generation",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		let contacted = false;
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: async () => {
				contacted = true;
				return new Response();
			},
		});
		const response = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}/generate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		}),
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ outcome: "unconfigured" });
		expect(contacted).toBe(false);
	});
});
