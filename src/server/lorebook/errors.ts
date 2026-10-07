import type { Lorebook } from "../../shared/contract/lorebook";

export class LorebookNotFoundError extends Error {
	constructor(readonly bookId: number) {
		super(`Lorebook ${bookId} was not found.`);
		this.name = "LorebookNotFoundError";
	}
}

export class LorebookEntryNotFoundError extends Error {
	constructor(readonly entryId: number) {
		super(`Lorebook entry ${entryId} was not found.`);
		this.name = "LorebookEntryNotFoundError";
	}
}

export class InvalidLorebookCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidLorebookCommandError";
	}
}

export class InvalidLorebookExpressionError extends Error {
	constructor(readonly expression: string, cause?: unknown) {
		super(`Lorebook expression ${JSON.stringify(expression)} is invalid.`);
		this.name = "InvalidLorebookExpressionError";
		if (cause !== undefined) this.cause = cause;
	}
}

export class StaleLorebookRevisionError extends Error {
	constructor(
		readonly bookId: number,
		readonly expectedRevision: number,
		readonly actualRevision: number,
		readonly currentBook: Lorebook,
	) {
		super(`Expected Lorebook ${bookId} revision ${expectedRevision}, but the current revision is ${actualRevision}.`);
		this.name = "StaleLorebookRevisionError";
	}
}

// ==[HUMAN APPROVED]== Typed revision conflict for the two Character-owned Lore attachment
// commands: the Character whose Lore attachments the command mutates moved
// elsewhere between the client's read and this write. The recovery payload
// re-reads the owner's attachment state, so the error carries only the
// identifiers the route needs.
export class StaleLoreAttachmentOwnerRevisionError extends Error {
	constructor(
		readonly characterId: number,
		readonly expectedRevision: number,
		readonly actualRevision: number,
	) {
		super(`Expected Character ${characterId} revision ${expectedRevision}, but the current revision is ${actualRevision}.`);
		this.name = "StaleLoreAttachmentOwnerRevisionError";
	}
}
