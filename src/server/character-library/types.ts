import type {
	CharacterCommand,
	CharacterDeletionImpact,
	CharacterDeletionMode,
	CharacterDeletionResult,
	CharacterDefinition,
	CharacterLibrarySummary,
	CharacterSnapshot,
} from "../../shared/contract/character-library";
import type { ImagePool } from "../image";

// Public contract of the deep Character Library seam. The module owns
// Character lifecycle, Definitions, revisions, and ordering; callers see
// only these types plus command execution outcomes. Every Character shape
// is the canonical shared wire schema's Static type, re-exported under the
// seam's historical names so the domain can never drift from the transport
// contract.

// A complete reusable identity. Openings are ordered, exact, nonblank
// text entries; an empty list is valid.
export type { CharacterDefinition };

// Derived deletion impact of one Character: how many Participant provenance
// references (active or tombstoned) currently require a tombstone, and the
// deletion mode that follows from it. Zero references means deletion
// hard-deletes; any reference demands the hidden nonrestorable tombstone.
// Derived, never stored and never reconstructed by clients.
export type { CharacterDeletionMode, CharacterDeletionImpact };

// Library list entry without the full Definition payload. The preview is a
// derived short Prompt excerpt so pickers (such as the Cast drawer's
// Character picker) can present a useful choice without fetching one detail
// per Character, and the provenance reference count shows how widely the
// Character is already used.
export type { CharacterLibrarySummary as CharacterSummary };

// Full authoritative state of one Character.
export type { CharacterSnapshot };

// Outcome of a confirmed Character deletion. The deletion mode is derived
// from the reference count at command time, never guessed by the client.
export type { CharacterDeletionResult };

export type { CharacterCommand as CharacterLibraryCommand };

export interface CharacterLibraryModule {
	list(): CharacterLibrarySummary[];
	get(characterId: number): CharacterSnapshot | undefined;
	// Every mutation except creation requires the expected revision. All
	// commands except deletion return the authoritative updated Character;
	// deletion returns the typed result stating the deletion mode, because a
	// tombstoned or hard-deleted Character no longer has a snapshot. The
	// overloads keep every call site's return type precise.
	execute(command: Extract<CharacterCommand, { type: "delete" }>): CharacterDeletionResult;
	execute(
		command: Exclude<CharacterCommand, { type: "delete" }>,
		images?: ImagePool,
	): CharacterSnapshot;
	execute(
		command: CharacterCommand,
		images?: ImagePool,
	): CharacterSnapshot | CharacterDeletionResult;
}
