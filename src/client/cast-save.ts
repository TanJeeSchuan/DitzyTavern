// Pure presentation helpers for the Cast drawer's Save as Character action.
//
// The server workflow returns a small set of typed outcomes; this module
// words them for the drawer (notice text plus whether a navigation action to
// the new Library entry should be offered) without re-deriving any domain
// rules. The action itself never touches Participant editor drafts: the
// presentation returns only notice and navigation state, so local editing
// state is left exactly as the user typed it.

import type { SaveParticipantAsCharacterOutcome } from "./conversation";

// The minimal reference the drawer needs to offer navigation into the new
// Character Library entry. Internal identifiers are not displayed anywhere.
export interface SavedCharacterReference {
	id: number;
	name: string;
}

export interface SaveAsCharacterPresentation {
	// Ordinary drawer notice, or null when the save succeeded cleanly.
	notice: string | null;
	// When set, the save succeeded and the UI may offer a navigation action
	// to the new Character Library entry.
	savedCharacter: SavedCharacterReference | null;
	// When true, the authoritative Conversation snapshot must be reloaded
	// because the presented state is stale (conflict) or the Participant is
	// gone (not-found). Reloading never rewrites local drafts.
	reloadConversation: boolean;
}

// Words one Save-as-Character outcome. The provided label is the server-
// derived duplicate label of the targeted Participant, used only for
// friendly failure text; nothing about the outcome is invented here.
export const presentSaveParticipantOutcome = (
	outcome: SaveParticipantAsCharacterOutcome,
	participantLabel: string,
): SaveAsCharacterPresentation => {
	switch (outcome.status) {
		case "applied":
			return {
				notice: null,
				savedCharacter: {
					id: outcome.character.id,
					name: outcome.character.name,
				},
				reloadConversation: false,
			};
		case "conflict":
			return {
				notice: "The Conversation changed elsewhere; the current Cast was loaded.",
				savedCharacter: null,
				reloadConversation: true,
			};
		case "not-found":
			return {
				notice: `${participantLabel} is no longer in this Cast.`,
				savedCharacter: null,
				reloadConversation: true,
			};
		case "invalid":
			return {
				notice: outcome.reason,
				savedCharacter: null,
				reloadConversation: false,
			};
		default:
			return {
				notice: "The Library could not be reached.",
				savedCharacter: null,
				reloadConversation: false,
			};
	}
};