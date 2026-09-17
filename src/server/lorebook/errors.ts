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
