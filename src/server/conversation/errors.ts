import type { MessageSwipeBlockReason } from "./types";

export class ConversationNotFoundError extends Error {
	constructor(conversationId: number) {
		super(`Conversation ${conversationId} was not found.`);
		this.name = "ConversationNotFoundError";
	}
}

export class StaleConversationRevisionError extends Error {
	readonly expectedRevision: number;
	readonly actualRevision: number;

	constructor(expectedRevision: number, actualRevision: number) {
		super(
			`Expected Conversation revision ${expectedRevision}, but the current revision is ${actualRevision}.`,
		);
		this.name = "StaleConversationRevisionError";
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
	}
}

export class InvalidConversationCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidConversationCommandError";
	}
}

export class InvalidConversationCreationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidConversationCreationError";
	}
}

// Typed outcome for unavailable historical generation context: a targeted
// Swipe (new sibling Variant) is denied either because the target Message
// has no captured historical Control pair, or because a Participant of its
// historical pair no longer has a usable Definition. Existing Variants
// remain selectable and editable; only new sibling generation is blocked.
export class SiblingVariantUnavailableError extends Error {
	readonly reason: Exclude<MessageSwipeBlockReason, "conversation-not-playable">;

	constructor(
		reason: Exclude<MessageSwipeBlockReason, "conversation-not-playable">,
	) {
		super(
			reason === "missing-historical-context"
				? "A new sibling Variant cannot be generated: the target Message has no captured historical Control context."
				: "A new sibling Variant cannot be generated: a Participant of the target Message's historical Control pair no longer has a usable Definition.",
		);
		this.name = "SiblingVariantUnavailableError";
		this.reason = reason;
	}
}

// Typed outcome for play-gated actions (Compose, Generate, Swipe) in a
// Conversation whose two Control seats are not both occupied.
export class ConversationNotPlayableError extends Error {
	constructor(conversationId: number) {
		super(
			`Conversation ${conversationId} is not playable: two distinct Participants must occupy the human and model seats.`,
		);
		this.name = "ConversationNotPlayableError";
	}
}
