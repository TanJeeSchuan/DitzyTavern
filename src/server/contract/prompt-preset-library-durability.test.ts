import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInitializedDatabase } from "../database/database";
import { createConversationModule } from "../conversation";
import { createConversationRoutes } from "./conversation";
import { createPromptPresetRoutes } from "./prompt-preset-routes";
import type {
	ConversationPromptPreset,
	PromptPresetCommand,
	PromptPresetListResponse,
	PromptPresetSummary,
} from "../../shared/contract/prompt-preset";

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

describe("Prompt Preset library durability", () => {
	let directory: string;

	beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "ditzy-preset-library-")); });
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

	test("keeps the library, its names and each Chat's selection across restarts", async () => {
		const path = join(directory, "preset-library.sqlite");
		const first = openInitializedDatabase({ path });
		const library = createPromptPresetRoutes(first);
		const conversations = createConversationRoutes(first);
		const conversation = createChat(first);
		await runPresetCommand(library, { type: "create", name: "Story" });
		await selectPreset(conversations, conversation.id, conversation.revision, 2);
		await runPresetCommand(library, {
			type: "rename",
			presetId: 2,
			expectedRevision: 0,
			name: "Story (renamed)",
		});
		first.close();

		const second = openInitializedDatabase({ path });
		try {
			const libraryRoutes = createPromptPresetRoutes(second);
			const conversationRoutes = createConversationRoutes(second);
			const presets = await listPresets(libraryRoutes);
			expect(presets.map((preset) => preset.name)).toEqual(["Default", "Story (renamed)"]);
			expect(presets.find((preset) => preset.id === 2)).toMatchObject({
				revision: 1,
				conversationCount: 1,
			});
			const resolved = await readSelectedPreset(conversationRoutes, conversation.id);
			expect(resolved?.id).toBe(2);
			expect(resolved?.name).toBe("Story (renamed)");
		} finally {
			second.close();
		}
	});
});
