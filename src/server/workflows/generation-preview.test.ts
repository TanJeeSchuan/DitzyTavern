import { expect, test } from "bun:test";
import { createConversationWithHistory, openObservedDatabase } from "../test-fixtures/conversation";
import { emptyPromptChannels } from "../../shared/definition";
import { consumeGenerationPreview, createGenerationPreviewAsync, previewRecordFor } from "./generation-preview";

test("consuming an accepted preview leaves a replacement preview available", async () => {
	const database = openObservedDatabase();
	try {
		const definition = (name: string) => ({ name, prompt: emptyPromptChannels(), sendAppearanceImages: true, openings: [] });
		const chat = createConversationWithHistory(database, {
			name: "Preview replacement", participants: [{ definition: definition("Writer") }, { definition: definition("Model") }], control: { human: 0, model: 1 },
		});
		const input = { connection: null, conversationId: chat.id, target: { kind: "send", content: "Hello" } } as const;
		const accepted = await createGenerationPreviewAsync(database, input);
		const replacement = await createGenerationPreviewAsync(database, input);
		expect(() => consumeGenerationPreview(database, accepted)).not.toThrow();
		expect(previewRecordFor(database, replacement.id, chat.id).id).toBe(replacement.id);
		consumeGenerationPreview(database, replacement);
		expect(() => consumeGenerationPreview(database, replacement)).not.toThrow();
	} finally {
		database.close();
	}
});
