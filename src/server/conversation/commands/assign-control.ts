import { resolveControlChange } from "../../../shared/cast";
import { InvalidConversationCommandError } from "../errors";
import {
	type ConversationDatabase,
	readControlAssignment,
	requireParticipant,
	writeControlAssignment,
} from "../internal";

export interface AssignControlInput {
	conversationId: number;
	seat: "human" | "model";
	participantId: number;
}

// ==[HUMAN APPROVED]== Assigns one Control seat to a Cast Participant. Selecting the opposite
// seat's occupant swaps the two assignments atomically, so a two-person
// Cast can never become locked; selecting an unseated Participant replaces
// only the chosen seat, leaving the displaced occupant active and eligible
// for removal. Seats are never cleared.
export function assignControl(db: ConversationDatabase, input: AssignControlInput) {
	const participant = requireParticipant(
		db,
		input.conversationId,
		input.participantId,
	);
	const current = readControlAssignment(db, input.conversationId);
	const change = resolveControlChange(current, input.seat, input.participantId);

	if (change === "no-change") {
		throw new InvalidConversationCommandError(
			`Participant ${participant.id} already holds the ${input.seat} Control seat.`,
		);
	}

	const next = {
		humanParticipantId: current.humanParticipantId,
		modelParticipantId: current.modelParticipantId,
	};
	if (change === "swap") {
		// ==[HUMAN APPROVED]== The two assignments exchange: the chosen seat receives the selected
		// Participant, and the opposite seat receives the previous occupant of
		// the chosen seat.
		if (input.seat === "human") {
			next.humanParticipantId = input.participantId;
			next.modelParticipantId = current.humanParticipantId;
		} else {
			next.modelParticipantId = input.participantId;
			next.humanParticipantId = current.modelParticipantId;
		}
	} else {
		if (input.seat === "human") {
			next.humanParticipantId = input.participantId;
		} else {
			next.modelParticipantId = input.participantId;
		}
	}

	writeControlAssignment(db, input.conversationId, next);
}