import { openObservedDatabase } from "../conversation/test-fixtures";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createConversationModule } from "../conversation";
import { createConversationRoutes } from "./conversation";
import { captureModelFetch, withProfile } from "./prompt-preset-test-fixtures";
import { configureDecisionModels } from "./decision-model-test-fixtures";
import { createConnectionSettingsModule } from "../connection-settings";
import { pngFixture } from "../image/image-fixtures";
import { uploadImage } from "../image";
import { formatImageReference } from "../../shared/image-reference";
import type {
	GenerationPreview,
	GenerationPreviewBody,
} from "../../shared/contract/conversation-schema";
import { processStateFor } from "../application/process-state";

const prompt = {
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
};

const siblingPrompt = { ...prompt, systemInstruction: "Answer briefly." };

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

	beforeEach(() => {
		database = openObservedDatabase();
	});
	afterEach(() => {
		setSystemTime();
		processStateFor(database).dispose();
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

	test("retries a failed edited Send with its plan and a fresh preview token", async () => {
		const conversation = createChat(database);
		database.query("UPDATE participant_prompt SET system_instruction = ? WHERE participant_id = ?")
			.run("Answer briefly.", conversation.cast[1]!.id);
		withProfile(database);
		const requests: Array<{ messages: { role: string; content: string }[] }> = [];
		const app = createConversationRoutes(database, {
			masterKey: new Uint8Array(32).fill(11),
			fetch: async (_url, init) => {
				// SAFETY: the controlled provider receives this test's Chat Completions request.
				requests.push(JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] });
				if (requests.length === 1) {
					return new Response(JSON.stringify({ error: { message: "unsupported image input" } }), { status: 400 });
				}
				return new Response([
					`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Recovered." }, finish_reason: null }] })}\n\n`,
					`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
					"data: [DONE]\n\n",
				].join(""), { headers: { "content-type": "text/event-stream" } });
			},
		});
		const body: GenerationPreviewBody = { kind: "send", content: "The next scene begins." };
		const firstPreview = await preview(app, conversation.id, body);
		const editedPlan = {
			...firstPreview.promptPlan,
			blocks: firstPreview.promptPlan.blocks.map((block) => block.kind === "system-instruction"
				? { ...block, content: "Writer-edited instruction." }
				: block),
		};
		const start = async (previewId: string, promptPlan: typeof editedPlan) => app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedRevision: createConversationModule(database).getRevision(conversation.id),
					content: body.content,
					previewId,
					promptPlan,
				}),
			},
		));
		const failed = await start(firstPreview.previewId, editedPlan);
		expect(failed.status).toBe(200);
		// SAFETY: the accepted start response carries the generation identifier.
		const failedGeneration = await failed.json() as { generationId: number };
		const failedEvents = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${failedGeneration.generationId}/events`,
		)).then((response) => response.text());
		expect(failedEvents).toContain("event: error");

		const retryPreview = await preview(app, conversation.id, body);
		expect(retryPreview.previewId).not.toBe(firstPreview.previewId);
		expect(retryPreview.promptPlan.blocks).toHaveLength(firstPreview.promptPlan.blocks.length);
		const retried = await start(retryPreview.previewId, editedPlan);
		expect(retried.status).toBe(200);
		// SAFETY: the accepted start response carries the generation identifier.
		const retriedGeneration = await retried.json() as { generationId: number };
		await (await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${retriedGeneration.generationId}/events`,
		))).text();
		expect(requests).toHaveLength(2);
		expect(requests[1]?.messages).toContainEqual({ role: "system", content: "Writer-edited instruction." });
	});

	test("keeps a preview valid after an unrelated cast addition", async () => {
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

	test.each(["plain", "missing", "stored"])("accepts an Image added to a %s text-only preview without charging image tokens", async (initial) => {
		const conversation = createChat(database);
		const connections = createConnectionSettingsModule(database, { masterKey: new Uint8Array(32).fill(11) });
		const profile = withProfile(database).profiles[0];
		if (profile === undefined) throw new Error("Connection Profile missing.");
		connections.setTextOnlyModel({ profileId: profile.id, modelId: "text-only", textOnly: true });
		const module = createConversationModule(database);
		const generationSettings = module.getGenerationSettings(conversation.id);
		if (generationSettings === undefined) throw new Error("Generation settings missing.");
		module.execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: { type: "update-generation-settings", settings: {
				...generationSettings,
				modelId: "text-only",
				contextLimit: 2_000,
				responseBudget: 100,
				safetyAllowance: 0,
			} },
		});
		const image = await uploadImage(database, pngFixture({ width: 1568, height: 1568 }));
		if (image === undefined) throw new Error("Image fixture missing.");
		const reference = formatImageReference("map", image.hash);
		const content = initial === "plain" ? "Look" : `Look ${initial === "missing" ? formatImageReference("ghost", "f".repeat(64)) : reference}`;
		let captured: { messages: { role: string; content: string }[] } | undefined;
		const app = createConversationRoutes(database, {
			masterKey: new Uint8Array(32).fill(11),
			fetch: captureModelFetch((request) => { captured = request; }),
		});
		const plan = await preview(app, conversation.id, { kind: "send", content });
		const edited = {
			...plan.promptPlan,
			blocks: plan.promptPlan.blocks.map((block) => block.kind === "history" ? { ...block, content: `${block.content} ${reference}` } : block),
		};

		const accepted = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedRevision: module.getSummary(conversation.id)!.revision,
					content,

					previewId: plan.previewId,
					promptPlan: edited,
				}),
			},
		));
		expect(accepted.status).toBe(200);
		// SAFETY: the successful generation route validates this accepted response shape.
		const { generationId } = await accepted.json() as { generationId: number };
		await (await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations/${generationId}/events`))).text();
		expect(captured?.messages.find((message) => message.role === "user")?.content).toBe(`Writer: ${initial === "plain" ? "Look" : `Look [Image: ${initial === "missing" ? "ghost" : "map"}]`} [Image: map]`);
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
		// Simulates the restart drop through the container's one dispose path.
		processStateFor(database).dispose();
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

	test("consumes a Send preview token after acceptance", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const app = createConversationRoutes(database, {
			masterKey: new Uint8Array(32).fill(11),
			fetch: captureModelFetch(() => {}),
		});
		const plan = await preview(app, conversation.id, { kind: "send", content: "hello" });
		const request = () => app.handle(new Request(
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
		const accepted = await request();
		expect(accepted.status).toBe(200);
		// SAFETY: the route's acceptance response contains the generation ID used by the event route.
		const acceptedBody = await accepted.json() as { generationId: number };
		await (await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${acceptedBody.generationId}/events`,
		))).text();
		const reused = await request();
		expect(reused.status).toBe(422);
		expect(await reused.json()).toEqual({
			outcome: "invalid",
			reason: "The inspected Prompt Plan is unavailable. Refresh it after a server restart or when it has been abandoned.",
		});
	});

	test("keeps a preview token retryable after edited-plan validation fails", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const app = createConversationRoutes(database, {
			masterKey: new Uint8Array(32).fill(11),
			fetch: captureModelFetch(() => {}),
		});
		const plan = await preview(app, conversation.id, { kind: "send", content: "hello" });
		const invalid = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedRevision: conversation.revision,
					content: "hello",
					previewId: plan.previewId,
					promptPlan: { ...plan.promptPlan, blocks: [] },
				}),
			},
		));
		expect(invalid.status).toBe(422);
		expect(await invalid.json()).toEqual({
			outcome: "invalid",
			reason: "The edited Prompt Plan must keep its assembled blocks.",
		});

		const retried = await app.handle(new Request(
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
		expect(retried.status).toBe(200);
		// SAFETY: the route's acceptance response contains the generation ID used by the event route.
		const retriedBody = await retried.json() as { generationId: number };
		await (await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${retriedBody.generationId}/events`,
		))).text();
	});

	test("consumes a Sibling preview token after acceptance", async () => {
		const conversation = createConversationModule(database).create({
			name: "Sibling Preview Chat",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt: siblingPrompt, openings: ["Opening."] } },
			],
			control: { human: 0, model: 1 },
		});
		const target = conversation.messages[0];
		if (target === undefined) throw new Error("Sibling target missing.");
		withProfile(database);
		const app = createConversationRoutes(database, {
			masterKey: new Uint8Array(32).fill(11),
			fetch: captureModelFetch(() => {}),
		});
		const plan = await preview(app, conversation.id, {
			kind: "sibling",
			messageId: target.id,
		});
		const request = () => app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/messages/${target.id}/sibling/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ previewId: plan.previewId }),
			},
		));
		const accepted = await request();
		expect(accepted.status).toBe(200);
		// SAFETY: the route's acceptance response contains the generation ID used by the event route.
		const acceptedBody = await accepted.json() as { generationId: number };
		await (await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${acceptedBody.generationId}/events`,
		))).text();
		const reused = await request();
		expect(reused.status).toBe(422);
		expect(await reused.json()).toEqual({
			outcome: "invalid",
			reason: "The inspected Prompt Plan is unavailable. Refresh it after a server restart or when it has been abandoned.",
		});
	});

	test("keeps a Sibling preview token retryable after acceptance fails", async () => {
		const conversation = createConversationModule(database).create({
			name: "Retryable Sibling Preview Chat",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt: siblingPrompt, openings: ["Opening."] } },
			],
			control: { human: 0, model: 1 },
		});
		const target = conversation.messages[0];
		if (target === undefined) throw new Error("Sibling target missing.");
		const module = createConversationModule(database);
		const settings = module.getGenerationSettings(conversation.id);
		if (settings === undefined) throw new Error("Generation settings missing.");
		module.execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: {
				type: "update-generation-settings",
				settings: { ...settings, siblingGenerationLimit: 1 },
			},
		});
		withProfile(database);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let providerRequests = 0;
		const app = createConversationRoutes(database, {
			masterKey: new Uint8Array(32).fill(11),
			fetch: async () => {
				await gate;
				providerRequests += 1;
				const body = providerRequests === 1
					? "data: [DONE]\n\n"
					: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
				return new Response(body, { headers: { "content-type": "text/event-stream" } });
			},
		});
		const occupied = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/messages/${target.id}/sibling/generations`,
			{ method: "POST", body: "{}" },
		));
		expect(occupied.status).toBe(200);
		const plan = await preview(app, conversation.id, {
			kind: "sibling",
			messageId: target.id,
		});
		const request = () => app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/messages/${target.id}/sibling/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ previewId: plan.previewId }),
			},
		));
		const rejected = await request();
		expect(rejected.status).toBe(422);
		expect(await rejected.json()).toEqual({
			outcome: "invalid",
			reason: "The Conversation already has 1 active Sibling Generations at this response position.",
		});
		// SAFETY: the acceptance response contains the generation ID used to release the occupied sibling.
		const occupiedBody = await occupied.json() as { generationId: number };
		release();
		await (await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${occupiedBody.generationId}/events`,
		))).text();

		const retried = await request();
		expect(retried.status).toBe(200);
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

	test("requires a refresh when the inactive Continuation instruction changes", async () => {
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
		expect(await rejected.json()).toEqual({
			outcome: "invalid",
			reason: "The Prompt Plan is stale. Refresh it before sending.",
		});
	});

	test("requires a refresh when an unused Definition field changes", async () => {
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
		expect(await rejected.json()).toEqual({
			outcome: "invalid",
			reason: "The Prompt Plan is stale. Refresh it before sending.",
		});
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

	test("requires a refresh after replacing or clearing the Decision Model credential", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const masterKey = new Uint8Array(32).fill(11);
		const selection = configureDecisionModels(database, masterKey);
		const connections = createConnectionSettingsModule(database, { masterKey });
		const saveCredential = (credential: string) => credential ? connections.setCredential({ expectedRevision: connections.get().revision, profileId: selection.decisionProfileId, credential }) : connections.resetCredential({ expectedRevision: connections.get().revision, profileId: selection.decisionProfileId, confirmed: true });
		saveCredential("original-secret");
		const app = createConversationRoutes(database, { masterKey, fetch: captureModelFetch(() => {}) });
		for (const credential of ["replacement-secret", ""]) {
			const plan = await preview(app, conversation.id, { kind: "send", content: "hello" });
			saveCredential(credential);
			const rejected = await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversation.revision, content: "hello", previewId: plan.previewId }),
			}));
			expect(rejected.status).toBe(422);
			expect(await rejected.json()).toEqual({ outcome: "invalid", reason: "The Prompt Plan is stale. Refresh it before sending." });
		}
	});
});
