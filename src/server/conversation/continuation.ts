import type { AuthorStampSnapshot, ConversationControlSnapshot, HistoricalControlSnapshot } from "./types";
import type { ContinuationUnavailableReason } from "./errors";

export function authorRoleOf(
	message: { author: Pick<AuthorStampSnapshot, "participantId"> | null; historicalContext: HistoricalControlSnapshot | null },
	control: ConversationControlSnapshot,
): "human" | "model" | null {
	const id = message.author?.participantId;
	if (id === undefined || id === null) return null;
	if (id === control.modelParticipantId || id === message.historicalContext?.modelParticipantId) return "model";
	if (id === control.humanParticipantId || id === message.historicalContext?.humanParticipantId) return "human";
	return null;
}

export function continuationEligibility(
	message: { authorRole: "human" | "model" | null; content: string; hasReasoning: boolean },
	strategy: string,
): ContinuationUnavailableReason | null {
	if (message.authorRole !== "model") return "not-terminal-model-message";
	if (message.content.length > 0 || (strategy === "instruction" && message.hasReasoning)) return null;
	return strategy === "assistant-prefill" && message.hasReasoning
		? "assistant-prefill-requires-visible-text"
		: "not-terminal-model-message";
}
