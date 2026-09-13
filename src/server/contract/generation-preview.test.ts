import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConversationModule } from "../conversation";
import { createConversationRoutes } from "./conversation";
import { captureModelFetch, withProfile } from "./prompt-preset-test-fixtures";
import {
	clearGenerationPreviewRegistry,
} from "../workflows/generation-preview";
import type {
	GenerationPreview,
	GenerationPreviewBody,
} from "../../shared/contract/conversation-schema";

const prompt = {
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
};

const createChat = (database: Database) => createConversationModule(database).create({
	name: "Preview Chat",
	participants: [
		{ definition: { name: "Writer", prompt, openings: [] } },
		{ definition: { name: "Maren", prompt, openings: [] } },
	],
	control: { human: 0, model: 1 },
});

const preview = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
	body: GenerationPreviewBody,
) => {
	const response = await app.handle(new Request(
		`http://localhost/api/conversations/${conversationId}/generations/preview`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	));
	expect(response.status).toBe(200);
	// ==[HUMAN APPROVED]== SAFETY: the route validated this response against the preview schema.
	return await response.json() as Pick<GenerationPreview, "previewId" | "promptPlan">;
};

type PreviewRequestBody = GenerationPreviewBody | { kind: "send" } | { kind: "sibling" };

const previewResponse = (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
	body: PreviewRequestBody,
) => app.handle(new Request(
	`http://localhost/api/conversations/${conversationId}/generations/preview`,
	{
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	},
));

const readVariantData = (database: Database) => {
	// ==[HUMAN APPROVED]== SAFETY: this fixture selects the three scalar columns asserted below.
	return database.query("SELECT namespace, key, value FROM message_variant_data").all() as { namespace: string; key: string; value: string }[];
};

describe("Prompt Plan inspection", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => {
		setSystemTime();
		clearGenerationPreviewRegistry();
		database.close();
	});

	test("presents recoverable preview failures with their domain reason", async () => {
		const module = createConversationModule(database);
		const incomplete = module.create({
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
		const playable = createChat(database);
		const siblingUnavailable = module.create({
			name: "Imported Preview Chat",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
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
		const conversation = createChat(database);
		const app = createConversationRoutes(database);
		expect((await previewResponse(app, conversation.id, { kind: "send" })).status).toBe(422);
		expect((await previewResponse(app, conversation.id, { kind: "sibling" })).status).toBe(422);
	});

	test("sends the edited plan literally and preserves expansion-time writes", async () => {
		const originalRandom = Math.random;
		Math.random = () => 0.3;
		try {
			const conversation = createChat(database);
			database.query("UPDATE participant_prompt SET system_instruction = ? WHERE participant_id = ?")
				.run("Rolled 7 {{setvar::rollResult::{{roll::1d20}}}}", conversation.cast[1]!.id);
			withProfile(database);
			let captured: { messages: { role: string; content: string }[] } | undefined;
			const app = createConversationRoutes(database, {
				masterKey: new Uint8Array(32).fill(11),
				fetch: captureModelFetch((request) => { captured = request; }),
			});
			const plan = await preview(app, conversation.id, { kind: "send", content: "hello" });
			expect(readVariantData(database).some((row) => row.namespace === "prompt-macro")).toBe(false);
			const edited = {
				...plan.promptPlan,
				blocks: plan.promptPlan.blocks.map((block) => block.kind === "system-instruction"
					? { ...block, content: "Rolled 18 {{roll::1d20}}" }
					: block),
			};
			const started = await app.handle(new Request(
				`http://localhost/api/conversations/${conversation.id}/generations`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						expectedRevision: conversation.revision,
						content: "hello",
						previewId: plan.previewId,
						promptPlan: edited,
					}),
				},
			));
			expect(started.status).toBe(200);
			// ==[HUMAN APPROVED]== SAFETY: the acceptance response is the route's generation contract.
			const accepted = await started.json() as { generationId: number };
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(captured?.messages).toContainEqual({
				role: "system",
				content: "Rolled 18 {{roll::1d20}}",
			});
			await (await app.handle(new Request(
				`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
			))).text();
			expect(readVariantData(database).some((row) => row.namespace === "prompt-macro" && JSON.parse(row.value).some((write: { value?: unknown }) => write.value === "7"))).toBe(true);
		} finally {
			Math.random = originalRandom;
		}
	});

	test("rejects a stale Definition while tolerating an unrelated cast addition", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const app = createConversationRoutes(database, { masterKey: new Uint8Array(32).fill(11), fetch: captureModelFetch(() => {}) });
		const plan = await preview(app, conversation.id, { kind: "send", content: "hello" });
		const module = createConversationModule(database);
		module.execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: { type: "add-participant", definition: { name: "Extra", prompt, openings: [] } },
		});
		const accepted = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				// Preview sends use the server's narrow revision read; the client may still hold
				// the revision from before an unrelated edit.
				body: JSON.stringify({ expectedRevision: conversation.revision, content: "hello", previewId: plan.previewId }),
			},
		));
		expect(accepted.status).toBe(200);
	});

	test("does not apply a plan edit that exceeds the captured context ceiling", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const app = createConversationRoutes(database, { masterKey: new Uint8Array(32).fill(11), fetch: async () => new Response() });
		const plan = await preview(app, conversation.id, { kind: "send", content: "hello" });
		const edited = {
			...plan.promptPlan,
			blocks: plan.promptPlan.blocks.map((block) => ({
				...block,
				content: "x".repeat(500_000),
			})),
		};
		const rejected = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversation.revision, content: "hello", previewId: plan.previewId, promptPlan: edited }),
			},
		));
		expect(rejected.status).toBe(422);
	});

	test("keeps an inspected plan past the old quarter-hour window", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const app = createConversationRoutes(database, {
			masterKey: new Uint8Array(32).fill(11),
			fetch: captureModelFetch(() => {}),
		});
		const plan = await preview(app, conversation.id, { kind: "send", content: "hello" });
		setSystemTime(Date.now() + 15 * 60 * 1000 + 1);
		const started = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedRevision: conversation.revision,
					content: "hello",
					previewId: plan.previewId,
				}),
			},
		));
		expect(started.status).toBe(200);
	});

	test("requires a refresh after the process-local preview registry is cleared", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const app = createConversationRoutes(database, {
			masterKey: new Uint8Array(32).fill(11),
			fetch: captureModelFetch(() => {}),
		});
		const plan = await preview(app, conversation.id, { kind: "send", content: "hello" });
		clearGenerationPreviewRegistry();
		const started = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedRevision: conversation.revision,
					content: "hello",
					previewId: plan.previewId,
				}),
			},
		));
		expect(started.status).toBe(422);
		expect(await started.json()).toEqual({
			outcome: "invalid",
			reason: "The inspected Prompt Plan is unavailable. Refresh it after a server restart or when it has been abandoned.",
		});
	});

	test("keeps only the newest inspected plan for a Conversation", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const app = createConversationRoutes(database, {
			masterKey: new Uint8Array(32).fill(11),
			fetch: captureModelFetch(() => {}),
		});
		const first = await preview(app, conversation.id, { kind: "send", content: "first" });
		const second = await preview(app, conversation.id, { kind: "send", content: "second" });
		const rejected = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedRevision: conversation.revision,
					content: "first",
					previewId: first.previewId,
				}),
			},
		));
		expect(rejected.status).toBe(422);
		const accepted = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedRevision: conversation.revision,
					content: "second",
					previewId: second.previewId,
				}),
			},
		));
		expect(accepted.status).toBe(200);
	});

	test("keeps an ordinary Send preview valid when only the inactive Continuation instruction changes", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const app = createConversationRoutes(database, {
			masterKey: new Uint8Array(32).fill(11),
			fetch: captureModelFetch(() => {}),
		});
		const plan = await preview(app, conversation.id, { kind: "send", content: "hello" });
		const module = createConversationModule(database);
		const settings = module.getGenerationSettings(conversation.id);
		if (settings === undefined) throw new Error("Generation settings missing.");
		module.execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: {
				type: "update-generation-settings",
				settings: { ...settings, continuationInstruction: "A different instruction." },
			},
		});
		const current = module.getSummary(conversation.id);
		if (current === undefined) throw new Error("Conversation summary missing.");
		const accepted = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedRevision: current.revision,
					content: "hello",
					previewId: plan.previewId,
				}),
			},
		));
		expect(accepted.status).toBe(200);
	});

	test("keeps a preview valid when an unused Definition field changes", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const app = createConversationRoutes(database, {
			masterKey: new Uint8Array(32).fill(11),
			fetch: captureModelFetch(() => {}),
		});
		const plan = await preview(app, conversation.id, { kind: "send", content: "hello" });
		const module = createConversationModule(database);
		const human = module.getSnapshot(conversation.id)?.cast[0];
		if (human === undefined) throw new Error("Human Participant missing.");
		module.execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: {
				type: "replace-participant-prompt",
				participantId: human.id,
				prompt: { ...human.prompt, scenario: "Unused scenario." },
			},
		});
		const current = module.getSummary(conversation.id);
		if (current === undefined) throw new Error("Conversation summary missing.");
		const accepted = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedRevision: current.revision,
					content: "hello",
					previewId: plan.previewId,
				}),
			},
		));
		expect(accepted.status).toBe(200);
	});

	test("requires a refresh when selected history changes", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const app = createConversationRoutes(database, {
			masterKey: new Uint8Array(32).fill(11),
			fetch: captureModelFetch(() => {}),
		});
		const plan = await preview(app, conversation.id, { kind: "send", content: "hello" });
		const module = createConversationModule(database);
		module.execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: {
				type: "create-message",
				timestamp: "2026-09-13T00:00:00.000Z",
				variantContents: ["A changed direction."],
				authorParticipantId: conversation.cast[0]!.id,
			},
		});
		const current = module.getSummary(conversation.id);
		if (current === undefined) throw new Error("Conversation summary missing.");
		const rejected = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedRevision: current.revision,
					content: "hello",
					previewId: plan.previewId,
				}),
			},
		));
		expect(rejected.status).toBe(422);
	});
});
