export class LorebookNotFoundError extends Error {
	readonly outcome = "not-found" as const;

	constructor(readonly bookId: number) {
		super(`Lorebook ${bookId} was not found.`);
		this.name = "LorebookNotFoundError";
	}
}

export class LorebookEntryNotFoundError extends Error {
	readonly outcome = "not-found" as const;

	constructor(readonly entryId: number) {
		super(`Lorebook entry ${entryId} was not found.`);
		this.name = "LorebookEntryNotFoundError";
	}
}

export class InvalidLorebookCommandError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };

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

