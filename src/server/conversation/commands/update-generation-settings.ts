import type { ConversationDatabase } from "../internal";
import {
	updateConversationGenerationSettings,
} from "../generation-settings";
import type {
	ConversationGenerationSettingsInput,
} from "../types";

export interface UpdateGenerationSettingsInput {
	conversationId: number;
	settings: ConversationGenerationSettingsInput;
}

export function updateGenerationSettings(
	db: ConversationDatabase,
	input: UpdateGenerationSettingsInput,
) {
	return updateConversationGenerationSettings(db, input.conversationId, input.settings);
}
