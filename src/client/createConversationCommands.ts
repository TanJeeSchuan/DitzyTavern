import { applyConversationCommand, type ConversationAction, type ConversationSummary } from "./conversation";
import { runConversationCommand, type ConversationCommandCallbacks, type ConversationCommandNotices, type ConversationCommandOptions } from "./conversation-command-runner";
import { CONVERSATION_CONFLICT_RELOAD_NOTICE, CONVERSATION_UNREACHABLE_NOTICE } from "./conversation-command-runner";

interface ConversationCommandSurface {
	revision: () => number | null;
	onConversationChange: (conversation: ConversationSummary) => void;
	setNotice: (notice: string) => void;
}

interface RunOptions<Operation> extends Partial<ConversationCommandCallbacks<Operation>> {
	notices?: Partial<ConversationCommandNotices>;
	isCurrent?: () => boolean;
}

export function createConversationCommands(conversationId: number | null, surface: ConversationCommandSurface) {
	return {
		run: <Operation = never>(action: ConversationAction | ConversationCommandOptions<Operation>["send"], options: RunOptions<Operation> = {}) => runConversationCommand({
			revision: surface.revision,
			send: "type" in action ? (revision) => applyConversationCommand(conversationId!, revision, action) : action,
			reconciliation: {
				adoptSnapshot: (snapshot) => { if (options.isCurrent?.() !== false) surface.onConversationChange(snapshot); },
				showNotice: (notice) => { if (options.isCurrent?.() !== false) surface.setNotice(notice); },
			},
			notices: { conflict: CONVERSATION_CONFLICT_RELOAD_NOTICE, notFound: CONVERSATION_UNREACHABLE_NOTICE, unreachable: CONVERSATION_UNREACHABLE_NOTICE, ...options.notices },
			callbacks: {
				onApplied: (snapshot) => { if (options.isCurrent?.() !== false) options.onApplied?.(snapshot); },
				onConflict: (snapshot) => { if (options.isCurrent?.() !== false) options.onConflict?.(snapshot); },
				onOperation: (operation) => { if (options.isCurrent?.() !== false) options.onOperation?.(operation); },
				onNotPlayable: (reason) => {
					if (options.isCurrent?.() !== false) (options.onNotPlayable ?? (() => surface.setNotice(CONVERSATION_UNREACHABLE_NOTICE)))(reason);
				},
				onNotRemovable: (reason) => { if (options.isCurrent?.() !== false) (options.onNotRemovable ?? surface.setNotice)(reason); },
			},
		}),
	};
}
