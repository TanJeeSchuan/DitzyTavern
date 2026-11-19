import { profile as chatProfile, sseReply } from "./prompt-preset-test-fixtures";
import { emptyPromptChannels } from "../../shared/definition";
import { readTestConversationSnapshot, pairChat } from "../test-fixtures/conversation";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createConnectionSettingsModule } from "../connection-settings";
import { createConversationRoutes } from "./conversation";

const key = new Uint8Array(32).fill(31);
const prompt = {
	...emptyPromptChannels(),
	systemInstruction: "Continue carefully.",
	identity: "I am {{self}}.",
	scenario: "A quiet room.",
};
const profile = { ...chatProfile, requestUrl: "http://127.0.0.1:43127/v1/", systemPlacement: "strict" } satisfies typeof chatProfile;


describe("Continuation transport contract", () => {
	let database: Database;

	beforeEach(() => {
		database = openObservedDatabase();
	});
	afterEach(() => database.close());

	test("accepts Continue without a human Message and uses the instruction strategy", async () => {
		const conversation = pairChat(database, "Continuation Contract", {
			prompt,
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
			fetch: async () => sseReply([{ content: "Continued." }]),
		});
		const acceptedResponse = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ kind: "continuation",  expectedRevision: conversation.revision }),
			},
		));
		// SAFETY: this contract test controls the typed acceptance response.
		const accepted = await acceptedResponse.json() as { generationId: number };
		const response = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
		));
		const body = await response.text();
		const after = readTestConversationSnapshot(database, conversation.id);
		expect(acceptedResponse.status).toBe(200);
		expect(response.status).toBe(200);
		expect(body).toContain('"outcome":"applied"');
		expect(after?.messages).toHaveLength(2);
		expect(after?.messages.at(-1)?.variants[0]?.content).toBe("Continued.");
	});
});
