import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConnectionSettingsModule } from "../connection-settings";
import { createConversationModule } from "../conversation";
import { createConversationRoutes } from "./conversation";
import { createPromptPresetRoutes } from "./prompt-preset";
import {
	addPromptPresetInstruction,
	movePromptPresetBlock,
	InvalidPromptPresetOperationError,
	readPromptPresetRecipe,
} from "../prompt-preset";
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

const addBlock = (database: Database, presetId: number, reference: string) =>
	presetRoutes(database).handle(
		new Request(`http://localhost/api/prompt-presets/${presetId}/blocks`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ reference }),
		}),
	);

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

const removeBlock = (database: Database, presetId: number, blockId: number) =>
	presetRoutes(database).handle(
		new Request(`http://localhost/api/prompt-presets/${presetId}/blocks/${blockId}`, {
			method: "DELETE",
		}),
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

// ==[HUMAN APPROVED]== The owning module guards a move target the transport schema cannot
// deliver, so a direct caller cannot displace an occurrence either.
describe("Prompt Preset move bounds", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("rejects a move to position 0 with the typed invalid outcome", () => {
		createChat(database);
		expect(() => movePromptPresetBlock(database, 1, 1, 0)).toThrow(
			InvalidPromptPresetOperationError,
		);
	});
});

describe("Prompt Preset stored contract boundary", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("keeps empty authored text and rejects missing required instruction fields", () => {
		const recipe = addPromptPresetInstruction(database, 1);
		const instruction = recipe.slots.find((slot) => slot.reference === "instruction");
		if (instruction === undefined) throw new Error("The instruction fixture is missing.");

		database.exec(`UPDATE prompt_preset_block SET name = '', content = '' WHERE id = ${instruction.id}`);
		const empty = readPromptPresetRecipe(database, 1);
		const emptyInstruction = empty?.slots.find((slot) => slot.reference === "instruction");
		expect(emptyInstruction).toMatchObject({ name: "", content: "", role: "system" });

		database.exec(`UPDATE prompt_preset_block SET name = NULL WHERE id = ${instruction.id}`);
		expect(() => readPromptPresetRecipe(database, 1)).toThrow("has no name");

		database.exec(`UPDATE prompt_preset_block SET name = '', content = NULL WHERE id = ${instruction.id}`);
		expect(() => readPromptPresetRecipe(database, 1)).toThrow("has no content");

		database.exec(`UPDATE prompt_preset_block SET content = '', role = NULL WHERE id = ${instruction.id}`);
		expect(() => readPromptPresetRecipe(database, 1)).toThrow("has no supported outgoing role");
	});
});

describe("Prompt Preset transport", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("resolves the Default recipe against this Chat's own Participants", async () => {
		const conversation = createChat(database);
		const app = createConversationRoutes(database);

		const preset = await readPreset(app, conversation.id);

		expect(preset.name).toBe("Default");
		expect(preset.slots.map((slot) => slot.reference)).toEqual([
			"model-system-instruction",
			"human-identity",
			"model-identity",
			"model-scenario",
			"model-example-dialogue",
			"history",
			"model-post-history-instruction",
		]);
		expect(preset.slots.every((slot) => slot.enabled)).toBe(true);
		// Every occurrence carries its own identity for targeted operations.
		expect(new Set(preset.slots.map((slot) => slot.id)).size).toBe(preset.slots.length);
		// The recipe stores references, so each slot reads the Conversation-local
		// Definition of the Participant in that Control seat — including the
		// authored macro text, which the preset never stores rendered — and the
		// outgoing role the established assembly presents it with.
		const slots = (reference: string) =>
			preset.slots.filter((slot) => slot.reference === reference);
		expect(slots("human-identity")).toEqual([{
			id: expect.any(Number),
			reference: "human-identity",
			enabled: true,
			role: "user",
			sourceName: "Writer",
			content: "I write as {{self}} opposite {{other}}.",
		}]);
		expect(slots("model-identity")).toEqual([{
			id: expect.any(Number),
			reference: "model-identity",
			enabled: true,
			role: "assistant",
			sourceName: "Maren",
			content: "I am {{self}}.",
		}]);
		expect(slots("model-system-instruction")).toEqual([{
			id: expect.any(Number),
			reference: "model-system-instruction",
			enabled: true,
			role: "system",
			sourceName: "Maren",
			content: "Answer briefly.",
		}]);
		expect(slots("history")).toEqual([{
			id: expect.any(Number),
			reference: "history",
			enabled: true,
			entryCount: 0,
		}]);
	});

	test("returns not-found for a Conversation that does not exist", async () => {
		const app = createConversationRoutes(database);
		const response = await app.handle(
			new Request("http://localhost/api/conversations/424242/prompt-preset"),
		);
		expect(response.status).toBe(404);
	});

	test("assembles the outgoing request through the stored recipe and agrees with active inspection", async () => {
		const conversation = createChat(database);
		withProfile(database);
		let captured: CapturedRequest | undefined;
		let release = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch((request) => { captured = request; }, gate),
		});

		const generationId = await startGeneration(app, conversation.id, conversation.revision);
		while (captured === undefined) await new Promise((resolve) => setTimeout(resolve, 0));

		const inspection = await readInspection(app, conversation.id, generationId);

		// The Default recipe reproduces the established request: system text,
		// both Identity blocks under their roles, Scenario, Example Dialogue,
		// the selected history, then the Post-History Instruction.
		expect(captured?.messages).toEqual([
			{ role: "system", content: "Answer briefly." },
			{ role: "user", content: "I write as Writer opposite Maren." },
			{ role: "assistant", content: "I am Maren." },
			{ role: "system", content: "A quiet room." },
			{ role: "user", content: "Writer: Hello\nMaren: Hello back" },
			{ role: "user", content: "Writer: Set the scene." },
			{ role: "system", content: "Continue." },
		]);
		expect(inspection.promptPlan.blocks.map((block) => block.kind)).toEqual([
			"system-instruction",
			"identity",
			"identity",
			"scenario",
			"example-dialogue",
			"history",
			"post-history-instruction",
		]);

		release();
		await completeGeneration(app, conversation.id, generationId);
	});

	test("saved rearrangement, toggles, duplicates, additions and removals drive the assembled request and survive a fresh read", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const app = createConversationRoutes(database);
		const preset = await readPreset(app, conversation.id);
		const scenario = slotOf(preset, "model-scenario");
		const history = slotOf(preset, "history");
		const postHistory = slotOf(preset, "model-post-history-instruction");
		if (scenario === undefined || history === undefined || postHistory === undefined) {
			throw new Error("The Default recipe is missing its reference slots.");
		}

		// Disable the Scenario occurrence: it must vanish from the request
		// without being reinserted anywhere.
		const toggled = await readOperation(
			toggleBlock(database, preset.id, scenario.id, false),
		);
		expect(slotOf(toggled, "model-scenario")?.enabled).toBe(false);

		// Move the Post-History Instruction ahead of everything else.
		const moved = await readOperation(
			moveBlock(database, preset.id, postHistory.id, 1),
		);
		expect(moved.slots[0]?.reference).toBe("model-post-history-instruction");

		// Deliberately repeat the history slot right after itself.
		const duplicated = await readOperation(
			duplicateBlock(database, preset.id, history.id),
		);
		expect(duplicated.slots.map((slot) => slot.reference)).toEqual([
			"model-post-history-instruction",
			"model-system-instruction",
			"human-identity",
			"model-identity",
			"model-scenario",
			"model-example-dialogue",
			"history",
			"history",
		]);
		expect(slotOf(duplicated, "history", 0)?.id).not.toBe(slotOf(duplicated, "history", 1)?.id);

		// Add a fresh Scenario occurrence: a deliberate duplicate the recipe
		// keeps alongside the disabled original.
		const added = await readOperation(addBlock(database, preset.id, "model-scenario"));
		const addedSlot = added.slots.at(-1);
		expect(addedSlot?.reference).toBe("model-scenario");
		if (addedSlot?.reference !== "model-scenario") throw new Error("The added Scenario is missing.");
		expect(addedSlot.enabled).toBe(true);
		expect(addedSlot.role).toBe("system");

		// A fresh read reports exactly the saved state.
		const reread = await readPreset(app, conversation.id);
		expect(reread.slots.map((slot) => [slot.reference, slot.enabled])).toEqual([
			["model-post-history-instruction", true],
			["model-system-instruction", true],
			["human-identity", true],
			["model-identity", true],
			["model-scenario", false],
			["model-example-dialogue", true],
			["history", true],
			["history", true],
			["model-scenario", true],
		]);

		let captured: CapturedRequest | undefined;
		const generating = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch((request) => { captured = request; }),
		});
		const generationId = await startGeneration(generating, conversation.id, conversation.revision);
		await completeGeneration(generating, conversation.id, generationId);
		while (captured === undefined) await new Promise((resolve) => setTimeout(resolve, 0));

		// The request honors the saved order, the omitted slot, and the
		// deliberately repeated history and Scenario.
		expect(captured?.messages).toEqual([
			{ role: "system", content: "Continue." },
			{ role: "system", content: "Answer briefly." },
			{ role: "user", content: "I write as Writer opposite Maren." },
			{ role: "assistant", content: "I am Maren." },
			{ role: "user", content: "Writer: Hello\nMaren: Hello back" },
			{ role: "user", content: "Writer: Set the scene." },
			{ role: "user", content: "Writer: Set the scene." },
			{ role: "system", content: "A quiet room." },
		]);

		// Removing the added Scenario occurrence leaves the disabled original
		// and the repeated history exactly where they were.
		const addedForRemoval = added.slots.at(-1);
		if (addedForRemoval === undefined) throw new Error("The added slot disappeared.");
		const removed = await readOperation(
			removeBlock(database, preset.id, addedForRemoval.id),
		);
		expect(removed.slots.map((slot) => [slot.reference, slot.enabled])).toEqual([
			["model-post-history-instruction", true],
			["model-system-instruction", true],
			["human-identity", true],
			["model-identity", true],
			["model-scenario", false],
			["model-example-dialogue", true],
			["history", true],
			["history", true],
		]);
	});

	test("a saved outgoing role translates the referenced content in the model request", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const app = createConversationRoutes(database);
		const preset = await readPreset(app, conversation.id);
		const scenario = slotOf(preset, "model-scenario");
		const identity = slotOf(preset, "model-identity");
		if (scenario === undefined || identity === undefined) {
			throw new Error("The Default recipe is missing its reference slots.");
		}

		// The Scenario is presented as user content and the model Identity as
		// system content. The role is presentation only: the source text and
		// the Participant supplying it stay untouched.
		const withRoles = await readOperation(
			setBlockRole(database, preset.id, scenario.id, "user"),
		);
		const afterIdentity = await readOperation(
			setBlockRole(database, preset.id, identity.id, "system"),
		);
		expect(slotOf(withRoles, "model-scenario")?.role).toBe("user");
		expect(slotOf(afterIdentity, "model-identity")?.role).toBe("system");

		// The Participant Definition was never rewritten.
		const summaryResponse = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}`),
		);
		// SAFETY: the route's response schema is the Conversation summary.
		const summary = await summaryResponse.json() as {
			cast: { name: string; prompt: { identity: string; scenario: string } }[];
		};
		expect(summary.cast.find((participant) => participant.name === "Maren")?.prompt)
			.toEqual(modelPrompt);

		let captured: CapturedRequest | undefined;
		const generating = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch((request) => { captured = request; }),
		});
		const generationId = await startGeneration(generating, conversation.id, conversation.revision);
		await completeGeneration(generating, conversation.id, generationId);
		while (captured === undefined) await new Promise((resolve) => setTimeout(resolve, 0));

		expect(captured?.messages).toEqual([
			{ role: "system", content: "Answer briefly." },
			{ role: "user", content: "I write as Writer opposite Maren." },
			{ role: "system", content: "I am Maren." },
			{ role: "user", content: "A quiet room." },
			{ role: "user", content: "Writer: Hello\nMaren: Hello back" },
			{ role: "user", content: "Writer: Set the scene." },
			{ role: "system", content: "Continue." },
		]);
	});

	test("saving one occurrence's role never overwrites separately saved ordering or toggles", async () => {
		const conversation = createChat(database);
		const app = createConversationRoutes(database);
		const preset = await readPreset(app, conversation.id);
		const identity = slotOf(preset, "model-identity");
		const scenario = slotOf(preset, "model-scenario");
		const example = slotOf(preset, "model-example-dialogue");
		if (identity === undefined || scenario === undefined || example === undefined) {
			throw new Error("The Default recipe is missing its reference slots.");
		}

		await readOperation(toggleBlock(database, preset.id, scenario.id, false));
		await readOperation(moveBlock(database, preset.id, example.id, 1));
		await readOperation(setBlockRole(database, preset.id, identity.id, "user"));

		// The role save named one occurrence; the other saved changes stand.
		const reread = await readPreset(app, conversation.id);
		expect(reread.slots.map((slot) => [slot.reference, slot.enabled])).toEqual([
			["model-example-dialogue", true],
			["model-system-instruction", true],
			["human-identity", true],
			["model-identity", true],
			["model-scenario", false],
			["history", true],
			["model-post-history-instruction", true],
		]);
		expect(slotOf(reread, "model-identity")?.role).toBe("user");
		expect(slotOf(reread, "model-scenario")?.role).toBe("system");
	});

	test("rejects a role save on a history occurrence", async () => {
		const conversation = createChat(database);
		const preset = await readPreset(createConversationRoutes(database), conversation.id);
		const history = slotOf(preset, "history");
		if (history === undefined) throw new Error("The Default recipe has no history slot.");

		const response = await setBlockRole(database, preset.id, history.id, "user");
		expect(response.status).toBe(422);
		// SAFETY: the route's typed invalid outcome.
		const outcome = await response.json() as { outcome: string; reason: string };
		expect(outcome.outcome).toBe("invalid");
		expect(outcome.reason).toContain("history");
	});

	test("returns not-found for an unknown preset or block", async () => {
		const response = await addBlock(database, 424242, "model-scenario");
		expect(response.status).toBe(404);

		const conversation = createChat(database);
		const preset = await readPreset(createConversationRoutes(database), conversation.id);
		const missingBlock = await toggleBlock(database, preset.id, 987654, false);
		expect(missingBlock.status).toBe(404);
	});
});

describe("Prompt Preset shared Default", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("two Chats resolve their own Participant content through the same shared Default", async () => {
		const first = createChat(database, { human: "Rowan", model: "Sable" });
		const second = createChat(database, { human: "Iris", model: "Quill" });
		const app = createConversationRoutes(database);

		const firstPreset = await readPreset(app, first.id);
		const secondPreset = await readPreset(app, second.id);

		// One shared recipe, two independent resolutions.
		expect(firstPreset.id).toBe(secondPreset.id);
		expect(firstPreset.slots.map((slot) => slot.id)).toEqual(
			secondPreset.slots.map((slot) => slot.id),
		);
		expect(slotOf(firstPreset, "human-identity")?.sourceName).toBe("Rowan");
		expect(slotOf(firstPreset, "model-identity")?.sourceName).toBe("Sable");
		expect(slotOf(secondPreset, "human-identity")?.sourceName).toBe("Iris");
		expect(slotOf(secondPreset, "model-identity")?.sourceName).toBe("Quill");
	});

	test("saved edits to Default reach every Chat that selected it", async () => {
		const first = createChat(database);
		const second = createChat(database);
		const app = createConversationRoutes(database);
		const preset = await readPreset(app, first.id);
		const systemInstruction = slotOf(preset, "model-system-instruction");
		if (systemInstruction === undefined) {
			throw new Error("The Default recipe has no System Instruction slot.");
		}

		await readOperation(toggleBlock(database, preset.id, systemInstruction.id, false));

		// The second Chat reads the same saved recipe; there is no per-Chat
		// override layer.
		const secondPreset = await readPreset(app, second.id);
		expect(slotOf(secondPreset, "model-system-instruction")?.enabled).toBe(false);
	});
});
