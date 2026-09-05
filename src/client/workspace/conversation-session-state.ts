import type { ConversationSummary } from "../conversation";

export function adoptConversationSummary(
	current: ConversationSummary | null,
	incoming: ConversationSummary | null,
	activeChatId: string | number,
): ConversationSummary | null {
	if (incoming === null) return null;
	if (Number(incoming.id) !== Number(activeChatId)) return current;
	return current === null || current.id !== incoming.id || incoming.revision >= current.revision ? incoming : current;
}
