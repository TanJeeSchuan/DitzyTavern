export class SillyTavernImportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SillyTavernImportError";
	}
}

// The staged flow handle does not exist: the server restarted (the staging
// registry is session-bound and in-memory) or the handle was already
// discarded. The flow expired and the client must reselect the file.
export class StagedChatImportExpiredError extends Error {
	constructor() {
		super("This staged import could not be resumed; the server restarted or the flow was discarded.");
		this.name = "StagedChatImportExpiredError";
	}
}

// The staged handle still exists but the staged bytes no longer satisfy the
// byte length and SHA-256 the handle was bound to. The file was cleaned up
// or corrupted; the flow cannot continue and the client must reselect.
export class StagedChatImportUnavailableError extends Error {
	// "missing" when the staged file is gone, "corrupt" when its bytes fail
	// verification against the bound length and SHA-256.
	constructor(public readonly reason: "missing" | "corrupt") {
		super(
			reason === "missing"
				? "The staged source file is no longer available."
				: "The staged source file no longer matches the uploaded bytes.",
		);
		this.name = "StagedChatImportUnavailableError";
	}
}

// The client supplied a SHA-256 that does not match the hash the handle was
// bound to. The preview can never be trusted against a different hash, so
// the request is rejected without touching the staged flow.
export class StagedChatImportTokenMismatchError extends Error {
	constructor() {
		super("The supplied source SHA-256 does not match this staged import.");
		this.name = "StagedChatImportTokenMismatchError";
	}
}