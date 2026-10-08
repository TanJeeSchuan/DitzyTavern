import { expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { createConnectionSettingsModule } from "../connection-settings";
import { createMemorySettingsModule } from "../memory/settings";
import { createConversationModule } from "../conversation";
import { createConversationRoutes } from "./conversation";
import { createPromptPresetRoutes } from "./prompt-preset-routes";
import { readPromptPresetRecipe } from "../prompt-preset";
import type { ModelFetch } from "../model-client";
import type {
	ConversationPromptPreset,
	NativePromptPreset,
	PromptOutgoingRole,
	PromptPresetBlockPatch,
	PromptPresetCommand,
	PromptPresetListResponse,
	PromptPresetRecipe,
	PromptPresetSummary,
} from "../../shared/contract/prompt-preset";
import type { ConversationSummary } from "../../shared/contract/conversation-schema";

// @approved
//  Shared Prompt Preset suite fixtures. The Prompt Preset transport suites
// mount the same public route groups against one isolated initialized
// database, so the setup they genuinely share lives here; each suite keeps
// its own local helpers where its concerns differ.
export const key = new Uint8Array(32).fill(11);

export const humanPrompt = {
	systemInstruction: "Human system text never reaches the plan.",
	identity: "I write as {{self}} opposite {{other}}.",
	scenario: "Human scenario never reaches the plan.",
	exampleDialogue: "Human examples never reach the plan.",
	postHistoryInstruction: "Human post-history never reaches the plan.",
};

export const modelPrompt = {
	systemInstruction: "Answer briefly.",
	identity: "I am {{self}}.",
	scenario: "A quiet room.",
	exampleDialogue: "Writer: Hello\nMaren: Hello back",
	postHistoryInstruction: "Continue.",
};

export const profile = {
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

export interface CapturedRequest {
	messages: { role: string; content: string }[];
}

export const createChat = (
	database: Database,
	names: { name?: string; human?: string; model?: string } = {},
) =>
	createConversationModule(database).create({
		authorNote: "",
		name: names.name ?? "Preset Chat",
		participants: [
			{
				definition: {
					name: names.human ?? "Writer",
					prompt: humanPrompt,
					openings: [],
				},
			},
			{
				definition: {
					name: names.model ?? "Maren",
					prompt: modelPrompt,
					openings: [],
				},
			},
		],
		control: { human: 0, model: 1 },
	});

export const withProfile = (database: Database) => {
	const settings = createConnectionSettingsModule(database, { masterKey: key });
	return settings.createProfile({ expectedRevision: settings.get().revision, profile, credential: "preset-secret" });
};

export const configureMemoryEmbeddings = (database: Database, endpoint: string, model: string) => {
	const connections = createConnectionSettingsModule(database, { masterKey: key });
	const displayName = `Embeddings ${new URL(endpoint).host}`;
	const created = connections.createProfile({
		expectedRevision: connections.get().revision,
		profile: { ...profile, displayName, apiFormat: "embeddings", requestUrl: endpoint, adapter: "openai-compatible", timeoutMs: 1_000 },
		credential: "embedding-secret",
	}).profiles.find((entry) => entry.displayName === displayName);
	if (!created) throw new Error("Embeddings Connection Profile fixture failed.");
	const memory = createMemorySettingsModule(database);
	const { revision, ...settings } = memory.get();
	return memory.apply({ ...settings, expectedRevision: revision, embeddingProfileId: created.id, embeddingModel: model });
};

// @approved
//  Library and selection tests exercise the ordinary public routes
// against one isolated initialized database: the same seam the popup uses,
// with no test-only transport or persistence helpers.
export const createRoutes = (database: Database) => ({
	library: createPromptPresetRoutes(database),
	conversations: createConversationRoutes(database),
});

export const recipeRoutes = (database: Database) => createPromptPresetRoutes(database);

export const libraryRoutes = (database: Database) => createPromptPresetRoutes(database);

export const conversationApp = (
	database: Database,
	options: Parameters<typeof createConversationRoutes>[1] = {},
) => createConversationRoutes(database, options);

export const listPresets = async (
	app: ReturnType<typeof createPromptPresetRoutes>,
): Promise<PromptPresetSummary[]> => {
	const response = await app.handle(new Request("http://localhost/api/prompt-presets"));
	expect(response.status).toBe(200);
	// @approved
	//  SAFETY: the route's response schema is the library list payload.
	const payload = await response.json() as PromptPresetListResponse;
	return payload.presets;
};

export const exportPreset = async (
	app: ReturnType<typeof createPromptPresetRoutes>,
	presetId: number,
): Promise<NativePromptPreset> => {
	const response = await app.handle(
		new Request(`http://localhost/api/prompt-presets/${presetId}/export`),
	);
	expect(response.status).toBe(200);
	// @approved
	//  SAFETY: the route's response schema is the native interchange payload.
	return await response.json() as NativePromptPreset;
};

export type NativePromptPresetRequest = {
	name: string;
	slots: Array<{
		reference: string;
		enabled: boolean;
		role?: string | null;
		name?: string;
		content?: string;
	}>;
};

export const importPreset = async (
	app: ReturnType<typeof createPromptPresetRoutes>,
	native: NativePromptPresetRequest,
): Promise<{ status: number; body: unknown }> => {
	const response = await app.handle(
		new Request("http://localhost/api/prompt-presets/import", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(native),
		}),
	);
	return { status: response.status, body: await response.json() };
};

export const runPresetCommand = async (
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
	// @approved
	//  SAFETY: the route validates the discriminated command at this boundary.
	const body = await response.json();
	return { status: response.status, body };
};

export const readSelectedPreset = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
): Promise<ConversationPromptPreset | null> => {
	const response = await app.handle(
		new Request(`http://localhost/api/conversations/${conversationId}/prompt-preset`),
	);
	if (response.status === 404) return null;
	expect(response.status).toBe(200);
	// @approved
	//  SAFETY: the route's response schema is the resolved preset payload.
	return await response.json() as ConversationPromptPreset;
};

export const readConversation = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
): Promise<ConversationSummary> => {
	const response = await app.handle(
		new Request(`http://localhost/api/conversations/${conversationId}`),
	);
	expect(response.status).toBe(200);
	// @approved
	//  SAFETY: the route's response schema is the conversation summary payload.
	return await response.json() as ConversationSummary;
};

export const selectPreset = async (
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
	// @approved
	//  SAFETY: the route validates the revisioned command shape at this boundary.
	const body = await response.json();
	return { status: response.status, body };
};

export const readActiveInspection = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
	generationId: number,
): Promise<{ kind: string }[]> => {
	const inspected = await app.handle(new Request(
		`http://localhost/api/conversations/${conversationId}/generations/${generationId}/inspection`,
	));
	expect(inspected.status).toBe(200);
	// @approved
	//  SAFETY: the route's response schema is the active inspection payload.
	const inspection = await inspected.json() as {
		promptPlan: { blocks: { kind: string }[] };
	};
	return inspection.promptPlan.blocks;
};

// @approved
//  The controlled provider fake captures every Chat Completions
// request behind a barrier, so a test runs mid-attempt Conversation
// operations against a held provider stream before releasing it.
export const gatedProvider = () => {
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
			// @approved
			//  SAFETY: the controlled fake receives the AI SDK Chat Completions body.
			requests.push(JSON.parse(String(init?.body)) as CapturedRequest);
			if (!open) await new Promise<void>((resolve) => { waiters.push(resolve); });
			return stream();
		}) satisfies ModelFetch,
	};
};

// @approved
//  SAFETY: the controlled fake receives the AI SDK Chat Completions body and
// answers with a single completed delta.
export const captureModelFetch = (
	onCapture: (captured: CapturedRequest) => void,
	waitFor?: Promise<void>,
): ModelFetch => {
	const encoder = new TextEncoder();
	const payload = [
		{ choices: [{ index: 0, delta: { content: "Done." }, finish_reason: null }] },
		{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	]
		.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
		.join("") + "data: [DONE]\n\n";
	return async (_input, init) => {
		// @approved
		//  SAFETY: this test's fake owns the request body shape.
		onCapture(JSON.parse(String(init?.body)) as CapturedRequest);
		return new Response(new ReadableStream({
			async start(controller) {
				if (waitFor !== undefined) await waitFor;
				controller.enqueue(encoder.encode(payload));
				controller.close();
			},
		}), { headers: { "content-type": "text/event-stream" } });
	};
};

export const startGeneration = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
	expectedRevision: number,
	gate?: { requests: CapturedRequest[] },
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
	// @approved
	//  SAFETY: this contract test controls the typed acceptance response.
	const accepted = await response.json() as { generationId: number };
	if (gate !== undefined) {
		while (gate.requests.length < minimumRequests) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}
	return accepted.generationId;
};

export const readInspection = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
	generationId: number,
) => {
	const inspected = await app.handle(
		new Request(
			`http://localhost/api/conversations/${conversationId}/generations/${generationId}/inspection`,
		),
	);
	expect(inspected.status).toBe(200);
	// @approved
	//  SAFETY: the route's response schema is the active inspection payload.
	return await inspected.json() as {
		promptPlan: {
			blocks: { kind: string; content: string; role: string | null }[];
			warnings: { block: string; macro: string }[];
		};
		budget: { tokenEstimate: number };
	};
};

export const completeGeneration = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
	generationId: number,
) => {
	await (await app.handle(new Request(
		`http://localhost/api/conversations/${conversationId}/generations/${generationId}/events`,
	))).text();
};

export const readPreset = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
): Promise<ConversationPromptPreset> => {
	const response = await app.handle(
		new Request(`http://localhost/api/conversations/${conversationId}/prompt-preset`),
	);
	expect(response.status).toBe(200);
	// @approved
	//  SAFETY: the route's response schema is the resolved preset payload.
	return await response.json() as ConversationPromptPreset;
};

export const readOperation = async (operation: Promise<Response>): Promise<void> => {
	const response = await operation;
	expect(response.status).toBe(200);
	// @approved
	//  SAFETY: every successful recipe mutation route returns the minimal
	// applied acknowledgment; tests read the authoritative recipe separately when needed.
	expect(await response.json()).toEqual({ outcome: "applied" });
};

export const readStoredRecipe = (database: Database, presetId: number): PromptPresetRecipe => {
	const recipe = readPromptPresetRecipe(database, presetId);
	if (recipe === undefined) throw new Error("The preset recipe is missing.");
	return recipe;
};

export const addBlock = (database: Database, presetId: number, reference: string) =>
	recipeRoutes(database).handle(
		new Request(`http://localhost/api/prompt-presets/${presetId}/blocks`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ reference }),
		}),
	);

export const moveBlock = (
	database: Database,
	presetId: number,
	blockId: number,
	toPosition: number,
) =>
	recipeRoutes(database).handle(
		new Request(`http://localhost/api/prompt-presets/${presetId}/blocks/${blockId}/move`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ toPosition }),
		}),
	);

export const toggleBlock = (
	database: Database,
	presetId: number,
	blockId: number,
	enabled: boolean,
) =>
	recipeRoutes(database).handle(
		new Request(`http://localhost/api/prompt-presets/${presetId}/blocks/${blockId}/toggle`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled }),
		}),
	);

export const duplicateBlock = (database: Database, presetId: number, blockId: number) =>
	recipeRoutes(database).handle(
		new Request(`http://localhost/api/prompt-presets/${presetId}/blocks/${blockId}/duplicate`,
		{ method: "POST" }),
	);

export const removeBlock = (database: Database, presetId: number, blockId: number) =>
	recipeRoutes(database).handle(
		new Request(`http://localhost/api/prompt-presets/${presetId}/blocks/${blockId}`, {
			method: "DELETE",
		}),
	);

export const saveBlockPatches = (
	database: Database,
	presetId: number,
	patches: PromptPresetBlockPatch[],
) =>
	recipeRoutes(database).handle(
		new Request(`http://localhost/api/prompt-presets/${presetId}/blocks/patches`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ patches }),
		}),
	);

// @approved
//  Individual Save and save-on-leave share one occurrence-addressed patch
// contract, so the fixtures submit single-element batches through the same
// route instead of dedicated role/content endpoints.
export const saveBlockRole = (
	database: Database,
	presetId: number,
	blockId: number,
	role: PromptOutgoingRole,
) =>
	saveBlockPatches(database, presetId, [{ occurrenceId: blockId, type: "role", role }]);

export const saveInstructionContent = (
	database: Database,
	presetId: number,
	blockId: number,
	content: { name: string; content: string; role: PromptOutgoingRole },
) =>
	saveBlockPatches(database, presetId, [{ ...content, occurrenceId: blockId, type: "content" }]);

export interface RecipeSlot {
	id: number;
	reference: string;
	enabled: boolean;
	role?: string | null;
	sourceName?: string | null;
	content?: string;
	entryCount?: number;
	name?: string;
}

export const slotOf = (
	recipe: { slots: RecipeSlot[] },
	reference: string,
	occurrence = 0,
) => recipe.slots.filter((slot) => slot.reference === reference)[occurrence];
