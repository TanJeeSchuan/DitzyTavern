import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConversationModule } from "../conversation";
import { createConversationRoutes } from "./conversation";
import { createPromptPresetRoutes } from "./prompt-preset-routes";
import type {
	ConversationSummary,
} from "../../shared/contract/conversation-schema";
import type {
	ConversationPromptPreset,
	PromptPresetCommand,
	PromptPresetConflict,
	PromptPresetListResponse,
	PromptPresetSummary,
} from "../../shared/contract/prompt-preset";
import { addPromptPresetInstruction, readPromptPresetRecipe } from "../prompt-preset";

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

const listPresets = async (
	app: ReturnType<typeof createPromptPresetRoutes>,
): Promise<PromptPresetSummary[]> => {
	const response = await app.handle(new Request("http://localhost/api/prompt-presets"));
	expect(response.status).toBe(200);
	// SAFETY: the route's response schema is the library list payload.
	const payload = await response.json() as PromptPresetListResponse;
	return payload.presets;
};

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

describe("Prompt Preset library transport", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("lists the library with the Default preset first and its Conversation count", async () => {
		const app = createPromptPresetRoutes(database);
		createChat(database);
		createChat(database, "Second Chat");

		const presets = await listPresets(app);

		expect(presets).toEqual([
			{ id: 1, name: "Default", revision: 0, isDefault: true, conversationCount: 2 },
		]);
	});

	test("creates a blank preset that stays an empty ordinary library object", async () => {
		const routes = createRoutes(database);
		const conversation = createChat(database);

		const applied = await runPresetCommand(routes.library, { type: "create", name: "Blank" });
		expect(applied.status).toBe(200);
		expect(applied.body).toEqual({
			outcome: "applied",
			preset: { id: 2, name: "Blank", revision: 0, isDefault: false, conversationCount: 0 },
		});

		// The blank preset is selectable and its recipe stays empty: no required
		// history or character slot is silently acquired.
		const selected = await selectPreset(
			routes.conversations,
			conversation.id,
			conversation.revision,
			2,
		);
		expect(selected.status).toBe(200);
		const resolved = await readSelectedPreset(routes.conversations, conversation.id);
		expect(resolved?.name).toBe("Blank");
		expect(resolved?.slots).toEqual([]);

		const presets = await listPresets(routes.library);
		expect(presets.map((preset) => [preset.name, preset.conversationCount])).toEqual([
			["Default", 0],
			["Blank", 1],
		]);
	});

	test("rejects a blank preset name as invalid", async () => {
		const app = createPromptPresetRoutes(database);
		const applied = await runPresetCommand(app, { type: "create", name: "   " });
		expect(applied.status).toBe(422);
		// SAFETY: the invalid outcome carries a reason string.
		expect(applied.body).toMatchObject({ outcome: "invalid" });
	});

	test("renames through the durable command and rereads the new name", async () => {
		const app = createPromptPresetRoutes(database);
		await runPresetCommand(app, { type: "create", name: "Working Title" });

		const applied = await runPresetCommand(app, {
			type: "rename",
			presetId: 2,
			expectedRevision: 0,
			name: "Renamed",
		});
		expect(applied.status).toBe(200);
		expect(applied.body).toEqual({
			outcome: "applied",
			preset: { id: 2, name: "Renamed", revision: 1, isDefault: false, conversationCount: 0 },
		});

		const presets = await listPresets(app);
		expect(presets.find((preset) => preset.id === 2)?.name).toBe("Renamed");
	});

	test("conflicts a stale rename with the authoritative preset", async () => {
		const app = createPromptPresetRoutes(database);
		await runPresetCommand(app, { type: "create", name: "Original" });

		const applied = await runPresetCommand(app, {
			type: "rename",
			presetId: 2,
			expectedRevision: 7,
			name: "Stale",
		});
		expect(applied.status).toBe(409);
		// SAFETY: the route's conflict schema is the typed stale payload.
		const conflict = applied.body as PromptPresetConflict;
		expect(conflict).toMatchObject({
			outcome: "conflict",
			reason: "stale-revision",
			expectedRevision: 7,
			actualRevision: 0,
			currentPreset: { name: "Original" },
		});
	});

	test("duplicates the complete recipe into an independent library object", async () => {
		const routes = createRoutes(database);
		const conversation = createChat(database);

		const applied = await runPresetCommand(routes.library, {
			type: "duplicate",
			presetId: 1,
			expectedRevision: 0,
			name: "Copy of Default",
		});
		expect(applied.status).toBe(200);
		expect(applied.body).toEqual({
			outcome: "applied",
			preset: { id: 2, name: "Copy of Default", revision: 0, isDefault: false, conversationCount: 0 },
		});

		// The copy preserves the recipe as references, so selecting it on this
		// Chat resolves the same slots from this Chat's own Participants —
		// never the rendered content of another Chat.
		await selectPreset(routes.conversations, conversation.id, conversation.revision, 2);
		const resolved = await readSelectedPreset(routes.conversations, conversation.id);
		expect(resolved?.name).toBe("Copy of Default");
		expect(resolved?.slots.map((slot) => slot.reference)).toEqual([
			"model-system-instruction",
			"human-identity",
			"model-identity",
			"model-scenario",
			"model-example-dialogue",
			"history",
			"model-post-history-instruction",
		]);
		expect(resolved?.slots.every((slot) => slot.enabled)).toBe(true);
	});

	test("source renaming and deletion leave the duplicate untouched", async () => {
		const app = createPromptPresetRoutes(database);
		await runPresetCommand(app, { type: "create", name: "Source" });
		const duplicated = await runPresetCommand(app, {
			type: "duplicate",
			presetId: 2,
			expectedRevision: 0,
			name: "Duplicate",
		});
		expect(duplicated.status).toBe(200);

		const renamed = await runPresetCommand(app, {
			type: "rename",
			presetId: 2,
			expectedRevision: 0,
			name: "Source renamed",
		});
		expect(renamed.status).toBe(200);
		const deleted = await runPresetCommand(app, {
			type: "delete",
			presetId: 2,
			expectedRevision: 1,
			expectedConversationCount: 0,
		});
		expect(deleted.status).toBe(200);

		const presets = await listPresets(app);
		expect(presets.map((preset) => preset.name)).toEqual(["Default", "Duplicate"]);
		expect(presets.find((preset) => preset.name === "Duplicate")).toMatchObject({
			revision: 0,
			conversationCount: 0,
		});
	});

	test("refuses to delete the Default preset", async () => {
		const app = createPromptPresetRoutes(database);
		const deleted = await runPresetCommand(app, {
			type: "delete",
			presetId: 1,
			expectedRevision: 0,
			expectedConversationCount: 0,
		});
		expect(deleted.status).toBe(409);
		// SAFETY: the not-removable outcome carries a reason string.
		expect(deleted.body).toMatchObject({ outcome: "not-removable" });

		const presets = await listPresets(app);
		expect(presets).toHaveLength(1);
	});

	test("reports the affected Conversation count and reassigns exactly those Chats to Default", async () => {
		const routes = createRoutes(database);
		const chatA = createChat(database);
		const chatB = createChat(database, "Chat B");
		const chatC = createChat(database, "Chat C");
		await runPresetCommand(routes.library, { type: "create", name: "Story" });
		await selectPreset(routes.conversations, chatA.id, chatA.revision, 2);
		await selectPreset(routes.conversations, chatB.id, chatB.revision, 2);

		const before = await listPresets(routes.library);
		expect(before.find((preset) => preset.id === 2)?.conversationCount).toBe(2);

		const deleted = await runPresetCommand(routes.library, {
			type: "delete",
			presetId: 2,
			expectedRevision: 0,
			expectedConversationCount: 2,
		});
		expect(deleted.status).toBe(200);
		expect(deleted.body).toEqual({
			outcome: "applied",
			result: { presetId: 2, reassignedConversationCount: 2 },
		});

		// Only the two affected Conversations move, in the same authoritative
		// operation, and they land on a valid Default selection.
		const afterA = await readSelectedPreset(routes.conversations, chatA.id);
		const afterB = await readSelectedPreset(routes.conversations, chatB.id);
		const afterC = await readSelectedPreset(routes.conversations, chatC.id);
		expect(afterA?.id).toBe(1);
		expect(afterA?.name).toBe("Default");
		expect(afterB?.id).toBe(1);
		expect(afterC?.id).toBe(1);
		const after = await listPresets(routes.library);
		expect(after).toEqual([
			{ id: 1, name: "Default", revision: 0, isDefault: true, conversationCount: 3 },
		]);
	});

	test("conflicts a stale deletion without touching any selection", async () => {
		const routes = createRoutes(database);
		const conversation = createChat(database);
		await runPresetCommand(routes.library, { type: "create", name: "Story" });
		await selectPreset(routes.conversations, conversation.id, conversation.revision, 2);

		const deleted = await runPresetCommand(routes.library, {
			type: "delete",
			presetId: 2,
			expectedRevision: 5,
			expectedConversationCount: 1,
		});
		expect(deleted.status).toBe(409);
		// SAFETY: the stale deletion maps onto the typed conflict payload.
		const conflict = deleted.body as PromptPresetConflict;
		expect(conflict).toMatchObject({
			reason: "stale-revision",
			expectedRevision: 5,
			actualRevision: 0,
			currentPreset: { conversationCount: 1 },
		});

		const resolved = await readSelectedPreset(routes.conversations, conversation.id);
		expect(resolved?.id).toBe(2);
	});

	test("conflicts a deletion when the affected-Conversation count increased without a revision change", async () => {
		const routes = createRoutes(database);
		const conversation = createChat(database);
		await runPresetCommand(routes.library, { type: "create", name: "Story" });

		// The author confirmed an unused preset, then this Chat selected it
		// without changing the preset's metadata revision.
		await selectPreset(routes.conversations, conversation.id, conversation.revision, 2);

		const deleted = await runPresetCommand(routes.library, {
			type: "delete",
			presetId: 2,
			expectedRevision: 0,
			expectedConversationCount: 0,
		});
		expect(deleted.status).toBe(409);
		// SAFETY: the changed deletion impact maps onto the typed conflict payload.
		const conflict = deleted.body as PromptPresetConflict;
		expect(conflict).toMatchObject({
			reason: "deletion-impact",
			currentPreset: { revision: 0, conversationCount: 1 },
		});

		expect((await readSelectedPreset(routes.conversations, conversation.id))?.id).toBe(2);
		expect((await listPresets(routes.library)).map((preset) => preset.id)).toEqual([1, 2]);
	});

	test("conflicts a deletion when the affected-Conversation count decreased without a revision change", async () => {
		const routes = createRoutes(database);
		const chatA = createChat(database);
		const chatB = createChat(database, "Chat B");
		await runPresetCommand(routes.library, { type: "create", name: "Story" });
		await selectPreset(routes.conversations, chatA.id, chatA.revision, 2);
		await selectPreset(routes.conversations, chatB.id, chatB.revision, 2);

		// The author confirmed two affected Chats, then one switched away
		// without changing the preset's metadata revision.
		const currentA = await readConversation(routes.conversations, chatA.id);
		await selectPreset(routes.conversations, chatA.id, currentA.revision, 1);

		const deleted = await runPresetCommand(routes.library, {
			type: "delete",
			presetId: 2,
			expectedRevision: 0,
			expectedConversationCount: 2,
		});
		expect(deleted.status).toBe(409);
		// SAFETY: the changed deletion impact maps onto the typed conflict payload.
		const conflict = deleted.body as PromptPresetConflict;
		expect(conflict).toMatchObject({
			reason: "deletion-impact",
			currentPreset: { revision: 0, conversationCount: 1 },
		});

		expect((await readSelectedPreset(routes.conversations, chatA.id))?.id).toBe(1);
		expect((await readSelectedPreset(routes.conversations, chatB.id))?.id).toBe(2);
		expect((await listPresets(routes.library)).map((preset) => preset.id)).toEqual([1, 2]);
	});

	test("saves mixed block patches atomically and preserves independently saved recipe fields", async () => {
		const app = createPromptPresetRoutes(database);
		createChat(database);
		// The library route intentionally owns only library commands; seed one occurrence
		// through the domain operation before exercising the command route.
		const addedRecipe = addPromptPresetInstruction(database, 1);
		const instruction = addedRecipe.slots.find((slot) => slot.reference === "instruction");
		const storedBefore = readPromptPresetRecipe(database, 1);
		if (instruction === undefined || storedBefore === undefined) throw new Error("The instruction fixture is missing.");
		const humanIdentity = storedBefore.slots.find((slot) => slot.reference === "human-identity");
		if (humanIdentity === undefined) throw new Error("The identity fixture is missing.");

		const applied = await runPresetCommand(app, {
			type: "save-block-patches",
			presetId: 1,
			patches: [
				{ occurrenceId: humanIdentity.id, type: "role", role: "assistant" },
				{ occurrenceId: instruction.id, type: "content", name: "Tone", content: "Be concise.", role: "user" },
			],
		});
		expect(applied.status).toBe(200);
		const saved = readPromptPresetRecipe(database, 1);
		expect(saved?.slots.find((slot) => slot.id === humanIdentity.id)).toMatchObject({
			reference: "human-identity",
			enabled: true,
			role: "assistant",
		});
		expect(saved?.slots.find((slot) => slot.id === instruction.id)).toMatchObject({
			reference: "instruction",
			name: "Tone",
			content: "Be concise.",
			role: "user",
		});
		expect(saved?.slots.map((slot) => slot.id)).toEqual(storedBefore.slots.map((slot) => slot.id));

		const beforeRejected = readPromptPresetRecipe(database, 1);
		const rejected = await runPresetCommand(app, {
			type: "save-block-patches",
			presetId: 1,
			patches: [
				{ occurrenceId: instruction.id, type: "content", name: "Should not persist", content: "Nope", role: "system" },
				{ occurrenceId: 999999, type: "role", role: "system" },
			],
		});
		expect(rejected.status).toBe(422);
		expect(readPromptPresetRecipe(database, 1)).toEqual(beforeRejected);

		const noOp = await runPresetCommand(app, {
			type: "save-block-patches",
			presetId: 1,
			patches: [],
		});
		expect(noOp.status).toBe(200);
	});

	test("returns not-found when saving patches against a nonexistent preset, for empty and nonempty patches", async () => {
		const app = createPromptPresetRoutes(database);

		const empty = await runPresetCommand(app, {
			type: "save-block-patches",
			presetId: 424242,
			patches: [],
		});
		expect(empty.status).toBe(404);
		// SAFETY: the route's shared not-found envelope.
		expect(empty.body).toEqual({ outcome: "not-found" });

		const nonempty = await runPresetCommand(app, {
			type: "save-block-patches",
			presetId: 424242,
			patches: [{ occurrenceId: 999999, type: "role", role: "system" }],
		});
		expect(nonempty.status).toBe(404);
		expect(nonempty.body).toEqual({ outcome: "not-found" });
	});

	test("returns not-found when saving patches against a deleted preset", async () => {
		const app = createPromptPresetRoutes(database);
		await runPresetCommand(app, { type: "create", name: "Disposable" });
		await runPresetCommand(app, {
			type: "delete",
			presetId: 2,
			expectedRevision: 0,
			expectedConversationCount: 0,
		});

		const empty = await runPresetCommand(app, {
			type: "save-block-patches",
			presetId: 2,
			patches: [],
		});
		expect(empty.status).toBe(404);
		// SAFETY: the route's shared not-found envelope.
		expect(empty.body).toEqual({ outcome: "not-found" });

		const nonempty = await runPresetCommand(app, {
			type: "save-block-patches",
			presetId: 2,
			patches: [{ occurrenceId: 999999, type: "role", role: "system" }],
		});
		expect(nonempty.status).toBe(404);
		expect(nonempty.body).toEqual({ outcome: "not-found" });
	});

	test("selects independently for each Conversation and survives a fresh read", async () => {
		const routes = createRoutes(database);
		const chatA = createChat(database);
		const chatB = createChat(database, "Chat B");
		await runPresetCommand(routes.library, { type: "create", name: "Story" });

		const applied = await selectPreset(routes.conversations, chatA.id, chatA.revision, 2);
		expect(applied.status).toBe(200);
		// SAFETY: the applied command carries the authoritative summary.
		const appliedBody = applied.body as { outcome: string; conversation: ConversationSummary };
		expect(appliedBody.outcome).toBe("applied");
		expect(appliedBody.conversation.revision).toBe(chatA.revision + 1);

		// Chat A moved; Chat B's selection is untouched even though both
		// previously selected the same Default preset.
		const afterA = await readSelectedPreset(routes.conversations, chatA.id);
		const afterB = await readSelectedPreset(routes.conversations, chatB.id);
		expect(afterA?.id).toBe(2);
		expect(afterA?.name).toBe("Story");
		expect(afterB?.id).toBe(1);
		expect(afterB?.name).toBe("Default");
	});

	test("rejects selecting a preset that is not in the library", async () => {
		const routes = createRoutes(database);
		const conversation = createChat(database);
		const applied = await selectPreset(
			routes.conversations,
			conversation.id,
			conversation.revision,
			424242,
		);
		expect(applied.status).toBe(422);
		// SAFETY: the invalid outcome carries a reason string.
		expect(applied.body).toMatchObject({ outcome: "invalid" });
	});
});
