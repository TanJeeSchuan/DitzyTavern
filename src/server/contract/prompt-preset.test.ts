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
import { createPromptPresetRoutes as createPromptPresetLibraryRoutes } from "./prompt-preset-routes";
import { expandText } from "../../shared/prompt-macros";
import {
	movePromptPresetBlock,
	InvalidPromptPresetOperationError,
} from "../prompt-preset";
import type { ModelFetch } from "../model-client";
import type {
	ConversationPromptPreset,
	PromptPresetRecipe,
} from "../../shared/contract/prompt-preset";
import type { ConversationAction } from "../../shared/contract/conversation-schema";

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
		expect(added.slots.at(-1)?.reference).toBe("model-scenario");
		expect(added.slots.at(-1)?.enabled).toBe(true);
		expect(added.slots.at(-1)?.role).toBe("system");

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
		const addedSlot = added.slots.at(-1);
		if (addedSlot === undefined) throw new Error("The added slot disappeared.");
		const removed = await readOperation(
			removeBlock(database, preset.id, addedSlot.id),
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

	test("an Active Generation keeps its captured plan while saved edits take effect on the next Generation", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const app = createConversationRoutes(database);
		const preset = await readPreset(app, conversation.id);
		const postHistory = slotOf(preset, "model-post-history-instruction");
		const scenario = slotOf(preset, "model-scenario");
		if (postHistory === undefined || scenario === undefined) {
			throw new Error("The Default recipe is missing its reference slots.");
		}

		let captured: CapturedRequest | undefined;
		let release = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const gated = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch((request) => { captured = request; }, gate),
		});
		const generationId = await startGeneration(gated, conversation.id, conversation.revision);
		while (captured === undefined) await new Promise((resolve) => setTimeout(resolve, 0));

		// While the attempt streams, the shared recipe is edited.
		await readOperation(moveBlock(database, preset.id, postHistory.id, 1));
		await readOperation(setBlockRole(database, preset.id, scenario.id, "user"));

		// The Active Generation consumes the Prompt Plan captured when it was
		// prepared; the saved edit cannot rewrite the request in flight.
		expect(captured?.messages).toEqual([
			{ role: "system", content: "Answer briefly." },
			{ role: "user", content: "I write as Writer opposite Maren." },
			{ role: "assistant", content: "I am Maren." },
			{ role: "system", content: "A quiet room." },
			{ role: "user", content: "Writer: Hello\nMaren: Hello back" },
			{ role: "user", content: "Writer: Set the scene." },
			{ role: "system", content: "Continue." },
		]);

		release();
		await completeGeneration(gated, conversation.id, generationId);
		// The next Generation compiles the latest saved recipe without
		// reconstructing the Conversation.
		let capturedNext: CapturedRequest | undefined;
		const subsequent = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch((request) => { capturedNext = request; }),
		});
		const summaryResponse = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}`),
		);
		// SAFETY: the route's response schema is the Conversation summary.
		const summary = await summaryResponse.json() as { revision: number };
		const nextId = await startGeneration(subsequent, conversation.id, summary.revision);
		await completeGeneration(subsequent, conversation.id, nextId);
		while (capturedNext === undefined) await new Promise((resolve) => setTimeout(resolve, 0));

		expect(capturedNext?.messages).toEqual([
			{ role: "system", content: "Continue." },
			{ role: "system", content: "Answer briefly." },
			{ role: "user", content: "I write as Writer opposite Maren." },
			{ role: "assistant", content: "I am Maren." },
			{ role: "user", content: "A quiet room." },
			{ role: "user", content: "Writer: Hello\nMaren: Hello back" },
			{ role: "user", content: "Writer: Set the scene." },
			{ role: "assistant", content: "Maren: Done." },
			{ role: "user", content: "Writer: Set the scene." },
		]);
	});
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
describe("Prompt Preset authored instructions", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	// ==[HUMAN APPROVED]== Thin factories over the public route groups; each handle call builds
	// a stateless instance over the same isolated database, so the same
	// transport exercises duplication, selection, recipe operations, and
	// Generation through the public contract.
	const conversationApp = () => createConversationRoutes(database);

	const addInstruction = (presetId: number) =>
		presetRoutes(database).handle(
			new Request(`http://localhost/api/prompt-presets/${presetId}/instructions`, {
				method: "POST",
			}),
		);

	const setInstructionContent = (
		presetId: number,
		blockId: number,
		body: { name: string; content: string; role: string },
	) =>
		presetRoutes(database).handle(
			new Request(`http://localhost/api/prompt-presets/${presetId}/blocks/${blockId}/content`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);

	test("add, save, move, toggle, duplicate and remove work for authored instruction blocks", async () => {
		const conversation = createChat(database);
		const preset = await readPreset(conversationApp(), conversation.id);

		const added = await readOperation(addInstruction(preset.id));
		const instruction = added.slots.at(-1);
		expect(instruction).toEqual({
			id: expect.any(Number),
			reference: "instruction",
			enabled: true,
			role: "system",
			name: "Instruction",
			content: "",
		});

		// The one block-level save persists name, text, and role together.
		const saved = await readOperation(setInstructionContent(
			preset.id,
			// SAFETY: the occurrence above exists in the response recipe.
			(instruction as { id: number }).id,
			{ name: "Tone", content: "Write like {{self}}.", role: "assistant" },
		));
		const savedSlot = slotOf(saved, "instruction");
		if (savedSlot === undefined) throw new Error("The saved instruction is missing.");
		expect(savedSlot).toEqual({
			id: expect.any(Number),
			reference: "instruction",
			enabled: true,
			role: "assistant",
			name: "Tone",
			content: "Write like {{self}}.",
		});

		// Instruction blocks participate in the same ordered recipe operations.
		// Move it to the front, then duplicate it while both copies are enabled.
		const moved = await readOperation(moveBlock(database, preset.id, savedSlot.id, 1));
		expect(moved.slots[0]?.reference).toBe("instruction");
		const duplicated = await readOperation(
			duplicateBlock(database, preset.id, savedSlot.id),
		);
		expect(duplicated.slots.filter((slot) => slot.reference === "instruction")).toHaveLength(2);

		// disabling one occurrence leaves the other enabled and in place.
		const toggled = await readOperation(
			toggleBlock(database, preset.id, savedSlot.id, false),
		);
		expect(slotOf(toggled, "instruction")?.enabled).toBe(false);

		// A deliberate duplicate is independently editable: saving the second
		// copy's text and role leaves the disabled original untouched.
		const copy = toggled.slots.filter((slot) => slot.reference === "instruction")[1];
		if (copy === undefined) throw new Error("The duplicated instruction is missing.");
		// SAFETY: the copy exists in the response recipe.
		const copySaved = await readOperation(setInstructionContent(
			preset.id,
			copy.id,
			{ name: "Copy", content: "Independent text.", role: "user" },
		));
		const copies = copySaved.slots.filter((slot) => slot.reference === "instruction");
		expect(copies[0]).toEqual({
			id: expect.any(Number),
			reference: "instruction",
			enabled: false,
			role: "assistant",
			name: "Tone",
			content: "Write like {{self}}.",
		});
		expect(copies[1]).toEqual({
			id: expect.any(Number),
			reference: "instruction",
			enabled: true,
			role: "user",
			name: "Copy",
			content: "Independent text.",
		});

		// Removing one occurrence leaves the other exactly where it was.
		const removed = await readOperation(removeBlock(database, preset.id, copies[0].id));
		expect(removed.slots.filter((slot) => slot.reference === "instruction")).toEqual([
			copies[1],
		]);
	});

	test("refuses a text save on a referenced occurrence", async () => {
		const conversation = createChat(database);
		const preset = await readPreset(conversationApp(), conversation.id);
		const identity = slotOf(preset, "human-identity");
		if (identity === undefined) throw new Error("The Default recipe has no Identity slot.");

		const response = await setInstructionContent(preset.id, identity.id, {
			name: "Nope",
			content: "Nope",
			role: "system",
		});
		expect(response.status).toBe(422);
		// SAFETY: the route's typed invalid outcome.
		const outcome = await response.json() as { outcome: string; reason: string };
		expect(outcome.outcome).toBe("invalid");
		expect(outcome.reason).toContain("instruction");
	});
});

describe("Prompt Preset authored instructions, shared and copied", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	const conversationApp = () => createConversationRoutes(database);
	const libraryApp = () => createPromptPresetLibraryRoutes(database);
	const presetRevision = async (presetId: number): Promise<number> => {
		const response = await libraryApp().handle(new Request("http://localhost/api/prompt-presets"));
		expect(response.status).toBe(200);
		// SAFETY: the route's response schema is the typed preset list.
		const payload = await response.json() as { presets: { id: number; revision: number }[] };
		const summary = payload.presets.find((preset) => preset.id === presetId);
		if (summary === undefined) throw new Error("The preset is not listed.");
		return summary.revision;
	};

	const addInstruction = (presetId: number) =>
		presetRoutes(database).handle(
			new Request(`http://localhost/api/prompt-presets/${presetId}/instructions`, {
				method: "POST",
			}),
		);

	const setInstructionContent = (
		presetId: number,
		blockId: number,
		body: { name: string; content: string; role: string },
	) =>
		presetRoutes(database).handle(
			new Request(`http://localhost/api/prompt-presets/${presetId}/blocks/${blockId}/content`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);

	const duplicatePreset = async (presetId: number, name: string) => {
		const expectedRevision = await presetRevision(presetId);
		const response = await libraryApp().handle(
			new Request("http://localhost/api/prompt-presets/commands", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ type: "duplicate", presetId, expectedRevision, name }),
			}),
		);
		expect(response.status).toBe(200);
		// SAFETY: this test controls the typed applied response.
		return await response.json() as {
			outcome: "applied";
			preset: { id: number; name: string; revision: number };
		};
	};

	const selectPresetFor = async (
		conversationId: number,
		expectedRevision: number,
		promptPresetId: number,
	) => {
		const response = await conversationApp().handle(
			new Request(`http://localhost/api/conversations/${conversationId}/commands`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedRevision,
					action: { type: "select-prompt-preset", promptPresetId },
				}),
			}),
		);
		expect(response.status).toBe(200);
		// SAFETY: the route's response schema is the conversation applied summary.
		return await response.json() as { conversation: { revision: number } };
	};

	const captureMessages = async (conversationId: number, revision: number) => {
		let captured: CapturedRequest | undefined;
		const generating = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch((request) => { captured = request; }),
		});
		const generationId = await startGeneration(generating, conversationId, revision);
		await completeGeneration(generating, conversationId, generationId);
		while (captured === undefined) await new Promise((resolve) => setTimeout(resolve, 0));
		return captured;
	};

	test("shared authored text reaches every selecting Chat while a duplicated preset stays independent", async () => {
		const first = createChat(database);
		const second = createChat(database);
		const third = createChat(database);
		withProfile(database);
		const preset = await readPreset(conversationApp(), first.id);

		// The third Chat uses an independent copy of the shared preset.
		const duplicated = await duplicatePreset(preset.id, "Copy");
		const thirdRevision = await selectPresetFor(
			third.id,
			third.revision,
			duplicated.preset.id,
		);

		// A saved instruction on the shared preset reaches both selecting
		// Chats and never reaches the copy.
		const added = await readOperation(addInstruction(preset.id));
		const instruction = added.slots.at(-1);
		if (instruction === undefined) throw new Error("The instruction was not added.");
		await readOperation(setInstructionContent(
			preset.id,
			instruction.id,
			{ name: "Tone", content: "Write like {{self}}.", role: "assistant" },
		));

		const firstRequest = await captureMessages(first.id, first.revision);
		const secondRequest = await captureMessages(second.id, second.revision);
		const thirdRequest = await captureMessages(third.id, thirdRevision.conversation.revision);

		// The two shared-preset Chats assemble the saved instruction with their
		// own Participant names; the copy's recipe has no instruction at all.
		expect(firstRequest?.messages).toContainEqual({
			role: "assistant",
			content: "Write like Writer.",
		});
		expect(secondRequest?.messages).toContainEqual({
			role: "assistant",
			content: "Write like Writer.",
		});
		expect(
			thirdRequest?.messages.some((message) => message.content.startsWith("Write like")),
		).toBe(false);
	});

	test("the copy's own saved instruction never reaches the shared preset or its Chats", async () => {
		const shared = createChat(database);
		const copy = createChat(database);
		withProfile(database);
		const preset = await readPreset(conversationApp(), shared.id);

		const duplicated = await duplicatePreset(preset.id, "Copy");
		const copyRevision = await selectPresetFor(copy.id, copy.revision, duplicated.preset.id);

		// Editing the copy's recipe later is invisible to the shared preset.
		const added = await readOperation(addInstruction(duplicated.preset.id));
		const instruction = added.slots.at(-1);
		if (instruction === undefined) throw new Error("The instruction was not added.");
		await readOperation(setInstructionContent(
			duplicated.preset.id,
			instruction.id,
			{ name: "CopyOnly", content: "Only the copy has this.", role: "system" },
		));

		const copyRequest = await captureMessages(copy.id, copyRevision.conversation.revision);
		const sharedRequest = await captureMessages(shared.id, shared.revision);
		expect(copyRequest?.messages).toContainEqual({
			role: "system",
			content: "Only the copy has this.",
		});
		expect(
			sharedRequest?.messages.some((message) => message.content === "Only the copy has this."),
		).toBe(false);
	});
});

describe("Prompt Preset authored instruction macros", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	const conversationApp = () => createConversationRoutes(database);

	const addInstruction = (presetId: number) =>
		presetRoutes(database).handle(
			new Request(`http://localhost/api/prompt-presets/${presetId}/instructions`, {
				method: "POST",
			}),
		);

	const setInstructionContent = (
		presetId: number,
		blockId: number,
		body: { name: string; content: string; role: string },
	) =>
		presetRoutes(database).handle(
			new Request(`http://localhost/api/prompt-presets/${presetId}/blocks/${blockId}/content`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);

	const runConversationCommand = async (
		conversationId: number,
		expectedRevision: number,
		action: ConversationAction,
	) => {
		const response = await conversationApp().handle(
			new Request(`http://localhost/api/conversations/${conversationId}/commands`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision, action }),
			}),
		);
		expect(response.status).toBe(200);
		// SAFETY: the route's response schema is the conversation applied summary.
		return await response.json() as { conversation: { revision: number } };
	};

	const captureMessages = async (conversationId: number, revision: number) => {
		let captured: CapturedRequest | undefined;
		const generating = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch((request) => { captured = request; }),
		});
		const generationId = await startGeneration(generating, conversationId, revision);
		await completeGeneration(generating, conversationId, generationId);
		while (captured === undefined) await new Promise((resolve) => setTimeout(resolve, 0));
		return captured?.messages ?? [];
	};

	const conversationRevision = async (conversationId: number): Promise<number> => {
		const response = await conversationApp().handle(
			new Request(`http://localhost/api/conversations/${conversationId}`),
		);
		expect(response.status).toBe(200);
		// SAFETY: the route's response schema is the Conversation summary.
		const summary = await response.json() as { revision: number };
		return summary.revision;
	};

	const addAndSaveInstruction = async (
		presetId: number,
		name: string,
		content: string,
		role: string,
	): Promise<number> => {
		const added = await readOperation(addInstruction(presetId));
		const instruction = added.slots.at(-1);
		if (instruction === undefined) throw new Error("The instruction was not added.");
		await readOperation(setInstructionContent(presetId, instruction.id, { name, content, role }));
		return instruction.id;
	};

	test("preset-authored names follow each Chat's Control pair and Control reassignment, independent of role", async () => {
		const first = createChat(database, { human: "Rowan", model: "Sable" });
		const second = createChat(database, { human: "Iris", model: "Quill" });
		withProfile(database);
		const preset = await readPreset(conversationApp(), first.id);
		const instructionId = await addAndSaveInstruction(
			preset.id,
			"Perspective",
			"You are {{self}}; answer {{other}}.",
			"system",
		);

		const firstMessages = await captureMessages(first.id, first.revision);
		// Authored text: self is the human-controlled Participant. Participant
		// fields keep owner-relative meaning beside it.
		expect(firstMessages).toContainEqual({
			role: "system",
			content: "You are Rowan; answer Sable.",
		});
		expect(firstMessages).toContainEqual({
			role: "user",
			content: "I write as Rowan opposite Sable.",
		});
		expect(firstMessages).toContainEqual({ role: "assistant", content: "I am Sable." });

		const secondMessages = await captureMessages(second.id, second.revision);
		expect(secondMessages).toContainEqual({
			role: "system",
			content: "You are Iris; answer Quill.",
		});
		expect(secondMessages).toContainEqual({
			role: "user",
			content: "I write as Iris opposite Quill.",
		});

		// Control reassignment swaps the seats: the human seat now holds Sable
		// and the model seat holds Rowan. Participant ids are the cast order
		// (1 = the human seed, 2 = the model seed).
		const searchResponse = await conversationApp().handle(
			new Request(`http://localhost/api/conversations/${first.id}`),
		);
		// SAFETY: the route's response schema is the Conversation summary.
		const summary = await searchResponse.json() as {
			revision: number;
			cast: { id: number; name: string }[];
		};
		const rowan = summary.cast.find((participant) => participant.name === "Rowan");
		if (rowan === undefined) throw new Error("Rowan is not in the Cast.");
		const afterControl = await runConversationCommand(first.id, summary.revision, {
			type: "assign-control",
			seat: "model",
			participantId: rowan.id,
		});

		// The instruction now resolves to the new Control pair; the model
		// Definition text follows its new owner's name.
		const switchedMessages = await captureMessages(
			first.id,
			afterControl.conversation.revision,
		);
		expect(switchedMessages).toContainEqual({
			role: "system",
			content: "You are Sable; answer Rowan.",
		});
		// The Definition slots resolve the newly seated Participants, and their
		// authored text keeps owner-relative resolution: the human seat's
		// Definition (Sable's "I am {{self}}.") names Sable and the model
		// seat's Definition (Rowan's "I write as {{self}}.") names Rowan.
		expect(switchedMessages).toContainEqual({ role: "user", content: "I am Sable." });
		expect(switchedMessages).toContainEqual({
			role: "assistant",
			content: "I write as Rowan opposite Sable.",
		});

		// Changing the outgoing role to user changes only the presentation:
		// the same perspective, now sent as a user message.
		await readOperation(setInstructionContent(
			preset.id,
			instructionId,
			{ name: "Perspective", content: "You are {{self}}; answer {{other}}.", role: "user" },
		));
		const userRoleMessages = await captureMessages(
			first.id,
			(await conversationRevision(first.id)),
		);
		expect(userRoleMessages).toContainEqual({
			role: "user",
			content: "You are Sable; answer Rowan.",
		});
	});

	test("unknown macros stay literal, warn in the compiled plan, and never block Generation", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const preset = await readPreset(conversationApp(), conversation.id);
		const content = "{{user}} and {{time}} stay raw; {{self}} works.";
		await addAndSaveInstruction(preset.id, "Imported", content, "system");

		let captured: CapturedRequest | undefined;
		const generating = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch((request) => { captured = request; }),
		});
		const generationId = await startGeneration(generating, conversation.id, conversation.revision);
		const inspection = await readInspection(generating, conversation.id, generationId);
		await completeGeneration(generating, conversation.id, generationId);
		while (captured === undefined) await new Promise((resolve) => setTimeout(resolve, 0));

		// The unknown macros reach the provider literally — Generation is
		// available — while the plan warns about exactly what the shared
		// editor warning surface would show.
		expect(captured?.messages).toContainEqual({
			role: "system",
			content: "{{user}} and {{time}} stay raw; Writer works.",
		});
		expect(inspection.promptPlan.warnings).toContainEqual({
			block: "Imported",
			macro: "{{user}}",
		});
		expect(inspection.promptPlan.warnings).toContainEqual({
			block: "Imported",
			macro: "{{time}}",
		});
		expect(expandText(content, { self: "", other: "" }, "Imported").warnings)
			.toContainEqual({ block: "Imported", macro: "{{user}}" });
	});

	test("an instruction save never overwrites separately saved ordering, toggles or roles", async () => {
		const conversation = createChat(database);
		const preset = await readPreset(conversationApp(), conversation.id);
		const scenario = slotOf(preset, "model-scenario");
		const postHistory = slotOf(preset, "model-post-history-instruction");
		const identity = slotOf(preset, "model-identity");
		if (scenario === undefined || postHistory === undefined || identity === undefined) {
			throw new Error("The Default recipe is missing reference slots.");
		}

		await readOperation(toggleBlock(database, preset.id, scenario.id, false));
		await readOperation(moveBlock(database, preset.id, postHistory.id, 1));
		await readOperation(setBlockRole(database, preset.id, identity.id, "user"));

		const instructionId = await addAndSaveInstruction(
			preset.id,
			"Text",
			"Saved text.",
			"assistant",
		);

		// The instruction save named one occurrence; the separately saved
		// ordering, toggle and role stand exactly as they were saved.
		const saved = await readPreset(conversationApp(), conversation.id);
		expect(saved.slots.map((slot) => [slot.reference, slot.enabled])).toEqual([
			["model-post-history-instruction", true],
			["model-system-instruction", true],
			["human-identity", true],
			["model-identity", true],
			["model-scenario", false],
			["model-example-dialogue", true],
			["history", true],
			["instruction", true],
		]);
		expect(slotOf(saved, "model-identity")?.role).toBe("user");
		expect(slotOf(saved, "instruction")?.content).toBe("Saved text.");

		// And a later toggle of the instruction does not disturb its saved text.
		const toggled = await readOperation(
			toggleBlock(database, preset.id, instructionId, false),
		);
		expect(slotOf(toggled, "instruction")?.enabled).toBe(false);
		expect(slotOf(toggled, "instruction")?.content).toBe("Saved text.");
	});

	test("an Active Generation keeps its captured instruction while the next Generation observes the save", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const preset = await readPreset(conversationApp(), conversation.id);
		const instructionId = await addAndSaveInstruction(
			preset.id,
			"Tone",
			"Original tone.",
			"system",
		);

		let captured: CapturedRequest | undefined;
		let release = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const gated = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch((request) => { captured = request; }, gate),
		});
		const generationId = await startGeneration(gated, conversation.id, conversation.revision);
		while (captured === undefined) await new Promise((resolve) => setTimeout(resolve, 0));

		// While the attempt streams, the saved instruction changes in text,
		// role and position.
		await readOperation(setInstructionContent(
			preset.id,
			instructionId,
			{ name: "Tone", content: "Revised tone.", role: "user" },
		));
		await readOperation(moveBlock(database, preset.id, instructionId, 1));

		// The Active Generation keeps the Prompt Plan it captured: the original
		// text, role and position.
		const capturedPlan = await readInspection(gated, conversation.id, generationId);
		const capturedInstruction = capturedPlan.promptPlan.blocks.find(
			(block) => block.kind === "instruction",
		);
		expect(capturedInstruction).toEqual({
			kind: "instruction",
			role: "system",
			content: "Original tone.",
		});
		expect(captured?.messages).toContainEqual({ role: "system", content: "Original tone." });

		release();
		await completeGeneration(gated, conversation.id, generationId);

		// The next Generation compiles the latest saved instruction at its new
		// position and role.
		let capturedNext: CapturedRequest | undefined;
		const subsequent = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch((request) => { capturedNext = request; }),
		});
		const summaryResponse = await conversationApp().handle(
			new Request(`http://localhost/api/conversations/${conversation.id}`),
		);
		// SAFETY: the route's response schema is the Conversation summary.
		const summary = await summaryResponse.json() as { revision: number };
		const nextId = await startGeneration(subsequent, conversation.id, summary.revision);
		await completeGeneration(subsequent, conversation.id, nextId);
		while (capturedNext === undefined) await new Promise((resolve) => setTimeout(resolve, 0));

		expect(capturedNext?.messages[0]).toEqual({ role: "user", content: "Revised tone." });
	});

	test("token estimates account for authored instruction text", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const fetchApp = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch(() => {}),
		});
		const preset = await readPreset(conversationApp(), conversation.id);
		const instructionId = await addAndSaveInstruction(
			preset.id,
			"Tone",
			"A short instruction.",
			"system",
		);

		const firstId = await startGeneration(fetchApp, conversation.id, conversation.revision);
		const first = await readInspection(fetchApp, conversation.id, firstId);
		await completeGeneration(fetchApp, conversation.id, firstId);

		await readOperation(setInstructionContent(
			preset.id,
			instructionId,
			{
				name: "Tone",
				content: "A much longer instruction that repeats several times to grow the assembled plan beyond the first estimate.",
				role: "system",
			},
		));
		const secondResponse = await fetchApp.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}`),
		);
		// SAFETY: the route's response schema is the Conversation summary.
		const secondSummary = await secondResponse.json() as { revision: number };
		const secondId = await startGeneration(fetchApp, conversation.id, secondSummary.revision);
		const second = await readInspection(fetchApp, conversation.id, secondId);
		await completeGeneration(fetchApp, conversation.id, secondId);

		expect(second.budget.tokenEstimate).toBeGreaterThan(first.budget.tokenEstimate);
	});
});