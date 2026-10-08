import type { MessageSwipeBlockReason, ParticipantRemovalBlockReason } from "./types";

export class ConversationNotFoundError extends Error {
	readonly outcome = "not-found" as const;

	constructor(conversationId: number) {
		super(`Conversation ${conversationId} was not found.`);
		this.name = "ConversationNotFoundError";
	}
}

export class StaleConversationRevisionError extends Error {
	readonly outcome = "conflict" as const;
	readonly details = { reason: this.message };

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

// @approved
//  Typed not-found outcome for a Participant that does not exist in (or no
// longer belongs to) a Conversation. Cross-module workflows surface this
// instead of a generic validation message so clients can recover with a
// 404 rather than guessing. Matching the Conversation model, the whole
// Conversation is implied by the participant's chat reference.
export class ParticipantNotFoundError extends Error {
	readonly outcome = "not-found" as const;

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
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };

	constructor(message: string) {
		super(message);
		this.name = "InvalidConversationCommandError";
	}
}

export class InvalidConversationCreationError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };

	constructor(message: string) {
		super(message);
		this.name = "InvalidConversationCreationError";
	}
}

// @approved
//  Typed outcome for unavailable historical generation context: a targeted
// Swipe (new sibling Variant) is denied either because the target Message
// has no captured historical Control pair, or because a Participant of its
// historical pair no longer has a usable Definition. Existing Variants
// remain selectable and editable; only new sibling generation is blocked.
export class SiblingVariantUnavailableError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };

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

// @approved
//  Typed outcome for removing a seated Participant: removal eligibility is
// derived on the snapshot, and the command enforces the same rule. The
// reason tells clients why the Participant cannot be removed (Control must
// be reassigned first) without inventing rules transport-side.
export class ParticipantNotRemovableError extends Error {
	readonly outcome = "not-removable" as const;
	readonly details;

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
		this.details = { reason: this.reason };
	}
}

// @approved
//  Typed outcome for play-gated actions (Compose, Generate, Swipe) in a
// Conversation whose two Control seats are not both occupied.
export class ConversationNotPlayableError extends Error {
	readonly outcome = "not-playable" as const;
	readonly details = { reason: this.message };

	constructor(conversationId: number) {
		super(
			`Conversation ${conversationId} is not playable: two distinct Participants must occupy the human and model seats.`,
		);
		this.name = "ConversationNotPlayableError";
	}
}

export type ContinuationUnavailableReason =
	| "active-generation"
	| "not-terminal-model-message"
	| "assistant-prefill-requires-visible-text";

// @approved
//  The composition contract, thrown instead of silently dropping a
// reported write change: a Conversation write reported its
// ConversationMemoryChange, but the composition owning the write's database
// never registered an observer with observeConversationWrites(database,
// observer). The throwing transaction rolls back so the missing wiring cannot
// pass unnoticed; app.ts installs the sync for the application database and
// every test composition installs it for its own database.
export class ConversationWriteObserverMissingError extends Error {
	constructor() {
		super(
			"A Conversation write reported a change, but no write observer is registered for this database. Install one with observeConversationWrites(database, observer).",
		);
		this.name = "ConversationWriteObserverMissingError";
	}
}

// @approved
//  Typed denial for Continue. Existing history remains untouched and callers
// can present the reason without reproducing the terminal-position rule.
export class ContinuationUnavailableError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };

	readonly reason: ContinuationUnavailableReason;

	constructor(reason: ContinuationUnavailableReason) {
		super(
			reason === "active-generation"
				? "Continue is unavailable while this Conversation has an Active Generation."
				: reason === "assistant-prefill-requires-visible-text"
					? "Assistant prefill is unavailable because the preceding Variant has no visible model text."
					: "Continue is available only after a terminal model-authored Message.",
		);
		this.name = "ContinuationUnavailableError";
		this.reason = reason;
	}
}
