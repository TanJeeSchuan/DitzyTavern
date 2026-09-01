import {
	applyConversationCommand,
	type ConversationSummary,
} from "./conversation";
import {
	runConversationCommand,
	type ConversationCommandReconciliation,
} from "./conversation-command-runner";

// ==[HUMAN APPROVED]== The wording this surface shows whenever the model-selection command could
// not be saved; the runner owns when each notice appears.
export const MODEL_SELECTION_UNAVAILABLE_NOTICE = "The model selection could not be saved.";

const MODEL_COMMIT_NOTICES = {
	conflict: "This Conversation changed elsewhere. The model selection was not saved.",
	notFound: MODEL_SELECTION_UNAVAILABLE_NOTICE,
	unreachable: MODEL_SELECTION_UNAVAILABLE_NOTICE,
};

export interface CommitConversationModelOptions {
	conversation: ConversationSummary;
	modelId: string;
	reconciliation: ConversationCommandReconciliation;
	// ==[HUMAN APPROVED]== Applied-commit work owned by the selector's own state (display sync,
	// closing the combobox).
	onCommitted: (modelId: string) => void;
	// ==[HUMAN APPROVED]== The typed Conversation-state outcomes keep their precise meaning; the
	// selector presents them as one unavailable notice.
	onUnavailable: (reason: string) => void;
}

// ==[HUMAN APPROVED]== The composer's focused model-selection command: selecting a model sends
// only the model ID, and the Conversation module merges it into the stored
// Generation Settings inside the command transaction. The selector owns no
// settings snapshot, so it structurally cannot restore another editor's
// fields the way a second full-object writer could.
export function commitConversationModel(options: CommitConversationModelOptions): Promise<void> {
	return runConversationCommand({
		revision: () => options.conversation.revision,
		send: (expectedRevision) =>
			applyConversationCommand(options.conversation.id, expectedRevision, {
				type: "set-generation-model",
				modelId: options.modelId,
			}),
		reconciliation: options.reconciliation,
		notices: MODEL_COMMIT_NOTICES,
		callbacks: {
			onApplied: () => options.onCommitted(options.modelId),
			onNotPlayable: options.onUnavailable,
			onNotRemovable: options.onUnavailable,
		},
	});
}
