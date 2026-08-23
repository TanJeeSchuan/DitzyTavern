import { and, eq, isNull, max } from "drizzle-orm";
import {
	participantOpeningTable,
	participantPromptTable,
	participantTable,
} from "../../database/schema";
import { InvalidConversationCommandError } from "../errors";
import {
	type ConversationDatabase,
	requireParticipantDefinition,
} from "../internal";
import type { ParticipantDefinition } from "../types";

export interface AddParticipantInput {
	conversationId: number;
	definition: ParticipantDefinition;
	sourceCharacterId?: number | undefined;
}

// Appends a new Participant to the stable Cast tail with a complete local
// Definition. Either an ad-hoc Definition or the already-resolved fork of a
// Character (with immutable provenance). Appending never writes history and
// never reassigns Control; later Cast changes never insert messages.
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

	// Append at the stable Cast tail. Only active Participants contribute to
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
}