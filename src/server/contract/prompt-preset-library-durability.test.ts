import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInitializedDatabase } from "../database/database";
import {
	conversationApp,
	createChat,
	libraryRoutes,
	listPresets,
	readSelectedPreset,
	runPresetCommand,
	selectPreset,
} from "./prompt-preset-test-fixtures";

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
		const library = libraryRoutes(first);
		const conversations = conversationApp(first);
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
			const reopenedLibrary = libraryRoutes(second);
			const reopenedConversations = conversationApp(second);
			const presets = await listPresets(reopenedLibrary);
			expect(presets.map((preset) => preset.name)).toEqual(["Default", "Story (renamed)"]);
			expect(presets.find((preset) => preset.id === 2)).toMatchObject({
				revision: 1,
				conversationCount: 1,
			});
			const resolved = await readSelectedPreset(reopenedConversations, conversation.id);
			expect(resolved?.id).toBe(2);
			expect(resolved?.name).toBe("Story (renamed)");
		} finally {
			second.close();
		}
	});
});
