import { and, eq, isNull, max } from "drizzle-orm";
import {
	participantOpeningTable,
	participantPromptTable,
	participantTable,
} from "../../database/schema";
import { InvalidConversationCommandError } from "../errors";
import {
	type ConversationDatabase,
	readControlAssignment,
	requireParticipantDefinition,
	writeControlAssignment,
} from "../internal";
import type { ParticipantDefinition } from "../types";

export interface AddParticipantInput {
	conversationId: number;
	definition: ParticipantDefinition;
	sourceCharacterId?: number | undefined;
}

// ==[HUMAN APPROVED]== Appends a new Participant to the stable Cast tail with a complete local
// Definition. Either an ad-hoc Definition or the already-resolved fork of a
// Character (with immutable provenance). Appending never writes history.
//
// Incomplete-import completion is the narrow exception to "never reassigns
// Control": when the Conversation lacks two distinct occupied seats, the new
// Participant fills the first empty seat (human before model), preserving any
// single existing assignment and deriving playability automatically. Complete
// native Conversations are never touched: both seats are always occupied, so
// the append stays a plain Cast addition.
export function addParticipant(
	db: ConversationDatabase,
	input: AddParticipantInput,
) {
	const definition = requireParticipantDefinition(input.definition);
	if (
		input.sourceCharacterId !== undefined &&
		!Number.isInteger(input.sourceCharacterId)
	) {
		throw new InvalidConversationCommandError(
			"Provenance must reference an existing Character.",
		);
	}

	// ==[HUMAN APPROVED]== Append at the stable Cast tail. Only active Participants contribute to
	// the next position: tombstones carry no position and are excluded, so
	// the active roster stays contiguous.
	const latestPosition = db
		.select({ value: max(participantTable.position) })
		.from(participantTable)
		.where(
			and(
				eq(participantTable.chat_id, input.conversationId),
				isNull(participantTable.deleted_at),
			),
		)
		.get()?.value;

	const inserted = db
		.insert(participantTable)
		.values({
			chat_id: input.conversationId,
			name: definition.name,
			position: (latestPosition ?? 0) + 1,
			source_character_id: input.sourceCharacterId ?? null,
		})
		.returning({ id: participantTable.id })
		.get();
	if (inserted === undefined) {
		throw new InvalidConversationCommandError(
			"Participant insertion did not return an identifier.",
		);
	}

	db.insert(participantPromptTable)
		.values({
			participant_id: inserted.id,
			system_instruction: definition.prompt.systemInstruction,
			identity: definition.prompt.identity,
			scenario: definition.prompt.scenario,
			example_dialogue: definition.prompt.exampleDialogue,
			post_history_instruction: definition.prompt.postHistoryInstruction,
		})
		.run();

	if (definition.openings.length > 0) {
		db.insert(participantOpeningTable)
			.values(
				definition.openings.map((content, index) => ({
					participant_id: inserted.id,
					position: index + 1,
					content,
				})),
			)
			.run();
	}

	// ==[HUMAN APPROVED]== Completion fill: only an incomplete Conversation (fewer than two
	// distinct occupied seats) is eligible. Neither seat occupied assigns
	// human first, and a single existing assignment is preserved while the
	// new Participant fills the one empty seat, so the added Participant
	// derives playability automatically without a separate status toggle.
	const control = readControlAssignment(db, input.conversationId);
	if (
		control.humanParticipantId === null ||
		control.modelParticipantId === null
	) {
		const next = {
			humanParticipantId: control.humanParticipantId,
			modelParticipantId: control.modelParticipantId,
		};
		if (next.humanParticipantId === null) {
			next.humanParticipantId = inserted.id;
		} else {
			next.modelParticipantId = inserted.id;
		}
		writeControlAssignment(db, input.conversationId, next);
	}
}