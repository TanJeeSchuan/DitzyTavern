// Pure presentation helpers for the Cast drawer's Remove action.
//
// The server derives the removal impact (deletion mode and how many Messages
// lose future sibling Variant generation) and words the typed outcomes; this
// module only formats them for the confirmation dialog and the post-command
// notice. No domain rule is reconstructed here.

import type { CastParticipant, CommandOutcome } from "./conversation";

export interface RemovalConfirmationCopy {
	// Dialog title, e.g. "Remove Juno Ashfeld?".
	title: string;
	// Impact statement shown before confirmation: whether removal hard-deletes
	// or tombstones, and how many Messages lose future sibling generation.
	impact: string;
	// Label of the confirming button; "Close" when the Participant cannot be
	// removed (a seated Participant should never open a removal dialog, but
	// the copy stays typed anyway).
	confirmLabel: string;
}

// The derived count phrase: singular Message versus many.
const generationCountPhrase = (count: number) =>
	count === 1 ? "1 Message will" : `${count} Messages will`;

// Words the confirmation for one Participant from the snapshot-derived
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

export interface RemovalOutcomePresentation {
	// Ordinary drawer notice, or null when the removal applied cleanly.
	notice: string | null;
	// When true, the authoritative Conversation snapshot must be reloaded
	// because the presented state is stale (conflict, not-removable after a
	// Control change, or the Participant is gone).
	reloadConversation: boolean;
}

// Words one remove-participant command outcome. The provided label is the
// server-derived duplicate label of the targeted Participant, used only for
// friendly failure text.
export const presentRemovalOutcome = (
	outcome: CommandOutcome,
	participantLabel: string,
): RemovalOutcomePresentation => {
	switch (outcome.status) {
		case "applied":
			return { notice: null, reloadConversation: false };
		case "conflict":
			return {
				notice: "The Conversation changed elsewhere; the current Cast was loaded.",
				reloadConversation: true,
			};
		case "not-removable":
			return {
				notice: `${participantLabel} now holds a Control seat; reassign it before removing.`,
				reloadConversation: true,
			};
		case "not-found":
			return {
				notice: `${participantLabel} is no longer in this Cast.`,
				reloadConversation: true,
			};
		case "invalid":
			return { notice: outcome.reason, reloadConversation: false };
		case "not-playable":
			return { notice: outcome.reason, reloadConversation: false };
		default:
			return {
				notice: "The Conversation could not be reached.",
				reloadConversation: false,
			};
	}
};
