import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { GenerationTarget } from "../../shared/contract/conversation-schema";
import { processStateFor } from "../application/process-state";
import { createConnectionSettingsModule } from "../connection-settings";
import { createConversationWithHistory, openObservedDatabase, pairChat } from "../test-fixtures/conversation";
import { createConversationRoutes } from "./conversation";
import { key, profile } from "./prompt-preset-test-fixtures";

type PreviewRequestTarget = GenerationTarget | { kind: "send" } | { kind: "sibling" };

const previewResponse = (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
	target: PreviewRequestTarget,
) => app.handle(new Request(
	`http://localhost/api/conversations/${conversationId}/generations/preview`,
	{
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ target }),
	},
));

describe("Prompt Plan inspection transport", () => {
	let database: Database;

	beforeEach(() => { database = openObservedDatabase(); });
	afterEach(() => {
		processStateFor(database).dispose();
		database.close();
	});

	test("previews with a draft Connection Profile whose request URL is empty", async () => {
		const conversation = pairChat(database, "Preview Chat");
		const connections = createConnectionSettingsModule(database, { masterKey: key });
		connections.createProfile({
			expectedRevision: connections.get().revision,
			profile: { ...profile, requestUrl: "" },
		});
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: async () => { throw new Error("Snapshot preview must not call a provider."); },
		});
		const response = await previewResponse(app, conversation.id, { kind: "send", content: "hello" });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			outcome: "available",
			conversationId: conversation.id,
			kind: "send",
			promptPlan: { blocks: expect.arrayContaining([expect.objectContaining({ kind: "history", role: "human", speakerName: "Writer", content: "hello" })]) },
		});
	});

	test("presents recoverable preview failures with their domain reason", async () => {
		const incomplete = createConversationWithHistory(database, {
			name: "Incomplete Preview Chat",
			messages: [{
				timestamp: "2026-09-13T00:00:00.000Z",
				variants: [{
					content: "Preserved",
					timestamp: "2026-09-13T00:00:00.000Z",
					selected: true,
				}],
			}],
		});
		const playable = pairChat(database, "Preview Chat");
		const siblingUnavailable = pairChat(database, "Imported Preview Chat", {
			messages: [{
				timestamp: "2026-09-13T00:00:00.000Z",
				variants: [{
					content: "Imported",
					timestamp: "2026-09-13T00:00:00.000Z",
					selected: true,
				}],
			}],
		});
		const importedMessage = siblingUnavailable.messages[0];
		if (importedMessage === undefined) throw new Error("Imported Message missing.");
		const app = createConversationRoutes(database);

		const notPlayable = await previewResponse(app, incomplete.id, { kind: "send", content: "hello" });
		expect(notPlayable.status).toBe(409);
		expect(await notPlayable.json()).toEqual({
			outcome: "not-playable",
			reason: `Conversation ${incomplete.id} is not playable: two distinct Participants must occupy the human and model seats.`,
		});

		const continuation = await previewResponse(app, playable.id, { kind: "continuation" });
		expect(continuation.status).toBe(422);
		expect(await continuation.json()).toEqual({
			outcome: "invalid",
			reason: "Continue is available only after a terminal model-authored Message.",
		});

		const sibling = await previewResponse(app, siblingUnavailable.id, {
			kind: "sibling",
			messageId: importedMessage.id,
		});
		expect(sibling.status).toBe(422);
		expect(await sibling.json()).toEqual({
			outcome: "invalid",
			reason: "A new sibling Variant cannot be generated: the target Message has no captured historical Control context.",
		});
	});

	test("rejects preview intents missing their required operand", async () => {
		const conversation = pairChat(database, "Preview Chat");
		const app = createConversationRoutes(database);
		for (const kind of ["send", "sibling"] as const) {
			const response = await previewResponse(app, conversation.id, { kind });
			expect(response.status).toBe(422);
			expect(await response.json()).toMatchObject({ type: "validation", on: "body" });
		}
	});
});
