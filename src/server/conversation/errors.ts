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
