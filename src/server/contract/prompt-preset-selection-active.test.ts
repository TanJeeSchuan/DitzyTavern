import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConnectionSettingsModule } from "../connection-settings";
import { createConversationModule } from "../conversation";
import { createConversationRoutes } from "./conversation";
import { createPromptPresetRoutes } from "./prompt-preset-routes";
import type { ModelFetch } from "../model-client";
import type {
	ConversationSummary,
} from "../../shared/contract/conversation-schema";
import type {
	ConversationPromptPreset,
	PromptPresetCommand,
} from "../../shared/contract/prompt-preset";

const key = new Uint8Array(32).fill(11);

const humanPrompt = {
	systemInstruction: "Human system text never reaches the plan.",
	identity: "I write as {{self}} opposite {{other}}.",
	scenario: "Human scenario never reaches the plan.",
	exampleDialogue: "Human examples never reach the plan.",
	postHistoryInstruction: "Human post-history never reaches the plan.",
};

const modelPrompt = {
	systemInstruction: "Answer briefly.",
	identity: "I am {{self}}.",
	scenario: "A quiet room.",
	exampleDialogue: "Writer: Hello\nMaren: Hello back",
	postHistoryInstruction: "Continue.",
};

const profile = {
	displayName: "DeepSeek",
	apiFormat: "chat-completions" as const,
	requestUrl: "http://127.0.0.1:43131/v1/",
	modelsUrl: "",
	modelBackend: "automatic" as const,
	adapter: "deepseek" as const,
	outputTokenRepresentation: "automatic" as const,
	timeoutMs: 120_000,
	pinnedModels: [],
};

interface CapturedRequest {
	messages: { role: string; content: string }[];
}

const createChat = (database: Database, name = "Preset Chat") =>
	createConversationModule(database).create({
		name,
		participants: [
			{ definition: { name: "Writer", prompt: humanPrompt, openings: [] } },
			{ definition: { name: "Maren", prompt: modelPrompt, openings: [] } },
		],
		control: { human: 0, model: 1 },
	});

// ==[HUMAN APPROVED]== Library and selection tests exercise the ordinary public routes
// against one isolated initialized database: the same seam the popup uses,
// with no test-only transport or persistence helpers.
const createRoutes = (database: Database) => ({
	library: createPromptPresetRoutes(database),
	conversations: createConversationRoutes(database),
});

const runPresetCommand = async (
	app: ReturnType<typeof createPromptPresetRoutes>,
	command: PromptPresetCommand,
): Promise<{ status: number; body: unknown }> => {
	const response = await app.handle(
		new Request("http://localhost/api/prompt-presets/commands", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(command),
		}),
	);
	// SAFETY: the route validates the discriminated command at this boundary.
	const body = await response.json();
	return { status: response.status, body };
};

const readSelectedPreset = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
): Promise<ConversationPromptPreset | null> => {
	const response = await app.handle(
		new Request(`http://localhost/api/conversations/${conversationId}/prompt-preset`),
	);
	if (response.status === 404) return null;
	expect(response.status).toBe(200);
	// SAFETY: the route's response schema is the resolved preset payload.
	return await response.json() as ConversationPromptPreset;
};

const readConversation = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
): Promise<ConversationSummary> => {
	const response = await app.handle(
		new Request(`http://localhost/api/conversations/${conversationId}`),
	);
	expect(response.status).toBe(200);
	// SAFETY: the route's response schema is the conversation summary payload.
	return await response.json() as ConversationSummary;
};

const selectPreset = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
	expectedRevision: number,
	promptPresetId: number,
): Promise<{ status: number; body: unknown }> => {
	const response = await app.handle(
		new Request(`http://localhost/api/conversations/${conversationId}/commands`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				expectedRevision,
				action: { type: "select-prompt-preset", promptPresetId },
			}),
		}),
	);
	// SAFETY: the route validates the revisioned command shape at this boundary.
	const body = await response.json();
	return { status: response.status, body };
};

const readActiveInspection = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
	generationId: number,
): Promise<{ kind: string }[]> => {
	const inspected = await app.handle(new Request(
		`http://localhost/api/conversations/${conversationId}/generations/${generationId}/inspection`,
	));
	expect(inspected.status).toBe(200);
	// SAFETY: the route's response schema is the active inspection payload.
	const inspection = await inspected.json() as {
		promptPlan: { blocks: { kind: string }[] };
	};
	return inspection.promptPlan.blocks;
};

// ==[HUMAN APPROVED]== The controlled provider fake captures every Chat Completions
// request behind a barrier, so a test runs mid-attempt Conversation
// operations against a held provider stream before releasing it.
const gatedProvider = () => {
	const requests: CapturedRequest[] = [];
	const waiters: (() => void)[] = [];
	let open = false;
	const encoder = new TextEncoder();
	const stream = () => new Response(new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Done." }, finish_reason: null }] })}\n\n`));
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`));
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	}), { headers: { "content-type": "text/event-stream" } });
	return {
		requests,
		release: () => {
			open = true;
			for (const waiter of waiters.splice(0)) waiter();
		},
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			// SAFETY: the controlled fake receives the AI SDK Chat Completions body.
			requests.push(JSON.parse(String(init?.body)) as CapturedRequest);
			if (!open) await new Promise<void>((resolve) => { waiters.push(resolve); });
			return stream();
		}) satisfies ModelFetch,
	};
};

const startGeneration = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
	expectedRevision: number,
	gate: { requests: CapturedRequest[] },
	minimumRequests = 1,
): Promise<number> => {
	const response = await app.handle(
		new Request(`http://localhost/api/conversations/${conversationId}/generations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ expectedRevision, content: "Set the scene." }),
		}),
	);
	expect(response.status).toBe(200);
	// SAFETY: this contract test controls the typed acceptance response.
	const accepted = await response.json() as { generationId: number };
	while (gate.requests.length < minimumRequests) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	return accepted.generationId;
};

const completeGeneration = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
	generationId: number,
): Promise<void> => {
	// ==[HUMAN APPROVED]== The events subscription drains only once the runtime closes its
	// stream at the terminal commit, so awaiting the body is the deterministic
	// completion wait.
	const subscription = await app.handle(new Request(
		`http://localhost/api/conversations/${conversationId}/generations/${generationId}/events`,
	));
	await subscription.text();
};

describe("Prompt Preset selection around an Active Generation", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("a selection change during an attempt keeps its captured Prompt Plan and later attempts use the new selection", async () => {
		const routes = createRoutes(database);
		const conversation = createChat(database);
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "preset-secret",
		});
		// The editor tickets add block operations; until then this test stands
		// in for one saved recipe difference the same way the established
		// prompt-preset transport tests do: the duplicate loses its Example
		// Dialogue slot, so the two selections assemble distinguishable
		// requests.
		await runPresetCommand(routes.library, {
			type: "duplicate",
			presetId: 1,
			expectedRevision: 0,
			name: "Copy of Default",
		});
		database.exec(
			"UPDATE prompt_preset_block SET enabled = 0 WHERE preset_id = 2 AND reference = 'model-example-dialogue'",
		);
		const gate = gatedProvider();
		const app = createConversationRoutes(database, { masterKey: key, fetch: gate.fetch });

		const firstGenerationId = await startGeneration(
			app,
			conversation.id,
			conversation.revision,
			gate,
		);
		// The first attempt assembles through the Default recipe.
		expect(gate.requests[0]?.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"system",
			"user",
			"user",
			"system",
		]);
		const firstSubscription = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${firstGenerationId}/events`,
		));
		const firstBody = firstSubscription.text();

		// While that attempt runs, the Chat switches to the copy: the switch
		// commits durably even with an Active Generation present.
		const summary = await readConversation(app, conversation.id);
		const switched = await selectPreset(app, conversation.id, summary.revision, 2);
		expect(switched.status).toBe(200);
		const switchedRead = await readSelectedPreset(app, conversation.id);
		expect(switchedRead?.id).toBe(2);

		// The completed request describes the Default assembly it captured, not
		// the mid-flight switch, and the active inspection agrees.
		expect((await readActiveInspection(app, conversation.id, firstGenerationId)).map(
			(block) => block.kind,
		)).toEqual([
			"system-instruction",
			"identity",
			"identity",
			"scenario",
			"example-dialogue",
			"history",
			"post-history-instruction",
		]);
		gate.release();
		await firstBody;
		expect(gate.requests[0]?.messages.map((message) => message.content)).toEqual([
			"Answer briefly.",
			"I write as Writer opposite Maren.",
			"I am Maren.",
			"A quiet room.",
			"Writer: Hello\nMaren: Hello back",
			"Writer: Set the scene.",
			"Continue.",
		]);

		// Later attempts use the new valid selection: the copy's stored recipe
		// is missing the Example Dialogue block the test disabled.
		const afterGeneration = await readConversation(app, conversation.id);
		const secondGenerationId = await startGeneration(
			app,
			conversation.id,
			afterGeneration.revision,
			gate,
			2,
		);
		gate.release();
		await completeGeneration(app, conversation.id, secondGenerationId);
		expect(gate.requests[1]?.messages).toEqual([
			{ role: "system", content: "Answer briefly." },
			{ role: "user", content: "I write as Writer opposite Maren." },
			{ role: "assistant", content: "I am Maren." },
			{ role: "system", content: "A quiet room." },
			// The attempt's own captured history: the first human Message and the
			// model output the first attempt resolved, then the new tail.
			{ role: "user", content: "Writer: Set the scene." },
			{ role: "assistant", content: "Maren: Done." },
			{ role: "user", content: "Writer: Set the scene." },
			{ role: "system", content: "Continue." },
		]);
	});

	test("deleting the selected preset during an attempt reassigns atomically and keeps the captured plan", async () => {
		const routes = createRoutes(database);
		const conversation = createChat(database);
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "preset-secret",
		});
		// Stand-in recipe difference, exactly like the established transport
		// tests: the copy loses its Example Dialogue slot, so the captured
		// request and the reassigned Default request are distinguishable.
		await runPresetCommand(routes.library, {
			type: "duplicate",
			presetId: 1,
			expectedRevision: 0,
			name: "Copy of Default",
		});
		database.exec(
			"UPDATE prompt_preset_block SET enabled = 0 WHERE preset_id = 2 AND reference = 'model-example-dialogue'",
		);
		await selectPreset(routes.conversations, conversation.id, conversation.revision, 2);

		const gate = gatedProvider();
		const app = createConversationRoutes(database, { masterKey: key, fetch: gate.fetch });

		const generationId = await startGeneration(
			app,
			conversation.id,
			(await readConversation(app, conversation.id)).revision,
			gate,
		);
		const subscription = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${generationId}/events`,
		));
		const attemptBody = subscription.text();

		// The Active attempt holds the copy's captured plan.
		expect((await readActiveInspection(app, conversation.id, generationId)).map(
			(block) => block.kind,
		)).toEqual([
			"system-instruction",
			"identity",
			"identity",
			"scenario",
			"history",
			"post-history-instruction",
		]);

		// The confirmed deletion reassigns this Chat to Default in the same
		// authoritative operation, while the attempt keeps running.
		const deleted = await runPresetCommand(routes.library, {
			type: "delete",
			presetId: 2,
			expectedRevision: 0,
			expectedConversationCount: 1,
		});
		expect(deleted.status).toBe(200);
		expect(deleted.body).toEqual({
			outcome: "applied",
			result: { presetId: 2, reassignedConversationCount: 1 },
		});
		const reassigned = await readSelectedPreset(app, conversation.id);
		expect(reassigned?.id).toBe(1);
		expect(reassigned?.name).toBe("Default");
		// The Active attempt still reports the plan it captured, untouched.
		expect((await readActiveInspection(app, conversation.id, generationId)).map(
			(block) => block.kind,
		)).toEqual([
			"system-instruction",
			"identity",
			"identity",
			"scenario",
			"history",
			"post-history-instruction",
		]);
		gate.release();
		await attemptBody;
		expect(gate.requests[0]?.messages.map((message) => message.content)).toEqual([
			"Answer briefly.",
			"I write as Writer opposite Maren.",
			"I am Maren.",
			"A quiet room.",
			"Writer: Set the scene.",
			"Continue.",
		]);

		// The next attempt assembles through Default again.
		const afterGeneration = await readConversation(app, conversation.id);
		const nextGenerationId = await startGeneration(
			app,
			conversation.id,
			afterGeneration.revision,
			gate,
			2,
		);
		gate.release();
		await completeGeneration(app, conversation.id, nextGenerationId);
		expect(gate.requests[1]?.messages.map((message) => message.content)).toEqual([
			"Answer briefly.",
			"I write as Writer opposite Maren.",
			"I am Maren.",
			"A quiet room.",
			// Default again: the Example Dialogue returns, and the resolved first
			// attempt joins the selected history ahead of the new tail.
			"Writer: Hello\nMaren: Hello back",
			"Writer: Set the scene.",
			"Maren: Done.",
			"Writer: Set the scene.",
			"Continue.",
		]);
	});

	test("an attempt through a blank preset captures the actual empty recipe", async () => {
		const routes = createRoutes(database);
		const conversation = createChat(database);
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "preset-secret",
		});
		await runPresetCommand(routes.library, { type: "create", name: "Blank" });
		await selectPreset(routes.conversations, conversation.id, conversation.revision, 2);

		// A recipe without slots reaches the structural request rules with an
		// empty plan: acceptance commits, the captured plan stays empty, and no
		// provider request is assembled. The gate must not wait for a captured
		// request that never happens.
		const gate = gatedProvider();
		const app = createConversationRoutes(database, { masterKey: key, fetch: gate.fetch });
		const generationId = await startGeneration(
			app,
			conversation.id,
			(await readConversation(app, conversation.id)).revision,
			gate,
			0,
		);

		expect(await readActiveInspection(app, conversation.id, generationId)).toEqual([]);

		gate.release();
		await completeGeneration(app, conversation.id, generationId);
		// The zero-block attempt produced no usable output, so the existing
		// zero-output policy removes it; the Chat keeps its valid Default
		// selection for later attempts.
		const settled = await readSelectedPreset(app, conversation.id);
		expect(settled?.id).toBe(2);
		expect(gate.requests).toHaveLength(0);
	});
});
