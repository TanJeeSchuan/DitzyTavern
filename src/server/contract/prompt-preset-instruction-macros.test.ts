import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConnectionSettingsModule } from "../connection-settings";
import { createConversationModule } from "../conversation";
import { createConversationRoutes } from "./conversation";
import { createPromptPresetRoutes } from "./prompt-preset";
import { expandText } from "../../shared/prompt-macros";
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
