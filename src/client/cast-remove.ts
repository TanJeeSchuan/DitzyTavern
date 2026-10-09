// @approved
//  Pure presentation helpers for the Cast drawer's Remove action.
// The server derives the removal impact (deletion mode and how many Messages
// lose future sibling Variant generation); this module words that snapshot-
// derived impact for the confirmation dialog. The command's typed outcomes
// are reconciled by the Conversation command runner plus the drawer's typed
// callbacks, so no post-command outcome switch lives here.

import type { CastParticipant } from "./conversation";

export interface RemovalConfirmationCopy {
	// @approved
	//  Dialog title, e.g. "Remove Juno Ashfeld?".
	title: string;
	// @approved
	//  Impact statement shown before confirmation: whether removal hard-deletes
	// or tombstones, and how many Messages lose future sibling generation.
	impact: string;
	// @approved
	//  Label of the confirming button; "Close" when the Participant cannot be
	// removed (a seated Participant should never open a removal dialog, but
	// the copy stays typed anyway).
	confirmLabel: string;
}

// @approved
//  The derived count phrase: singular Message versus many.
const generationCountPhrase = (count: number) =>
	count === 1 ? "1 Message will" : `${count} Messages will`;

// @approved
//  Words the confirmation for one Participant from the snapshot-derived
// removal eligibility. Seated Participants describe the required Control
// change instead of an impact.
export const removalConfirmationCopy = (
	participantLabel: string,
	removal: CastParticipant["removal"],
): RemovalConfirmationCopy => {
	if (!removal.eligible || removal.deletionMode === null) {
		return {
			title: `${participantLabel} cannot be removed`,
			impact: `This Participant holds a Control seat. Reassign the seat first so ${participantLabel} becomes removable.`,
			confirmLabel: "Close",
		};
	}
	if (removal.deletionMode === "tombstone") {
		const affected = removal.affectedGenerationCount;
		return {
			title: `Remove ${participantLabel}?`,
			impact:
				affected === 0
					? `Removing ${participantLabel} leaves a nonrestorable tombstone: history keeps displaying its captured name, but the Participant is gone for good.`
					: `Removing ${participantLabel} leaves a nonrestorable tombstone: history keeps displaying its captured name, and ${generationCountPhrase(affected)} lose the ability to generate new sibling Variants.`,
			confirmLabel: "Remove",
		};
	}
	return {
		title: `Remove ${participantLabel}?`,
		impact: `Removing ${participantLabel} permanently deletes it. No history refers to it, so nothing is retained.`,
		confirmLabel: "Remove",
	};
};
