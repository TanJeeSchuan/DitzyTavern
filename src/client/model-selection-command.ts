import type { ConversationSummary } from "./conversation";
import { runConversationCommand, type ConversationCommandSurface } from "./conversation-command-runner";

// @approved
//  The wording this surface shows whenever the model-selection command could
//  not be saved; the runner owns when each notice appears.
export const MODEL_SELECTION_UNAVAILABLE_NOTICE = "The model selection could not be saved.";

const MODEL_COMMIT_NOTICES = {
	conflict: "This Conversation changed elsewhere. The model selection was not saved.",
	notFound: MODEL_SELECTION_UNAVAILABLE_NOTICE,
	unreachable: MODEL_SELECTION_UNAVAILABLE_NOTICE,
};

export interface CommitConversationModelOptions {
	connectionProfileId: number;
	modelId: string;
	surface: ConversationCommandSurface;
	// @approved
	//  Applied-commit work owned by the selector's own state (display sync,
	// closing the combobox).
	onCommitted: (modelId: string, conversation: ConversationSummary) => void;
}

// @approved
//  The composer's focused model-selection command: selecting a model sends
//  only the model ID, and the Conversation module merges it into the stored
//  Generation Settings inside the command transaction. The selector owns no
//  settings snapshot, so it structurally cannot restore another editor's
//  fields the way a second full-object writer could.
export function commitConversationModel(options: CommitConversationModelOptions): Promise<void> {
	return runConversationCommand(options.surface, {
		type: "set-generation-model",
		connectionProfileId: options.connectionProfileId,
		modelId: options.modelId,
	}, {
		notices: MODEL_COMMIT_NOTICES,
		onApplied: (conversation) => options.onCommitted(options.modelId, conversation),
	});
}
