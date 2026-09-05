import { ConversationNotFoundError } from "./errors";
import type {
	ConversationCommand,
	ConversationModule,
	ConversationSnapshot,
} from "./types";

/**
 * ==[HUMAN APPROVED]== Test-fixture seam for suites that assert on Messages
 * after an edit. Mutations return the Conversation header only, so this applies
 * the command through the ordinary public seam and then re-reads the full
 * snapshot. It exists so tests keep exercising `execute` rather than a parallel
 * commit path, and it is therefore absent from the public barrel and every HTTP
 * route. Product code must read history through the paginated seam instead of
 * materializing whole Conversations.
 */
export function applyCommand(
	module: ConversationModule,
	command: ConversationCommand,
): ConversationSnapshot {
	const summary = module.execute(command);
	return requireSnapshot(module, summary.id);
}

export function requireSnapshot(
	module: ConversationModule,
	conversationId: number,
): ConversationSnapshot {
	const snapshot = module.getSnapshot(conversationId);
	if (snapshot === undefined) {
		throw new ConversationNotFoundError(conversationId);
	}
	return snapshot;
}
