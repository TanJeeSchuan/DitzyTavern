export class SillyTavernImportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SillyTavernImportError";
	}
}

// @approved
//  The staged flow handle does not exist: the server restarted (the staging
// registry is session-bound and in-memory) or the handle was already
// discarded. The flow expired and the client must reselect the file.
export class StagedChatImportExpiredError extends Error {
	constructor() {
		super("This staged import could not be resumed; the server restarted or the flow was discarded.");
		this.name = "StagedChatImportExpiredError";
	}
}

// @approved
//  The staged handle still exists but the staged bytes no longer satisfy the
// byte length and SHA-256 the handle was bound to. The file was cleaned up
// or corrupted; the flow cannot continue and the client must reselect.
export class StagedChatImportUnavailableError extends Error {
	// @approved
	//  "missing" when the staged file is gone, "corrupt" when its bytes fail
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

// @approved
//  The client supplied a SHA-256 that does not match the hash the handle was
// bound to. The preview can never be trusted against a different hash, so
// the request is rejected without touching the staged flow.
export class StagedChatImportTokenMismatchError extends Error {
	constructor() {
		super("The supplied source SHA-256 does not match this staged import.");
		this.name = "StagedChatImportTokenMismatchError";
	}
}

// @approved
//  The user-confirmed resolution plan cannot be committed as it stands: a
// Participant name is blank, a Message is unassigned, assigned twice, or
// references an unknown position, or a fork references a Character that no
// longer exists. The failure is recoverable: the staged preview, the staged
// bytes, and every resolution choice stay intact for correction.
export class StagedChatImportPlanError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StagedChatImportPlanError";
	}
}

// @approved
//  The staged source is an exact duplicate (matching raw-byte SHA-256) of a
// prior import, and the user has not yet explicitly confirmed the
// independent-copy intent. The commit is refused until that confirmation;
// the staged preview and every resolution choice stay intact.
export class StagedChatImportDuplicateConfirmationError extends Error {
	constructor() {
		super(
			"This exact source was already imported. Confirm that you want to import another independent copy.",
		);
		this.name = "StagedChatImportDuplicateConfirmationError";
	}
}