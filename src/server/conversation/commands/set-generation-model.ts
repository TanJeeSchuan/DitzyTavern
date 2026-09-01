import type { ConversationDatabase } from "../internal";
import {
	DEFAULT_CONVERSATION_GENERATION_SETTINGS,
	readConversationGenerationSettings,
	updateConversationGenerationSettings,
} from "../generation-settings";

export interface SetGenerationModelInput {
	conversationId: number;
	modelId: string;
}

// ==[HUMAN APPROVED]== The focused model-selection command: the client submits only the model ID,
// and this handler merges it into the stored Generation Settings inside the
// command transaction. The merge happens server-side so a model selection is
// structurally unable to rewrite any other editor's settings fields the way
// a second client-side full-object writer could.
export function setGenerationModel(
	db: ConversationDatabase,
	input: SetGenerationModelInput,
) {
	const existing = readConversationGenerationSettings(db, input.conversationId);
	return updateConversationGenerationSettings(db, input.conversationId, {
		...(existing ?? DEFAULT_CONVERSATION_GENERATION_SETTINGS),
		modelId: input.modelId,
	});
}
