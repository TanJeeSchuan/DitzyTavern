// Public contract of the deep Character Library seam. The module owns
// Character lifecycle, Definitions, revisions, and ordering; callers see
// only these types plus command execution outcomes.

export interface CharacterPrompt {
	readonly systemInstruction: string;
	readonly identity: string;
	readonly scenario: string;
	readonly exampleDialogue: string;
	readonly postHistoryInstruction: string;
}

// A complete reusable identity. Openings are ordered, exact, nonblank
// text entries; an empty list is valid.
export interface CharacterDefinition {
	readonly name: string;
	readonly prompt: CharacterPrompt;
	readonly openings: readonly string[];
}

// Derived deletion impact of one Character: how many Participant provenance
// references (active or tombstoned) currently require a tombstone, and the
// deletion mode that follows from it. Zero references means deletion
// hard-deletes; any reference demands the hidden nonrestorable tombstone.
// Derived, never stored and never reconstructed by clients.
export type CharacterDeletionMode = "hard-delete" | "tombstone";

export interface CharacterDeletionImpact {
	// Participant provenance references (active or tombstoned) pointing at
	// this Character across every Conversation.
	readonly provenanceReferenceCount: number;
	readonly deletionMode: CharacterDeletionMode;
}

// Library list entry without the full Definition payload. The preview is a
// derived short Prompt excerpt so pickers (such as the Cast drawer's
// Character picker) can present a useful choice without fetching one detail
// per Character, and the provenance reference count shows how widely the
// Character is already used.
export interface CharacterSummary {
	readonly id: number;
	readonly name: string;
	readonly revision: number;
	readonly pinned: boolean;
	readonly preview: string;
	// Global provenance reference count (active or tombstoned Participants
	// forked from this Character), so pickers and lists present deletion
	// impact without one detail request per row.
	readonly provenanceReferenceCount: number;
}

// Full authoritative state of one Character.
export interface CharacterSnapshot {
	readonly id: number;
	readonly name: string;
	readonly revision: number;
	readonly pinned: boolean;
	readonly prompt: CharacterPrompt;
	readonly openings: readonly string[];
	// Derived deletion impact presented with every authoritative read so the
	// confirmation flow can show the exact consequence before any command.
	readonly deletionImpact: CharacterDeletionImpact;
}

// Outcome of a confirmed Character deletion. The deletion mode is derived
// from the reference count at command time, never guessed by the client.
export interface CharacterDeletionResult {
	readonly characterId: number;
	readonly deletionMode: CharacterDeletionMode;
}

export type CharacterLibraryCommand =
	| { readonly type: "create"; readonly definition: CharacterDefinition }
	| {
			readonly type: "rename";
			readonly characterId: number;
			readonly expectedRevision: number;
			readonly name: string;
	  }
	| {
			readonly type: "replace-prompt";
			readonly characterId: number;
			readonly expectedRevision: number;
			readonly prompt: CharacterPrompt;
	  }
	| {
			readonly type: "replace-openings";
			readonly characterId: number;
			readonly expectedRevision: number;
			readonly openings: readonly string[];
	  }
	| {
			readonly type: "set-pinned";
			readonly characterId: number;
			readonly expectedRevision: number;
			readonly pinned: boolean;
	  }
	// Confirmed deletion. The expected revision guards against deleting a
	// Character whose impact the caller has not seen. The outcome derives the
	// deletion mode from the current reference count: unreferenced Characters
	// are hard-deleted, referenced ones reduced to a hidden nonrestorable
	// tombstone.
	| {
			readonly type: "delete";
			readonly characterId: number;
			readonly expectedRevision: number;
	  };

export interface CharacterLibraryModule {
	list(): CharacterSummary[];
	get(characterId: number): CharacterSnapshot | undefined;
	// Every mutation except creation requires the expected revision. All
	// commands except deletion return the authoritative updated Character;
	// deletion returns the typed result stating the deletion mode, because a
	// tombstoned or hard-deleted Character no longer has a snapshot. The
	// overloads keep every call site's return type precise.
	execute(command: Extract<CharacterLibraryCommand, { type: "delete" }>): CharacterDeletionResult;
	execute(
		command: Exclude<CharacterLibraryCommand, { type: "delete" }>,
	): CharacterSnapshot;
	execute(
		command: CharacterLibraryCommand,
	): CharacterSnapshot | CharacterDeletionResult;
}
