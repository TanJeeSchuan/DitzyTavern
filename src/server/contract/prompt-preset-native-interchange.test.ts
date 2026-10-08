import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConnectionSettingsModule } from "../connection-settings";
import { createConversationRoutes } from "./conversation";
import type { NativePromptPreset } from "../../shared/contract/prompt-preset";
import {
	completeGeneration,
	createChat,
	createRoutes,
	exportPreset,
	gatedProvider,
	importPreset,
	key,
	listPresets,
	profile,
	readConversation,
	readSelectedPreset,
	runPresetCommand,
	selectPreset,
	startGeneration,
} from "./prompt-preset-test-fixtures";

import { observeConversationWrites } from "../conversation";
import { syncMemorySources } from "../memory";
// ==[HUMAN APPROVED]== Native interchange exercises export and reimport of the stored recipe
// through the public library routes: references stay references, authored
// text travels untouched, and a reimported recipe drives a selected
// Conversation's captured request.
describe("Native Prompt Preset interchange", () => {
	let database: Database;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		observeConversationWrites(database, syncMemorySources);
	});
	afterEach(() => database.close());

	test("round-trips authored text, comments, references, roles, order and disabled repeats", async () => {
		const routes = createRoutes(database);
		const native: NativePromptPreset = {
			name: "Default",
			slots: [
				{
					reference: "instruction",
					enabled: false,
					role: "assistant",
					name: "Keep raw comments",
					content: "Before {{// {{not-a-macro}} }}\nAfter {{self}}",
				},
				{ reference: "model-identity", enabled: true, role: "user" },
				{ reference: "model-identity", enabled: true, role: "assistant" },
				{ reference: "memory", enabled: false, role: "assistant" },
				{ reference: "history", enabled: false },
			],
		};

		const imported = await importPreset(routes.library, native);
		expect(imported.status).toBe(200);
		expect(imported.body).toMatchObject({
			outcome: "applied",
			preset: { id: 2, name: "Default", isDefault: false },
		});
		const roundTrip = await exportPreset(routes.library, 2);
		expect(roundTrip).toEqual(native);

		// Export is a stored recipe projection: it has references only, never the
		// selected Chat's Participant names, resolved content or history entries.
		const conversation = createChat(database);
		await selectPreset(routes.conversations, conversation.id, conversation.revision, 2);
		const resolved = await readSelectedPreset(routes.conversations, conversation.id);
		expect(resolved?.slots.map((slot) => slot.reference)).toEqual([
			"instruction",
			"model-identity",
			"model-identity",
			"memory",
			"history",
		]);
		expect(roundTrip).not.toHaveProperty("id");
		expect(roundTrip).not.toHaveProperty("sourceName");
		expect(roundTrip).not.toHaveProperty("content", "I am Maren.");
		expect(resolved?.slots[1]).toMatchObject({ sourceName: "Maren", content: "I am {{self}}." });
	});

	test("rejects duplicate Memory references in native import", async () => {
		const routes = createRoutes(database);
		const result = await importPreset(routes.library, {
			name: "Duplicate Memory",
			slots: [
				{ reference: "memory", enabled: false, role: "system" },
				{ reference: "memory", enabled: true, role: "assistant" },
			],
		});
		expect(result.status).toBe(422);
		expect(await listPresets(routes.library)).toHaveLength(1);
	});

	test("imports as a new independent preset and invalid input leaves the library unchanged", async () => {
		const routes = createRoutes(database);
		const native: NativePromptPreset = {
			name: "Independent",
			slots: [{
				reference: "instruction",
				enabled: true,
				role: "system",
				name: "Original",
				content: "Original source",
			}],
		};
		const imported = await importPreset(routes.library, native);
		expect(imported.status).toBe(200);

		const invalid = await importPreset(routes.library, {
			...native,
			slots: [{
				reference: "instruction",
				enabled: true,
				role: "invalid",
				name: "Broken",
				content: "Should not persist",
			}],
		});
		expect(invalid.status).toBe(422);
		expect((await listPresets(routes.library)).map((preset) => preset.name)).toEqual([
			"Default",
			"Independent",
		]);

		const renamed = await runPresetCommand(routes.library, {
			type: "rename",
			presetId: 2,
			expectedRevision: 0,
			name: "Independent copy",
		});
		expect(renamed.status).toBe(200);
		expect((await exportPreset(routes.library, 1)).name).toBe("Default");
		expect((await exportPreset(routes.library, 2)).name).toBe("Independent copy");
	});

	test("an imported recipe drives the selected Conversation's resolved request", async () => {
		const routes = createRoutes(database);
		const conversation = createChat(database);
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "preset-secret",
		});
		const imported = await importPreset(routes.library, {
			name: "Captured",
			slots: [
				{ reference: "model-system-instruction", enabled: true, role: "system" },
				{
					reference: "instruction",
					enabled: true,
					role: "assistant",
					name: "Voice",
					content: "Speak for {{self}} to {{other}}.",
				},
				{ reference: "history", enabled: true },
				{ reference: "model-post-history-instruction", enabled: true, role: "system" },
			],
		});
		expect(imported.status).toBe(200);
		await selectPreset(routes.conversations, conversation.id, conversation.revision, 2);

		const gate = gatedProvider();
		const app = createConversationRoutes(database, { masterKey: key, fetch: gate.fetch });
		const selected = await readConversation(app, conversation.id);
		const generationId = await startGeneration(app, conversation.id, selected.revision, gate);
		gate.release();
		await completeGeneration(app, conversation.id, generationId);
		expect(gate.requests[0]?.messages).toEqual([
			{ role: "system", content: "Answer briefly." },
			{ role: "assistant", content: "Speak for Writer to Maren." },
			{ role: "user", content: "Writer: Set the scene." },
			{ role: "system", content: "Continue." },
		]);
	});
});
