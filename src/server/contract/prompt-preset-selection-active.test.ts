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



});
