import { requirePortraitImage } from "../../image";
import { eq } from "drizzle-orm";
import {
	participantOpeningTable,
	participantPromptTable,
	participantTable,
	toPortraitColumns,
	toPromptChannelRow,
} from "../../database/schema";
import {
	type ConversationDatabase,
	requireParticipant,
	requireParticipantName,
	requireParticipantOpenings,
} from "../internal";
import type { Portrait } from "../../../shared/contract/image";
import type { PromptChannels } from "../../../shared/contract/prompt-schema";

export interface EditParticipantNameInput {
	conversationId: number;
	participantId: number;
	name: string;
}

export interface ReplaceParticipantPromptInput {
	conversationId: number;
	participantId: number;
	prompt: PromptChannels;
}

export interface ReplaceParticipantOpeningsInput {
	conversationId: number;
	participantId: number;
	openings: string[];
}

// ==[HUMAN APPROVED]== Separate semantic Apply actions for Participant Definition editing. Each
// touches only the Participant's own local records: the source Character is
// never modified, and existing Messages keep their captured Author Stamps
// and historical Control context untouched.
export function renameParticipant(
	db: ConversationDatabase,
	input: EditParticipantNameInput,
) {
	const name = requireParticipantName(input.name);
	const participant = requireParticipant(
		db,
		input.conversationId,
		input.participantId,
	);
	db.update(participantTable)
		.set({ name })
		.where(eq(participantTable.id, participant.id))
		.run();
}

export function replaceParticipantPrompt(
	db: ConversationDatabase,
	input: ReplaceParticipantPromptInput,
) {
	requireParticipant(db, input.conversationId, input.participantId);
	const promptRow = toPromptChannelRow(input.prompt);
	db.insert(participantPromptTable)
		.values({
			participant_id: input.participantId,
			...promptRow,
		})
		.onConflictDoUpdate({
			target: participantPromptTable.participant_id,
			set: promptRow,
		})
		.run();

}

export function replaceParticipantOpenings(
	db: ConversationDatabase,
	input: ReplaceParticipantOpeningsInput,
) {
	const openings = requireParticipantOpenings(input.openings);
	requireParticipant(db, input.conversationId, input.participantId);
	db.delete(participantOpeningTable)
		.where(eq(participantOpeningTable.participant_id, input.participantId))
		.run();
	if (openings.length > 0) {
		db.insert(participantOpeningTable)
			.values(
				openings.map((content, index) => ({
					participant_id: input.participantId,
					position: index + 1,
					content,
				})),
			)
			.run();
	}

}

export function updateParticipantDefinition(db: ConversationDatabase, input: {
	conversationId: number;
	participantId: number;
	definition: { name: string; prompt: PromptChannels; openings: string[]; portrait?: Portrait | undefined };
}) {
	const name = requireParticipantName(input.definition.name);
	const openings = requireParticipantOpenings(input.definition.openings);
	const participant = requireParticipant(db, input.conversationId, input.participantId);
	db.update(participantTable).set({ name }).where(eq(participantTable.id, participant.id)).run();
	requirePortraitImage(db, input.definition.portrait);
	const promptRow = { ...toPromptChannelRow(input.definition.prompt), ...toPortraitColumns(input.definition.portrait) };
	db.insert(participantPromptTable).values({ participant_id: participant.id, ...promptRow })
		.onConflictDoUpdate({ target: participantPromptTable.participant_id, set: promptRow }).run();

	db.delete(participantOpeningTable).where(eq(participantOpeningTable.participant_id, participant.id)).run();
	if (openings.length > 0) db.insert(participantOpeningTable).values(openings.map((content, index) => ({ participant_id: participant.id, position: index + 1, content }))).run();
}
