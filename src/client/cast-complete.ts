// ==[HUMAN APPROVED]== Pure presentation for incomplete imported Conversations.
//
// An imported Chat with fewer than two distinct occupied Control seats is a
// preservation record, not a separate Chat type: it stays readable,
// editable, exportable, configurable, and deletable, while Compose,
// Generate, and Swipe are withheld until the missing seat is filled. The
// server derives playability and the typed capability reasons; this module
// only words the persistent setup surface and the automatic completion from
// adding the missing Participant. No domain rule is reconstructed here.

import type { ConversationSummary } from "./conversation";

export type MissingControlSeat = "human" | "model";

export interface IncompleteSetupCopy {
	// ==[HUMAN APPROVED]== The seat(s) still empty, derived from the authoritative Control
	// assignment (never from role hints or the Cast alone).
	missingSeats: readonly MissingControlSeat[];
	// ==[HUMAN APPROVED]== Persistent setup-surface headline for the incomplete Chat.
	heading: string;
	// ==[HUMAN APPROVED]== Body copy explaining that the preserved history stays usable while
	// play actions are withheld.
	body: string;
	// ==[HUMAN APPROVED]== Mirrors the snapshot-derived capabilities: every play action is
	// unavailable with the same typed conversation-not-playable reason.
	playActionsWithheld: boolean;
	// ==[HUMAN APPROVED]== What adding the missing Participant does; adding is the only path to
	// completion — there is no separate status toggle.
	completion: string;
}

const seatName = (seat: MissingControlSeat) =>
	seat === "human" ? "Writing-as (human)" : "Responding-as (model)";

const completionForMissing = (missingSeats: readonly MissingControlSeat[]): string => {
	if (missingSeats.length === 2) {
		return "Add Participants to fill both seats: the first added Participant takes the Writing-as (human) seat and the second the Responding-as (model) seat, making this Chat playable automatically.";
	}
	if (missingSeats.length === 1) {
		const seat = missingSeats[0] ?? "human";
		const preserved = seat === "human" ? "model" : "human";
		return `Add a Participant to the ${seatName(seat)} seat; the existing ${seatName(preserved)} assignment is preserved and playability follows automatically.`;
	}
	return "";
};

// ==[HUMAN APPROVED]== Words the persistent setup surface for an incomplete imported Chat. Null
// when the Conversation is playable: completion derives from native state,
// so a completed import needs no setup surface at all.
export const incompleteSetupCopy = (
	conversation: ConversationSummary,
): IncompleteSetupCopy | null => {
	// ==[HUMAN APPROVED]== Incomplete is the derived missing-seat state only; a Conversation is
	// playable as soon as both distinct Control seats are occupied.
	if (
		conversation.playable ||
		conversation.controlValidity.reason !== "missing-seat"
	) {
		return null;
	}

	const missingSeats: MissingControlSeat[] = [];
	if (conversation.control.humanParticipantId === null) {
		missingSeats.push("human");
	}
	if (conversation.control.modelParticipantId === null) {
		missingSeats.push("model");
	}

	return {
		missingSeats,
		heading: "This imported Chat is not playable yet",
		body: "Its preserved history stays readable, editable, exportable, and deletable. Compose, Generate, and Swipe are withheld until two distinct Participants occupy the human and model seats.",
		playActionsWithheld: !conversation.capabilities.compose.available,
		completion: completionForMissing(missingSeats),
	};
};