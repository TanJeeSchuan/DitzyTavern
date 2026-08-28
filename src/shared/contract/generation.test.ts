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

const streamResponseWith = (content: string) => {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`));
				controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`));
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
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
		expect((await settings.json())).toMatchObject({
			modelId: "deepseek-chat",
			safetyAllowance: 500,
		});

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
							safetyAllowance: 321,
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
		// SAFETY: this contract test controls the typed command response.
		const updatedPayload = await updated.json() as { conversation: { revision: number } };

		const generated = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}/generations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ expectedRevision: updatedPayload.conversation.revision, content: "Generate this." }),
		}),
		);
		expect(generated.status).toBe(200);
		// SAFETY: this contract test controls the typed acceptance response.
		const accepted = await generated.json() as { generationId: number };
		const observed = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
		));
		const body = await observed.text();
		const persisted = createConversationModule(database).getSnapshot(conversation.id);
		const message = persisted?.messages.at(-1);
		const variant = message?.variants.at(-1);
		expect(variant?.content).toBe("Contract reply.");
		expect(variant?.data).toEqual(expect.arrayContaining([
			{
				namespace: "generation",
				key: "finish",
				value: JSON.stringify({ reason: "stop" }),
			},
		]));
		if (message === undefined || variant === undefined) throw new Error("Generated Variant missing.");
		expect(createConversationModule(database).readVariantDetails(
			conversation.id,
			message.id,
			variant.id,
		)?.provenance).toMatchObject({
			status: "complete",
			finishReason: "stop",
			interruptionCause: null,
		});
		expect(body).not.toContain("contract-secret-never-returned");
		expect(body).not.toContain("127.0.0.1:43127");
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
			new Request(`http://localhost/api/conversations/${conversation.id}/generations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ expectedRevision: conversation.revision, content: "Generate this." }),
		}),
		);
		expect(response.status).toBe(422);
		expect(await response.text()).toContain('"outcome":"invalid"');
		expect(contacted).toBe(false);
	});

	test("maps a known prompt budget failure to the invalid contract", async () => {
		const conversation = createConversationModule(database).create({
			name: "Budget-bound Generation",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "budget-contract-secret",
		});
		database.run(
			"UPDATE conversation_generation_settings SET context_limit = 1 WHERE chat_id = ?",
			[conversation.id],
		);
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: async () => streamResponse(),
		});

		const response = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}/generations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversation.revision, content: "Generate this." }),
			}),
		);

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			outcome: "invalid",
			reason: "Prompt Plan exceeds the Conversation context limit.",
		});
	});

	test("does not hide malformed persisted generation settings as invalid input", async () => {
		const conversation = createConversationModule(database).create({
			name: "Malformed Generation Settings",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "malformed-settings-secret",
		});
		database.run(
			"UPDATE conversation_generation_settings SET context_limit = 0 WHERE chat_id = ?",
			[conversation.id],
		);
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: async () => streamResponse(),
		});

		const response = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}/generations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversation.revision, content: "Generate this." }),
			}),
		);

		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain('"outcome":"invalid"');
	});

	test("streams normalized generation events and completion over the live SSE route", async () => {
		const conversation = createConversationModule(database).create({
			name: "Live Generation Contract",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "live-secret-never-returned",
		});
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: async () => streamResponse(),
		});

		const response = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}/generations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversation.revision, content: "Generate this." }),
			}),
		);
		// SAFETY: this contract test controls the typed acceptance response.
		const accepted = await response.json() as { generationId: number };
		const events = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
		));
		const body = await events.text();

		expect(response.status).toBe(200);
		expect(events.headers.get("content-type")).toContain("text/event-stream");
		expect(body).toContain("event: generation");
		expect(body).toContain('"type":"content"');
		expect(body).toContain('"text":"Contract "');
		expect(body).toContain("event: complete");
		expect(body).not.toContain("live-secret-never-returned");
	});

	test("generates through a generic exact endpoint with custom authentication", async () => {
		const conversation = createConversationModule(database).create({
			name: "Generic Generation Contract",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const connection = createConnectionSettingsModule(database, { masterKey: key });
		connection.createProfile({
			expectedRevision: 0,
			profile: {
				...profile,
				displayName: "Generic Local",
				adapter: "openai-compatible",
				requestUrl: "http://127.0.0.1:43127/generate",
			},
			headers: [
				{ name: "Authorization", operation: "replace", value: "Custom auth never returned" },
				{ name: "X-Route", operation: "replace", value: "route secret never returned" },
			],
		});
		let request: { url: string; headers: Headers } | undefined;
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: async (input, init) => {
				request = { url: String(input), headers: new Headers(init?.headers) };
				return streamResponse();
			},
		});
		const generated = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}/generations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversation.revision, content: "Generate this." }),
			}),
		);
		expect(generated.status).toBe(200);
		// SAFETY: this contract test controls the typed acceptance response.
		const accepted = await generated.json() as { generationId: number };
		const events = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
		));
		const generatedBody = await events.text();
		expect(createConversationModule(database).getSnapshot(conversation.id)?.messages.at(-1)?.variants.at(-1)?.content).toBe("Contract reply.");
		expect(generatedBody).not.toContain("never returned");
		expect(request?.url).toBe("http://127.0.0.1:43127/generate");
		expect(request?.headers.get("authorization")).toBe("Custom auth never returned");
		expect(request?.headers.get("x-route")).toBe("route secret never returned");
	});

	test("generates through the dedicated OpenRouter adapter", async () => {
		const conversation = createConversationModule(database).create({
			name: "OpenRouter Generation Contract",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const connection = createConnectionSettingsModule(database, { masterKey: key });
		connection.createProfile({
			expectedRevision: 0,
			profile: {
				...profile,
				displayName: "OpenRouter",
				adapter: "openrouter",
				requestUrl: "http://127.0.0.1:43127/api/v1/",
				modelsUrl: "http://127.0.0.1:43127/api/v1/models",
			},
			credential: "openrouter-secret-never-returned",
		});
		let request: { url: string; headers: Headers } | undefined;
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: async (input, init) => {
				request = { url: String(input), headers: new Headers(init?.headers) };
				return streamResponse();
			},
		});
		const generated = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}/generations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversation.revision, content: "Generate this." }),
			}),
		);
		expect(generated.status).toBe(200);
		// SAFETY: this contract test controls the typed acceptance response.
		const accepted = await generated.json() as { generationId: number };
		const events = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
		));
		const generatedBody = await events.text();
		expect(createConversationModule(database).getSnapshot(conversation.id)?.messages.at(-1)?.variants.at(-1)?.content).toBe("Contract reply.");
		expect(generatedBody).not.toContain("openrouter-secret-never-returned");
		expect(request?.url).toBe("http://127.0.0.1:43127/api/v1/chat/completions");
		expect(request?.headers.get("authorization")).toBe("Bearer openrouter-secret-never-returned");
		expect(request?.headers.get("http-referer")).toBeNull();
		expect(request?.headers.get("x-openrouter-title")).toBeNull();
	});

	test("streams a server-owned Sibling Generation on the target Message", async () => {
		const conversation = createConversationModule(database).create({
			name: "Sibling Generation Contract",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: ["Opening."] } },
			],
			control: { human: 0, model: 1 },
		});
		const target = conversation.messages[0];
		if (target === undefined) throw new Error("Sibling target missing.");
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "sibling-contract-secret",
		});
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: async () => streamResponse(),
		});
		const response = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/messages/${target.id}/sibling/generations`,
			{ method: "POST", body: "{}" },
		));
		// SAFETY: this contract test controls the typed acceptance response.
		const accepted = await response.json() as { generationId: number };
		const events = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
		));
		const body = await events.text();
		const persisted = createConversationModule(database).getSnapshot(conversation.id);
		const targetAfter = persisted?.messages.find((message) => message.id === target.id);
		expect(response.status).toBe(200);
		expect(body).toContain("event: complete");
		expect(targetAfter?.variants.at(-1)?.content).toBe("Contract reply.");
		expect(targetAfter?.variants.at(-1)?.selected).toBe(true);
	});

	test("runs parallel Sibling Generations as independent accepted outcomes", async () => {
		const conversation = createConversationModule(database).create({
			name: "Parallel Sibling Contract",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: ["Opening."] } },
			],
			control: { human: 0, model: 1 },
		});
		const target = conversation.messages[0];
		if (target === undefined) throw new Error("Sibling target missing.");
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "parallel-sibling-secret",
		});
		let release!: () => void;
		const paused = new Promise<void>((resolve) => { release = resolve; });
		let providerRequest = 0;
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: async () => {
				providerRequest += 1;
				const content = `Alternative ${providerRequest}.`;
				await paused;
				return streamResponseWith(content);
			},
		});
		const startSibling = () => app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/messages/${target.id}/sibling/generations`,
			{ method: "POST", body: "{}" },
		));
		const firstResponse = await startSibling();
		const secondResponse = await startSibling();
		// SAFETY: both responses come from the typed Sibling acceptance route.
		const first = await firstResponse.json() as { generationId: number; variantId: number };
		// SAFETY: both responses come from the typed Sibling acceptance route.
		const second = await secondResponse.json() as { generationId: number; variantId: number };
		expect(firstResponse.status).toBe(200);
		expect(secondResponse.status).toBe(200);
		expect(first.generationId).not.toBe(second.generationId);
		expect(first.variantId).not.toBe(second.variantId);
		expect(createConversationModule(database).getSnapshot(conversation.id)?.activeGenerations).toHaveLength(2);

		const firstEvents = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${first.generationId}/events`,
		));
		const secondEvents = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${second.generationId}/events`,
		));
		const firstBody = firstEvents.text();
		const secondBody = secondEvents.text();
		release();
		expect(await firstBody).toContain("event: complete");
		expect(await secondBody).toContain("event: complete");

		const persisted = createConversationModule(database).getSnapshot(conversation.id);
		const variants = persisted?.messages.find((message) => message.id === target.id)?.variants ?? [];
		expect(providerRequest).toBe(2);
		expect(variants.map((variant) => variant.content)).toEqual([
			"Opening.",
			"Alternative 1.",
			"Alternative 2.",
		]);
		expect(variants.filter((variant) => variant.selected)).toHaveLength(1);
		expect(persisted?.activeGenerations).toEqual([]);
	});
});
