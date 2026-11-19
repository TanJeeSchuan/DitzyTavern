import { expect, test } from "bun:test";
import { createConversationWithHistory, openObservedDatabase, participantDefinition as definition } from "../test-fixtures/conversation";
import { consumeGenerationPreview, createGenerationPreviewAsync, previewRecordFor } from "./generation-preview";

test("consuming an accepted preview leaves a replacement preview available", async () => {
	const database = openObservedDatabase();
	try {
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
