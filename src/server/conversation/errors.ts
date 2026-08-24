import type { MessageSwipeBlockReason, ParticipantRemovalBlockReason } from "./types";

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

// Typed not-found outcome for a Participant that does not exist in (or no
// longer belongs to) a Conversation. Cross-module workflows surface this
// instead of a generic validation message so clients can recover with a
// 404 rather than guessing. Matching the Conversation model, the whole
// Conversation is implied by the participant's chat reference.
export class ParticipantNotFoundError extends Error {
	readonly conversationId: number;
	readonly participantId: number;

	constructor(conversationId: number, participantId: number) {
		super(
			`Participant ${participantId} was not found in Conversation ${conversationId}.`,
		);
		this.name = "ParticipantNotFoundError";
		this.conversationId = conversationId;
		this.participantId = participantId;
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

// Typed outcome for removing a seated Participant: removal eligibility is
// derived on the snapshot, and the command enforces the same rule. The
// reason tells clients why the Participant cannot be removed (Control must
// be reassigned first) without inventing rules transport-side.
export class ParticipantNotRemovableError extends Error {
	readonly reason: ParticipantRemovalBlockReason;
	readonly conversationId: number;
	readonly participantId: number;

	constructor(conversationId: number, participantId: number) {
		super(
			`Participant ${participantId} of Conversation ${conversationId} cannot be removed: it holds a Control seat. Assign the seat to another Cast Participant first.`,
		);
		this.name = "ParticipantNotRemovableError";
		this.reason = "control-assigned";
		this.conversationId = conversationId;
		this.participantId = participantId;
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
