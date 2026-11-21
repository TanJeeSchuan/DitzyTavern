import { profile as chatProfile, sseReply } from "./prompt-preset-test-fixtures";
import { readTestConversationSnapshot, shortReplyPrompt, pairChat } from "../test-fixtures/conversation";
import { readVariantDetails } from "../conversation";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createConnectionSettingsModule } from "../connection-settings";
import { createConversationRoutes } from "./conversation";

const key = new Uint8Array(32).fill(23);
const prompt = shortReplyPrompt();

const profile = { ...chatProfile, requestUrl: "http://127.0.0.1:43127/v1/", systemPlacement: "strict" } satisfies typeof chatProfile;

interface CapturedGenerationBody {
	model?: string;
	max_tokens?: number;
}



describe("Generation transport contract", () => {
	let database: Database;

	beforeEach(() => {
		database = openObservedDatabase();
	});

	afterEach(() => {
		database.close();
	});

	test("persists Conversation settings and returns one streamed generated Variant with safe provenance", async () => {
		const conversation = pairChat(database, "Generation Contract", { prompt });
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
				return sseReply([{ content: "Contract " }, { content: "reply." }]);
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
							siblingGenerationLimit: 4,
							continuationStrategy: "instruction",
							continuationInstruction:
								"Continue the narrative naturally without repeating the previous text.",
							continuationPrefillSuffix: "",
							repeatedImagePlacement: "first",
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
			body: JSON.stringify({ kind: "send",  expectedRevision: updatedPayload.conversation.revision, content: "Generate this." }),
		}),
		);
		expect(generated.status).toBe(200);
		// SAFETY: this contract test controls the typed acceptance response.
		const accepted = await generated.json() as { generationId: number };
		const observed = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
		));
		const body = await observed.text();
		const persisted = readTestConversationSnapshot(database, conversation.id);
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
		expect(readVariantDetails(database,
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

	test("does not contact a provider when the Conversation has no selected Profile", async () => {
		const conversation = pairChat(database, "Unconfigured Generation", { prompt });
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
			body: JSON.stringify({ kind: "send",  expectedRevision: conversation.revision, content: "Generate this." }),
		}),
		);
		expect(response.status).toBe(422);
		expect(await response.text()).toContain('"outcome":"invalid"');
		expect(contacted).toBe(false);
	});

	test("maps a known prompt budget failure to the invalid contract", async () => {
		const conversation = pairChat(database, "Budget-bound Generation", { prompt });
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "budget-contract-secret",
		});
		database.run(
			"UPDATE conversation_generation_settings SET settings_json = json_set(settings_json, '$.contextLimit', 1) WHERE conversation_id = ?",
			[conversation.id],
		);
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: async () => sseReply([{ content: "Contract " }, { content: "reply." }]),
		});

		const response = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}/generations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ kind: "send",  expectedRevision: conversation.revision, content: "Generate this." }),
			}),
		);

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			outcome: "invalid",
			reason: "Prompt Plan exceeds the Conversation context limit.",
		});
	});

	test("does not hide malformed persisted generation settings as invalid input", async () => {
		const conversation = pairChat(database, "Malformed Generation Settings", { prompt });
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "malformed-settings-secret",
		});
		database.run(
			"UPDATE conversation_generation_settings SET settings_json = json_set(settings_json, '$.contextLimit', 0) WHERE conversation_id = ?",
			[conversation.id],
		);
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: async () => sseReply([{ content: "Contract " }, { content: "reply." }]),
		});

		const response = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}/generations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ kind: "send",  expectedRevision: conversation.revision, content: "Generate this." }),
			}),
		);

		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain('"outcome":"invalid"');
	});

	test("streams normalized generation events and completion over the live SSE route", async () => {
		const conversation = pairChat(database, "Live Generation Contract", { prompt });
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "live-secret-never-returned",
		});
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: async () => sseReply([{ content: "Contract " }, { content: "reply." }]),
		});

		const response = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}/generations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ kind: "send",  expectedRevision: conversation.revision, content: "Generate this." }),
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
		const conversation = pairChat(database, "Generic Generation Contract", { prompt });
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
				return sseReply([{ content: "Contract " }, { content: "reply." }]);
			},
		});
		const generated = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}/generations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ kind: "send",  expectedRevision: conversation.revision, content: "Generate this." }),
			}),
		);
		expect(generated.status).toBe(200);
		// SAFETY: this contract test controls the typed acceptance response.
		const accepted = await generated.json() as { generationId: number };
		const events = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
		));
		const generatedBody = await events.text();
		expect(readTestConversationSnapshot(database, conversation.id)?.messages.at(-1)?.variants.at(-1)?.content).toBe("Contract reply.");
		expect(generatedBody).not.toContain("never returned");
		expect(request?.url).toBe("http://127.0.0.1:43127/generate");
		expect(request?.headers.get("authorization")).toBe("Custom auth never returned");
		expect(request?.headers.get("x-route")).toBe("route secret never returned");
	});
});
