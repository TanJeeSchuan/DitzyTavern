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
