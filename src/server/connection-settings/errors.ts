import type { ConnectionSettingsSnapshot } from "./types";

export class InvalidConnectionProfileError extends Error {
	readonly outcome = "invalid" as const;

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

	constructor() {
		super("Resetting a Connection Credential requires explicit confirmation.");
		this.name = "ConnectionCredentialConfirmationError";
	}
}

export class StaleConnectionSettingsRevisionError extends Error {
	readonly outcome = "conflict" as const;

	readonly expectedRevision: number;
	readonly actualRevision: number;
	readonly currentSettings: ConnectionSettingsSnapshot;

	constructor(
		expectedRevision: number,
		actualRevision: number,
		currentSettings: ConnectionSettingsSnapshot,
	) {
		super(
			`Connection Settings revision ${expectedRevision} is stale; current revision is ${actualRevision}.`,
		);
		this.name = "StaleConnectionSettingsRevisionError";
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
		this.currentSettings = currentSettings;
	}
}
