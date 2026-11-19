import { profile as chatProfile, sseReply } from "./prompt-preset-test-fixtures";
import { readTestConversationSnapshot, shortReplyPrompt, pairChat } from "../test-fixtures/conversation";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createConnectionSettingsModule } from "../connection-settings";
import { createConversationRoutes } from "./conversation";

const prompt = shortReplyPrompt();

const profile = { ...chatProfile, displayName: "Send test profile", requestUrl: "http://127.0.0.1:43127/v1/", systemPlacement: "strict" } satisfies typeof chatProfile;


describe("Send generation transport", () => {
	let database: Database;

	beforeEach(() => {
		database = openObservedDatabase();
	});
	afterEach(() => database.close());

	test("provider response bodies and request details never enter Generation HTTP or SSE errors", async () => {
		const conversation = pairChat(database, "Safe provider failure contract", { prompt });
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
				body: JSON.stringify({ kind: "send",  expectedRevision: conversation.revision, content: "Fail safely." }),
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
		const conversation = pairChat(database, "Safe finish contract", { prompt });
		const masterKey = new Uint8Array(32).fill(18);
		createConnectionSettingsModule(database, { masterKey }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "finish-credential-do-not-expose",
		});
		const rawFinishReason = "https://secret.endpoint X-Secret=header-do-not-expose arbitrary-provider-text";
		const app = createConversationRoutes(database, {
			masterKey,
			fetch: async () => sseReply([{ content: "Safe answer." }], { finish: { reason: rawFinishReason } }),
		});
		const acceptedResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ kind: "send",  expectedRevision: conversation.revision, content: "Finish safely." }),
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
		const conversation = pairChat(database, "Length-limited Send contract", { prompt });
		const masterKey = new Uint8Array(32).fill(12);
		createConnectionSettingsModule(database, { masterKey }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "length-contract-secret",
		});
		const app = createConversationRoutes(database, {
			masterKey,
			fetch: async () => sseReply([{ content: "Bounded response." }], { finish: { reason: "length" } }),
		});

		const acceptedResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ kind: "send",  expectedRevision: conversation.revision, content: "Use the full response budget." }),
			},
		));
		// SAFETY: this contract test controls the typed acceptance response.
		const accepted = await acceptedResponse.json() as { generationId: number };
		const eventsResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
		));
		const events = await eventsResponse.text();
		const snapshot = readTestConversationSnapshot(database, conversation.id);
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
