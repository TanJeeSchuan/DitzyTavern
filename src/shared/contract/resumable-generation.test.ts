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
	displayName: "Resumable test profile",
	apiFormat: "chat-completions" as const,
	requestUrl: "http://127.0.0.1:43127/v1/",
	modelsUrl: "",
	modelBackend: "automatic" as const,
	adapter: "deepseek" as const,
	outputTokenRepresentation: "automatic" as const,
	timeoutMs: 120_000,
	pinnedModels: [],
};

describe("Resumable generation transport", () => {
	let database: Database;

	beforeEach(() => { database = openDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("separates acceptance from subscription and replays buffered events", async () => {
		const conversation = createConversationModule(database).create({
			name: "Resumable Chat",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		createConnectionSettingsModule(database, { masterKey: new Uint8Array(32).fill(4) }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "resumable-secret",
		});
		let release!: () => void;
		const paused = new Promise<void>((resolve) => { release = resolve; });
		const encoder = new TextEncoder();
		const app = createConversationRoutes(database, {
			masterKey: new Uint8Array(32).fill(4),
			fetch: async () => new Response(new ReadableStream({
				async start(controller) {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Buffered." }, finish_reason: null }] })}\n\n`));
					await paused;
					controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`));
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				},
			}), { headers: { "content-type": "text/event-stream" } }),
		});

		const acceptedResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversation.revision, content: "Start." }),
			},
		));
		// SAFETY: this contract test controls the start endpoint and checks the
		// response status immediately before reading its accepted identifier.
		const accepted = await acceptedResponse.json() as { generationId: number };
		expect(acceptedResponse.status).toBe(200);
		expect(accepted.generationId).toBeGreaterThan(0);

		const subscription = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generate/stream/${accepted.generationId}`,
		));
		const bodyPromise = subscription.text();
		release();
		const body = await bodyPromise;
		expect(body).toContain("id: 1");
		expect(body).toContain('"text":"Buffered."');
		expect(body).toContain("event: complete");

		const snapshot = createConversationModule(database).getSnapshot(conversation.id);
		expect(snapshot?.activeGeneration).toBeNull();
		expect(snapshot?.messages.at(-1)?.variants[0]?.content).toBe("Buffered.");
	});

	test("disconnecting the initiating stream leaves the controlled provider running", async () => {
		const conversation = createConversationModule(database).create({
			name: "Disconnect Chat",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		createConnectionSettingsModule(database, { masterKey: new Uint8Array(32).fill(5) }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "disconnect-secret",
		});
		let providerSignal: AbortSignal | undefined;
		let release!: () => void;
		const paused = new Promise<void>((resolve) => { release = resolve; });
		const encoder = new TextEncoder();
		const app = createConversationRoutes(database, {
			masterKey: new Uint8Array(32).fill(5),
			fetch: async (_input, init) => {
				providerSignal = init?.signal ?? undefined;
				return new Response(new ReadableStream({
					async start(controller) {
						controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Survives." }, finish_reason: null }] })}\n\n`));
						await paused;
						controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`));
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
					},
				}), { headers: { "content-type": "text/event-stream" } });
			},
		});

		const abort = new AbortController();
		const initiating = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generate/stream`,
			{
				method: "POST",
				signal: abort.signal,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversation.revision, content: "Keep running." }),
			},
		));
		const reader = initiating.body?.getReader();
		if (reader === undefined) throw new Error("Initiating stream has no body.");
		await reader.read();
		abort.abort();
		await reader.cancel();

		// A second client can attach from the beginning while the first one is
		// gone; releasing the fake provider proves the generation was not tied to
		// the first Request signal.
		const current = createConversationModule(database).getSnapshot(conversation.id);
		const generationId = current?.activeGeneration?.generationId;
		if (generationId === undefined) throw new Error("Active Generation missing.");
		const observer = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generate/stream/${generationId}`,
		));
		const observedBody = observer.text();
		release();
		const body = await observedBody;
		expect(providerSignal?.aborted).toBe(false);
		expect(body).toContain('"text":"Survives."');
		expect(body).toContain("event: complete");
	});
});
