import type {
	CharacterDeletionImpact,
	CharacterDeletionMode,
} from "./character-library";

// ==[HUMAN APPROVED]== Focused UI-boundary presentation for Character deletion in the Character
// Library panel. These shape confirmation copy, list labels, and success
// notices only; the deletion behavior itself lives behind the server seam.

export interface DeletionConfirmationCopy {
	title: string;
	impact: string;
	confirmLabel: string;
}

// The confirmation must clearly distinguish hard deletion from retained
// ==[HUMAN APPROVED]== tombstoning before any command is sent. The mode is derived server-side
// from the same provenance reference count presented here, so the copy can
// never contradict the executed behavior.
export function deletionConfirmationCopy(
	name: string,
	impact: CharacterDeletionImpact,
): DeletionConfirmationCopy {
	const title = `Delete ${name}?`;
	if (impact.provenanceReferenceCount === 0) {
		return {
			title,
			impact:
				"No Participant in any Chat references this Character, so deleting it removes it from the Library permanently. Existing Chat Participants are unchanged.",
			confirmLabel: "Yes, delete permanently",
		};
	}
	return {
		title,
		impact: `This Character is referenced by ${impact.provenanceReferenceCount} Participant${impact.provenanceReferenceCount === 1 ? "" : "s"} in your Chats, so deleting it removes it from the Library permanently and retains a hidden tombstone that keeps their provenance traceable. Existing Chat Participants keep their definitions and are unchanged.`,
		confirmLabel:
			impact.deletionMode === "tombstone"
				? "Yes, retain a hidden tombstone"
				: "Yes, delete permanently",
	};
}

// Short human label for the global provenance reference count presented on
// ==[HUMAN APPROVED]== every library list row (and used by pickers to show how widely a
// Character is already used).
export function usedCountLabel(count: number): string {
	if (count === 0) return "Not used in any Chat";
	if (count === 1) return "Used 1 time";
	return `Used ${count} times`;
}

// Success notice after a confirmed deletion. The typed result carries the
// ==[HUMAN APPROVED]== derived mode, so the wording matches what the server actually did: a
// tombstoned Character is gone from the Library but kept traceable; a
// hard-deleted one is gone entirely. Existing Chat Participants are never
// altered by either path.
export function deletionResultNotice(
	result: { deletionMode: CharacterDeletionMode },
): string {
	return result.deletionMode === "tombstone"
		? "Character removed from the Library. Existing Chat Participants keep their definitions and provenance, but this entry cannot be restored."
		: "Character deleted permanently. Existing Chat Participants are unchanged.";
}