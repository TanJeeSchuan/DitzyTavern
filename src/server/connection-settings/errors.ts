export class InvalidConnectionProfileError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };

	constructor(message: string) {
		super(message);
		this.name = "InvalidConnectionProfileError";
	}
}

export class ConnectionProfileNotFoundError extends Error {
	readonly outcome = "not-found" as const;

	constructor(profileId: number) {
		super(`Connection Profile ${profileId} was not found.`);
		this.name = "ConnectionProfileNotFoundError";
	}
}

export class ConnectionProfileNameConflictError extends InvalidConnectionProfileError {
	constructor(displayName: string) {
		super(`A Connection Profile named "${displayName}" already exists.`);
		this.name = "ConnectionProfileNameConflictError";
	}
}

export class ConnectionCredentialConfirmationError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };

	constructor() {
		super("Resetting a Connection Credential requires explicit confirmation.");
		this.name = "ConnectionCredentialConfirmationError";
	}
}
