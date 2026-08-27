import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../../server/database/database";
import { createConnectionSettingsModule } from "../../server/connection-settings";
import {
	acceptConversationTailGeneration,
	checkpointConversationTailGeneration,
	createConversationModule,
} from "../../server/conversation";
import { recoverActiveGenerations } from "../../server/workflows";
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
		// SAFETY: this contract test controls the accepted response shape.
		// SAFETY: this contract test controls the typed acceptance response.
		const accepted = await acceptedResponse.json() as { generationId: number };
		expect(acceptedResponse.status).toBe(200);
		expect(accepted.generationId).toBeGreaterThan(0);

		const subscription = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
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

	test("stops a server-owned Generation without treating provider cancellation as an error", async () => {
		const conversation = createConversationModule(database).create({
			name: "Stop Chat",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		createConnectionSettingsModule(database, { masterKey: new Uint8Array(32).fill(6) }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "stop-secret",
		});
		let providerSignal: AbortSignal | undefined;
		const app = createConversationRoutes(database, {
			masterKey: new Uint8Array(32).fill(6),
			fetch: async (_input, init) => {
				providerSignal = init?.signal ?? undefined;
				// Keep the provider request pending until the explicit Stop aborts it.
				await new Promise<void>((resolve) => {
					if (init?.signal?.aborted === true) {
						resolve();
						return;
					}
					init?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return new Response(null, { headers: { "content-type": "text/event-stream" } });
			},
		});

		const acceptedResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversation.revision, content: "Stop me." }),
			},
		));
		// SAFETY: this contract test controls the accepted response shape.
		const accepted = await acceptedResponse.json() as { generationId: number };
		expect(acceptedResponse.status).toBe(200);

		// Let the detached attempt reach the injected provider before issuing the
		// command; the command remains valid if it is issued earlier as well.
		for (let attempt = 0; attempt < 20 && providerSignal === undefined; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(providerSignal).toBeDefined();
		const stoppedResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/stop`,
			{ method: "POST", body: "{}" },
		));
		// SAFETY: the Stop response is checked for HTTP success immediately below
		// and this test controls the route's documented stopped shape.
		const stopped = await stoppedResponse.json() as { outcome: string; generationId: number };

		expect(stoppedResponse.status).toBe(200);
		expect(stopped).toEqual(expect.objectContaining({
			outcome: "stopped",
			generationId: accepted.generationId,
		}));
		expect(providerSignal?.aborted).toBe(true);
		const snapshot = createConversationModule(database).getSnapshot(conversation.id);
		expect(snapshot?.activeGenerations).toEqual([]);
		expect(snapshot?.messages).toHaveLength(1);
		expect(snapshot?.messages[0]?.variants[0]?.content).toBe("Stop me.");
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

		const acceptedResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversation.revision, content: "Keep running." }),
			},
		));
		// SAFETY: this contract test controls the typed acceptance response.
		const accepted = await acceptedResponse.json() as { generationId: number };
		const abort = new AbortController();
		const initiating = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
			{ signal: abort.signal },
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
			`http://localhost/api/conversations/${conversation.id}/generations/${generationId}/events`,
		));
		const observedBody = observer.text();
		release();
		const body = await observedBody;
		expect(providerSignal?.aborted).toBe(false);
		expect(body).toContain('"text":"Survives."');
		expect(body).toContain("event: complete");
	});

	test("restart recovery exposes checkpointed output as a terminal interrupted Variant", async () => {
		const conversationModule = createConversationModule(database);
		const conversation = conversationModule.create({
			name: "Restart Recovery Chat",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const human = conversation.cast[0];
		const model = conversation.cast[1];
		if (human === undefined || model === undefined) throw new Error("Control Participants missing.");
		const accepted = acceptConversationTailGeneration(database, {
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			timestamp: "2026-08-27T00:00:00.000Z",
			humanContent: "Keep the recovered scene.",
			humanParticipantId: human.id,
			modelParticipantId: model.id,
			capturedModelName: model.name,
			promptPlan: {},
			historyRoles: [],
			generationSettings: {},
			connection: {},
		});
		checkpointConversationTailGeneration(database, {
			conversationId: conversation.id,
			generationId: accepted.generationId,
			content: "Recovered checkpoint.",
			reasoning: "Recovered reasoning.",
			latestEventId: 2,
		});

		expect(recoverActiveGenerations(database)).toEqual({
			inspected: 1,
			interrupted: 1,
			removed: 0,
			failed: 0,
		});
		expect(recoverActiveGenerations(database)).toEqual({
			inspected: 0,
			interrupted: 0,
			removed: 0,
			failed: 0,
		});

		const app = createConversationRoutes(database);
		const summaryResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}`,
		));
		// SAFETY: this contract test controls the typed Conversation response.
		const summary = await summaryResponse.json() as { activeGenerations: unknown[] };
		expect(summaryResponse.status).toBe(200);
		expect(summary.activeGenerations).toEqual([]);

		const recoveredMessage = conversationModule.getSnapshot(conversation.id)?.messages.at(-1);
		const recoveredVariant = recoveredMessage?.variants[0];
		if (recoveredMessage === undefined || recoveredVariant === undefined) {
			throw new Error("Recovered terminal Variant missing.");
		}
		const detailsResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/messages/${recoveredMessage.id}/variants/${recoveredVariant.id}/details`,
		));
		const detailsBody = await detailsResponse.text();
		expect(detailsResponse.status).toBe(200);
		expect(detailsBody).toContain('"content":"Recovered checkpoint."');
		expect(detailsBody).toContain('"status":"interrupted"');
		expect(detailsBody).toContain('"interruptionCause":"server-restart"');
		expect(detailsBody).not.toContain("Recovered reasoning.");
	});
});
