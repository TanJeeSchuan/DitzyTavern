import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInitializedDatabase } from "../database/database";
import { createConnectionSettingsModule } from "../connection-settings";
import { createConversationModule } from "../conversation";
import { createConversationRoutes } from "./conversation";
import { createPromptPresetRoutes } from "./prompt-preset";
import type { ModelFetch } from "../model-client";
import type {
	ConversationPromptPreset,
	PromptPresetRecipe,
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
	requestUrl: "http://127.0.0.1:43129/v1/",
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

const createChat = (
	database: Database,
	names: { human?: string; model?: string } = {},
) =>
	createConversationModule(database).create({
		name: "Preset Chat",
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

const withProfile = (database: Database) =>
	createConnectionSettingsModule(database, { masterKey: key }).createProfile({
		expectedRevision: 0,
		profile,
		credential: "preset-secret",
	});

const readPreset = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
): Promise<ConversationPromptPreset> => {
	const response = await app.handle(
		new Request(`http://localhost/api/conversations/${conversationId}/prompt-preset`),
	);
	expect(response.status).toBe(200);
	// SAFETY: the route's response schema is the resolved preset payload.
	return await response.json() as ConversationPromptPreset;
};

const readOperation = async (operation: Promise<Response>): Promise<PromptPresetRecipe> => {
	const response = await operation;
	expect(response.status).toBe(200);
	// SAFETY: each recipe operation responds with the stored recipe as a fresh
	// read; this test controls the typed response.
	return await response.json() as PromptPresetRecipe;
};

const presetRoutes = (database: Database) => createPromptPresetRoutes(database);

const moveBlock = (
	database: Database,
	presetId: number,
	blockId: number,
	toPosition: number,
) =>
	presetRoutes(database).handle(
		new Request(`http://localhost/api/prompt-presets/${presetId}/blocks/${blockId}/move`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ toPosition }),
		}),
	);

const toggleBlock = (
	database: Database,
	presetId: number,
	blockId: number,
	enabled: boolean,
) =>
	presetRoutes(database).handle(
		new Request(`http://localhost/api/prompt-presets/${presetId}/blocks/${blockId}/toggle`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled }),
		}),
	);

const duplicateBlock = (database: Database, presetId: number, blockId: number) =>
	presetRoutes(database).handle(
		new Request(`http://localhost/api/prompt-presets/${presetId}/blocks/${blockId}/duplicate`,
			{ method: "POST" }),
	);

const setBlockRole = (
	database: Database,
	presetId: number,
	blockId: number,
	role: string,
) =>
	presetRoutes(database).handle(
		new Request(`http://localhost/api/prompt-presets/${presetId}/blocks/${blockId}/role`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ role }),
		}),
	);

interface RecipeSlot {
	id: number;
	reference: string;
	enabled: boolean;
	role?: string | null;
	sourceName?: string | null;
	content?: string;
	entryCount?: number;
	name?: string;
}

const slotOf = (
	recipe: { slots: RecipeSlot[] },
	reference: string,
	occurrence = 0,
) => recipe.slots.filter((slot) => slot.reference === reference)[occurrence];

// SAFETY: the controlled fake receives the AI SDK Chat Completions body and
// answers with a single completed delta.
const captureModelFetch = (
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
		// SAFETY: this test's fake owns the request body shape.
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

const startGeneration = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
	expectedRevision: number,
): Promise<number> => {
	const started = await app.handle(
		new Request(`http://localhost/api/conversations/${conversationId}/generations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ expectedRevision, content: "Set the scene." }),
		}),
	);
	expect(started.status).toBe(200);
	// SAFETY: this contract test controls the typed acceptance response.
	const accepted = await started.json() as { generationId: number };
	return accepted.generationId;
};

const readInspection = async (
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
	// SAFETY: the route's response schema is the active inspection payload.
	return await inspected.json() as {
		promptPlan: {
			blocks: { kind: string; content: string; role: string | null }[];
			warnings: { block: string; macro: string }[];
		};
		budget: { tokenEstimate: number };
	};
};

const completeGeneration = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
	generationId: number,
) => {
	await (await app.handle(new Request(
		`http://localhost/api/conversations/${conversationId}/generations/${generationId}/events`,
	))).text();
};

describe("Prompt Preset budget", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("estimates and inspection account for the actual assembled output, including deliberate repeats", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch(() => {}),
		});

		const generationId = await startGeneration(app, conversation.id, conversation.revision);
		const inspection = await readInspection(app, conversation.id, generationId);
		const singleEstimate = inspection.budget.tokenEstimate;
		expect(
			inspection.promptPlan.blocks.filter((block) => block.kind === "example-dialogue"),
		).toHaveLength(1);
		await completeGeneration(app, conversation.id, generationId);

		const preset = await readPreset(app, conversation.id);
		const example = slotOf(preset, "model-example-dialogue");
		if (example === undefined) throw new Error("The Default recipe has no Example Dialogue slot.");
		await readOperation(duplicateBlock(database, preset.id, example.id));

		const repeatedRevisionResponse = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}`),
		);
		// SAFETY: the route's response schema is the Conversation summary.
		const repeatedRevision = await repeatedRevisionResponse.json() as { revision: number };
		const repeatedGenerationId = await startGeneration(
			app,
			conversation.id,
			repeatedRevision.revision,
		);
		const repeatedInspection = await readInspection(app, conversation.id, repeatedGenerationId);
		expect(
			repeatedInspection.promptPlan.blocks.filter((block) => block.kind === "example-dialogue"),
		).toHaveLength(2);
		// The estimate counts the repeated content: the assembled output grew
		// and the budget decision follows the actual request.
		expect(repeatedInspection.budget.tokenEstimate).toBeGreaterThan(singleEstimate);
		await completeGeneration(app, conversation.id, repeatedGenerationId);
	});
});

describe("Prompt Preset capture", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

});

describe("Prompt Preset durability", () => {
	let directory: string;

	beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "ditzy-preset-")); });
	afterEach(async () => {
		// ==[HUMAN APPROVED]== Bun may release the final SQLite WAL handle asynchronously on Windows.
		for (let attempt = 0; attempt < 20; attempt += 1) {
			try {
				rmSync(directory, { recursive: true, force: true });
				return;
			} catch {
				await Bun.sleep(100);
			}
		}
		rmSync(directory, { recursive: true, force: true });
	});

	test("keeps the saved recipe edits and Chat selection across restarts", async () => {
		const path = join(directory, "preset.sqlite");
		const first = openInitializedDatabase({ path });
		const conversation = createChat(first);
		const app = createConversationRoutes(first);
		const preset = await readPreset(app, conversation.id);
		const example = slotOf(preset, "model-example-dialogue");
		const identity = slotOf(preset, "model-identity");
		if (example === undefined || identity === undefined) {
			throw new Error("The Default recipe is missing its reference slots.");
		}
		await readOperation(toggleBlock(first, preset.id, example.id, false));
		await readOperation(moveBlock(first, preset.id, identity.id, 1));
		first.close();

		const second = openInitializedDatabase({ path });
		try {
			const reread = await readPreset(createConversationRoutes(second), conversation.id);
			expect(reread.name).toBe("Default");
			expect(reread.slots.map((slot) => [slot.reference, slot.enabled])).toEqual([
				["model-identity", true],
				["model-system-instruction", true],
				["human-identity", true],
				["model-scenario", true],
				["model-example-dialogue", false],
				["history", true],
				["model-post-history-instruction", true],
			]);
			expect(second.query("SELECT COUNT(*) AS total FROM prompt_preset").get())
				.toEqual({ total: 1 });
		} finally {
			second.close();
		}
	});
});
