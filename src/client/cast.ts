// @approved
//  Pure Cast and picker presentation helpers for the client UI. The rules
// here only format data the server already derived authoritatively: the
// Conversation snapshot carries duplicate labels and removal eligibility,
// and the Character Library list carries a Prompt preview. These helpers
// shape the picker and the Control selectors' outcome wording without
// re-deriving domain rules.

import {
	duplicateLabel,
	resolveControlChange,
	type ControlSeat,
} from "../shared/cast";
import type { CharacterSummary } from "./character-library";
import type { ConversationControl } from "./conversation";

export const usedCharacterCount = (
	cast: readonly { sourceCharacterId: number | null }[],
	characterId: number,
): number =>
	cast.filter((participant) => participant.sourceCharacterId === characterId)
		.length;

export interface LibraryPickerEntry {
	character: CharacterSummary;
	label: string;
	preview: string;
	usedCount: number;
}

// @approved
//  Shapes the pinned-first alphabetic Character list into picker entries:
// duplicate labels follow library order, each entry shows its derived Prompt
// preview, and the used-count reports repeated forks while keeping every
// Character selectable.
export const libraryPickerEntries = (
	characters: readonly CharacterSummary[],
	cast: readonly { sourceCharacterId: number | null }[],
): LibraryPickerEntry[] => {
	const occurrences = new Map<string, number>();
	const labels = new Map<number, string>();
	for (const character of characters) {
		const ordinal = (occurrences.get(character.name) ?? 0) + 1;
		occurrences.set(character.name, ordinal);
		labels.set(character.id, duplicateLabel(character.name, ordinal));
	}

	return characters.map((character) => ({
		character,
		label: labels.get(character.id) ?? character.name,
		preview: character.preview,
		usedCount: usedCharacterCount(cast, character.id),
	}));
};

export interface ControlChangeDescription {
	kind: "no-change" | "swap" | "replace";
	notice: string;
}

const seatLabel = (seat: ControlSeat) =>
	seat === "human" ? "Writing as" : "Responding as";

// @approved
//  Words the outcome of assigning `participantId` to `seat` so the composer
// can visibly describe a swap (the opposite seat's occupant) versus a plain
// replacement of one seat. Names are the derived duplicate labels already
// provided by the server snapshot; nothing is invented here.
export const controlChangeDescription = (
	conversation: {
		control: ConversationControl;
		cast: readonly { id: number; duplicateLabel: string }[];
	},
	seat: ControlSeat,
	participantId: number,
): ControlChangeDescription => {
	const participants = new Map<number, string>();
	for (const participant of conversation.cast) {
		participants.set(participant.id, participant.duplicateLabel);
	}
	const control: ConversationControl = conversation.control;
	const occupant =
		seat === "human" ? control.humanParticipantId : control.modelParticipantId;
	const opposite =
		seat === "human" ? control.modelParticipantId : control.humanParticipantId;

	// @approved
	//  The kind of change is decided by the shared resolver so the swap and
	// replace rules never drift between server and client.
	const kind = resolveControlChange(control, seat, participantId);
	if (kind === "no-change") {
		return {
			kind: "no-change",
			notice: `${seatLabel(seat)} is already ${participants.get(participantId) ?? "this Participant"}.`,
		};
	}
	if (opposite === participantId) {
		const otherSeat: ControlSeat = seat === "human" ? "model" : "human";
		return {
			kind,
			notice: `Swap: ${participants.get(participantId) ?? "this Participant"} and ${participants.get(occupant ?? -1) ?? "the other seat"} exchange the ${seatLabel(seat)} and ${seatLabel(otherSeat)} seats.`,
		};
	}
	return {
		kind,
		notice: `Take over ${seatLabel(seat)} with ${participants.get(participantId) ?? "this Participant"}; the previous occupant becomes removable.`,
	};
};