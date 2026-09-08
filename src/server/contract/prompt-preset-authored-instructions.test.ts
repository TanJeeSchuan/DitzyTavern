import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConnectionSettingsModule } from "../connection-settings";
import { createConversationModule } from "../conversation";
import { createConversationRoutes } from "./conversation";
import { createPromptPresetRoutes } from "./prompt-preset";
import { createPromptPresetRoutes as createPromptPresetLibraryRoutes } from "./prompt-preset-routes";
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

const removeBlock = (database: Database, presetId: number, blockId: number) =>
	presetRoutes(database).handle(
		new Request(`http://localhost/api/prompt-presets/${presetId}/blocks/${blockId}`, {
			method: "DELETE",
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

const completeGeneration = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
	generationId: number,
) => {
	await (await app.handle(new Request(
		`http://localhost/api/conversations/${conversationId}/generations/${generationId}/events`,
	))).text();
};

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
