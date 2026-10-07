import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConnectionSettingsModule } from "../connection-settings";
import { createConversationModule } from "../conversation";
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

const providerStreamResponse = ({
	content,
	finishReason = "stop",
	failAfterContent = false,
}: {
	content?: string;
	finishReason?: string;
	failAfterContent?: boolean;
}) => {
	const encoder = new TextEncoder();
	return new Response(new ReadableStream({
		start(controller) {
			if (content !== undefined) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`));
			}
			if (failAfterContent) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify({
					error: {
						message: "Injected provider connection failure.",
						type: "server_error",
						code: "injected_failure",
					},
				})}\n\n`));
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`));
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	}), { headers: { "content-type": "text/event-stream" } });
};

const streamResponse = () => providerStreamResponse({ content: "Answer." });

describe("Send generation transport", () => {
	let database: Database;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
	});
	afterEach(() => database.close());

	test("accepts the draft with its revision and exposes the authoritative human/model pair", async () => {
		const conversation = createConversationModule(database).create({
			authorNote: "",
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

	test("persists partial provider output as an interrupted Variant through the HTTP routes", async () => {
		const conversation = createConversationModule(database).create({
			authorNote: "",
			name: "Partial Send contract",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const masterKey = new Uint8Array(32).fill(10);
		createConnectionSettingsModule(database, { masterKey }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "partial-contract-secret",
		});
		const app = createConversationRoutes(database, {
			masterKey,
			fetch: async () => providerStreamResponse({
				content: "Saved partial answer.",
				failAfterContent: true,
			}),
		});

		const acceptedResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversation.revision, content: "Write through the failure." }),
			},
		));
		// SAFETY: this contract test controls the typed acceptance response.
		const accepted = await acceptedResponse.json() as { generationId: number };
		const eventsResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
		));
		const events = await eventsResponse.text();
		const snapshot = createConversationModule(database).getSnapshot(conversation.id);
		const message = snapshot?.messages.at(-1);
		const variant = message?.variants[0];
		if (message === undefined || variant === undefined) throw new Error("Interrupted Variant missing.");
		const detailsResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/messages/${message.id}/variants/${variant.id}/details`,
		));
		const details = await detailsResponse.text();

		expect(acceptedResponse.status).toBe(200);
		expect(events).toContain('"text":"Saved partial answer."');
		expect(events).toContain("event: complete");
		expect(variant.content).toBe("Saved partial answer.");
		expect(details).toContain('"status":"interrupted"');
		expect(details).toContain('"interruptionCause":"provider"');
		expect(details).not.toContain("Injected provider connection failure.");
	});

	test("zero output retries only on an explicit second start and never duplicates the human Message", async () => {
		const conversation = createConversationModule(database).create({
			authorNote: "",
			name: "Zero-output retry contract",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const masterKey = new Uint8Array(32).fill(11);
		createConnectionSettingsModule(database, { masterKey }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "zero-output-contract-secret",
		});
		let providerRequests = 0;
		const app = createConversationRoutes(database, {
			masterKey,
			fetch: async () => {
				providerRequests += 1;
				return providerRequests === 1
					? providerStreamResponse({})
					: providerStreamResponse({ content: "Retry succeeded." });
			},
		});
		const start = (expectedRevision: number) => app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision, content: "Please answer once." }),
			},
		));

		const firstResponse = await start(conversation.revision);
		// SAFETY: this contract test controls the typed acceptance response.
		const first = await firstResponse.json() as { generationId: number };
		const firstEventsResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${first.generationId}/events`,
		));
		const firstEvents = await firstEventsResponse.text();
		const afterZeroOutput = createConversationModule(database).getSnapshot(conversation.id);
		expect(firstEvents).toContain("event: error");
		expect(providerRequests).toBe(1);
		expect(afterZeroOutput?.messages).toHaveLength(1);
		expect(afterZeroOutput?.messages[0]?.variants[0]?.content).toBe("Please answer once.");

		const retryResponse = await start(afterZeroOutput?.revision ?? -1);
		// SAFETY: this contract test controls the typed acceptance response.
		const retry = await retryResponse.json() as { generationId: number };
		const retryEventsResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${retry.generationId}/events`,
		));
		const retryEvents = await retryEventsResponse.text();
		const persisted = createConversationModule(database).getSnapshot(conversation.id);

		expect(retryResponse.status).toBe(200);
		expect(retryEvents).toContain("event: complete");
		expect(providerRequests).toBe(2);
		expect(persisted?.messages).toHaveLength(2);
		expect(persisted?.messages[0]?.variants[0]?.content).toBe("Please answer once.");
		expect(persisted?.messages[1]?.variants[0]?.content).toBe("Retry succeeded.");
	});

	test("provider response bodies and request details never enter Generation HTTP or SSE errors", async () => {
		const conversation = createConversationModule(database).create({
			authorNote: "",
			name: "Safe provider failure contract",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const masterKey = new Uint8Array(32).fill(17);
		createConnectionSettingsModule(database, { masterKey }).createProfile({
			expectedRevision: 0,
			profile: { ...profile, requestUrl: "https://secret.endpoint/v1/" },
			credential: "credential-do-not-expose",
		});
		const leakedBody = "RAW BODY https://secret.endpoint credential-do-not-expose header-do-not-expose";
		const app = createConversationRoutes(database, {
			masterKey,
			fetch: async () => new Response(leakedBody, {
				status: 502,
				headers: { "content-type": "application/secret.endpoint+binary; credential=header-do-not-expose" },
			}),
		});

		const acceptedResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversation.revision, content: "Fail safely." }),
			},
		));
		const acceptedBody = await acceptedResponse.text();
		// SAFETY: this contract test controls the typed acceptance response.
		const accepted = JSON.parse(acceptedBody) as { generationId: number };
		const eventsResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
		));
		const events = await eventsResponse.text();

		expect(acceptedResponse.status).toBe(200);
		expect(events).toContain("event: error");
		expect(events).toContain("HTTP 502");
		expect(events).toContain("binary response body");
		for (const visible of [acceptedBody, events]) {
			expect(visible).not.toContain("RAW BODY");
			expect(visible).not.toContain("secret.endpoint");
			expect(visible).not.toContain("credential-do-not-expose");
			expect(visible).not.toContain("header-do-not-expose");
		}
	});

	test("raw provider finish reasons are normalized before Generation SSE", async () => {
		const conversation = createConversationModule(database).create({
			authorNote: "",
			name: "Safe finish contract",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const masterKey = new Uint8Array(32).fill(18);
		createConnectionSettingsModule(database, { masterKey }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "finish-credential-do-not-expose",
		});
		const rawFinishReason = "https://secret.endpoint X-Secret=header-do-not-expose arbitrary-provider-text";
		const app = createConversationRoutes(database, {
			masterKey,
			fetch: async () => providerStreamResponse({ content: "Safe answer.", finishReason: rawFinishReason }),
		});
		const acceptedResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversation.revision, content: "Finish safely." }),
			},
		));
		// SAFETY: this contract test controls the typed acceptance response.
		const accepted = await acceptedResponse.json() as { generationId: number };
		const events = await (await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
		))).text();

		expect(events).toContain('"finishReason":"other"');
		expect(events).not.toContain(rawFinishReason);
		expect(events).not.toContain("secret.endpoint");
		expect(events).not.toContain("header-do-not-expose");
		expect(events).not.toContain("arbitrary-provider-text");
	});

	test("persists a length-limited terminal outcome through the HTTP routes", async () => {
		const conversation = createConversationModule(database).create({
			authorNote: "",
			name: "Length-limited Send contract",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const masterKey = new Uint8Array(32).fill(12);
		createConnectionSettingsModule(database, { masterKey }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "length-contract-secret",
		});
		const app = createConversationRoutes(database, {
			masterKey,
			fetch: async () => providerStreamResponse({
				content: "Bounded response.",
				finishReason: "length",
			}),
		});

		const acceptedResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversation.revision, content: "Use the full response budget." }),
			},
		));
		// SAFETY: this contract test controls the typed acceptance response.
		const accepted = await acceptedResponse.json() as { generationId: number };
		const eventsResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
		));
		const events = await eventsResponse.text();
		const snapshot = createConversationModule(database).getSnapshot(conversation.id);
		const message = snapshot?.messages.at(-1);
		const variant = message?.variants[0];
		if (message === undefined || variant === undefined) throw new Error("Length-limited Variant missing.");
		const detailsResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/messages/${message.id}/variants/${variant.id}/details`,
		));
		const details = await detailsResponse.text();

		expect(acceptedResponse.status).toBe(200);
		expect(events).toContain('"finishReason":"length"');
		expect(events).toContain("event: complete");
		expect(variant.content).toBe("Bounded response.");
		expect(details).toContain('"status":"length-limited"');
		expect(details).toContain('"finishReason":"length"');
	});
});
