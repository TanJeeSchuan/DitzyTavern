import { isActive } from "../../database/is-active";
import { and, asc, eq } from "drizzle-orm";
import { tombstone } from "../tombstone";
import { participantTable } from "../../database/schema";
import { resequence } from "../../database/resequence";
import { ParticipantNotRemovableError } from "../errors";
import {
	type ConversationDatabase,
	readControlAssignment,
	requireParticipant,
} from "../internal";

export interface RemoveParticipantInput {
	conversationId: number;
	participantId: number;
}

export function removeParticipant(
	db: ConversationDatabase,
	input: RemoveParticipantInput,
) {
	const participant = requireParticipant(
		db,
		input.conversationId,
		input.participantId,
	);

	const control = readControlAssignment(db, input.conversationId);
	if (
		participant.id === control.humanParticipantId ||
		participant.id === control.modelParticipantId
	) {
		throw new ParticipantNotRemovableError(
			input.conversationId,
			participant.id,
		);
	}

	tombstone(db, participant);

	// @approved
	//  Compacting the active Cast positions transactionally keeps the active
	// roster contiguous after either removal path: resequencing the rows that
	// remain re-densifies them onto 1..N, which is what shifting every later
	// position down by one maintained while positions are dense.
	const remaining = db
		.select({ id: participantTable.id })
		.from(participantTable)
		.where(
			and(
				eq(participantTable.conversation_id, input.conversationId),
				isActive(participantTable),
			),
		)
		.orderBy(asc(participantTable.position))
		.all();
	resequence(
		db,
		participantTable,
		participantTable.conversation_id,
		input.conversationId,
		remaining.map((row) => row.id),
	);
}
