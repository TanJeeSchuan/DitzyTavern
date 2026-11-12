import { expect, test } from "bun:test";
import { openObservedDatabase, createConversationWithHistory } from "../test-fixtures/conversation";
import { createPaintingModule } from ".";
import { executePromptPresetCommand, importNativePromptPreset, listPromptPresets } from "../prompt-preset";
import { forkConversation } from "../conversation";

const prompt = { systemInstruction: "", identity: "", appearance: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };

test("Paint Preset selection starts on Default (Paint), copies on Fork, and deletion reassigns both Chats", () => {
	const database = openObservedDatabase();
	try {
		const chat = createConversationWithHistory(database, { name: "Paint", participants: [
			{ definition: { name: "Writer", prompt, sendAppearanceImages: true, openings: [] } },
			{ definition: { name: "Maren", prompt, sendAppearanceImages: true, openings: ["A scene"] } },
		], control: { human: 0, model: 1 } });
		const paintings = createPaintingModule(database);
		const initial = paintings.read(chat.id);
		expect(initial).toMatchObject({ briefMessageCount: 5, paintPresets: [{ id: initial.paintPresetId, name: "Default (Paint)" }] });
		const builtIn = listPromptPresets(database).find((preset) => preset.id === initial.paintPresetId)!;
		expect(() => executePromptPresetCommand(database, { type: "delete", presetId: builtIn.id, expectedRevision: builtIn.revision, expectedConversationCount: 1 })).toThrow("Default");
		const preset = importNativePromptPreset(database, { name: "Charcoal", slots: [{ reference: "brief-instruction", enabled: true, role: "system", content: "Use charcoal." }] });
		paintings.command(chat.id, { type: "select-paint-preset", paintPresetId: preset.id });
		paintings.command(chat.id, { type: "set-brief-message-count", briefMessageCount: null });
		const fork = forkConversation(database, { conversationId: chat.id, expectedRevision: chat.revision, name: "Fork", at: { through: chat.messages[0]!.id }, trimVariants: false });
		expect(paintings.read(fork.conversation.id)).toMatchObject({ paintPresetId: preset.id, briefMessageCount: null });
		expect(listPromptPresets(database).find((entry) => entry.id === preset.id)?.conversationCount).toBe(2);
		expect(executePromptPresetCommand(database, { type: "delete", presetId: preset.id, expectedRevision: preset.revision, expectedConversationCount: 2 })).toMatchObject({ kind: "deleted", result: { reassignedConversationCount: 2 } });
		expect(paintings.read(chat.id).paintPresetId).toBe(builtIn.id);
		expect(paintings.read(fork.conversation.id).paintPresetId).toBe(builtIn.id);
	} finally { database.close(); }
});
