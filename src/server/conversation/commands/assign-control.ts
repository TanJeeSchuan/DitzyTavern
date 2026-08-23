import { eq } from "drizzle-orm";
import { conversationControlTable } from "../../database/schema";
import { resolveControlChange } from "../../../shared/cast";
import { InvalidConversationCommandError } from "../errors";
import {
	type ConversationDatabase,
	readControlAssignment,
	requireParticipant,
} from "../internal";

export interface AssignControlInput {
	conversationId: number;
	seat: "human" | "model";
	participantId: number;
}

// Writes a complete Control assignment by deleting the Conversation's rows
// and reinserting the occupied seats. Replace-all avoids a temporary unique
// violation on the per-Participant Control index during an atomic swap.
const writeAssignment = (
	db: ConversationDatabase,
	conversationId: number,
	assignment: {
		humanParticipantId: number | null;
		modelParticipantId: number | null;
	},
) => {
	db.delete(conversationControlTable)
		.where(eq(conversationControlTable.chat_id, conversationId))
		.run();
	const rows = [];
	if (assignment.humanParticipantId !== null) {
		rows.push({
			chat_id: conversationId,
			seat: "human" as const,
			participant_id: assignment.humanParticipantId,
		});
	}
	if (assignment.modelParticipantId !== null) {
		rows.push({
			chat_id: conversationId,
			seat: "model" as const,
			participant_id: assignment.modelParticipantId,
		});
	}
	if (rows.length > 0) {
		db.insert(conversationControlTable).values(rows).run();
	}
};

// Assigns one Control seat to a Cast Participant. Selecting the opposite
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
		// The two assignments exchange: the chosen seat receives the selected
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

	writeAssignment(db, input.conversationId, next);
}