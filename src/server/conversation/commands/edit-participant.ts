import { eq } from "drizzle-orm";
import {
	participantOpeningTable,
	participantPromptTable,
	participantTable,
	toPortraitColumns,
	toPromptChannelRow,
} from "../../database/schema";
import { syncDefinitionReferences, type ImagePool } from "../../image";
import { InvalidConversationCommandError } from "../errors";
import {
	type ConversationDatabase,
	requireParticipant,
	requireParticipantName,
	requireParticipantOpenings,
	syncParticipantOpeningReferences,
	syncParticipantPromptReferences,
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
	images?: ImagePool | undefined;
}

export interface ReplaceParticipantOpeningsInput {
	conversationId: number;
	participantId: number;
	openings: string[];
	images?: ImagePool | undefined;
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
	syncParticipantPromptReferences(db, input.participantId, input.prompt, input.images);
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
	syncParticipantOpeningReferences(db, input.participantId, openings, input.images);
}

export function updateParticipantDefinition(db: ConversationDatabase, input: {
	conversationId: number;
	participantId: number;
	definition: { name: string; prompt: PromptChannels; openings: string[]; portrait?: Portrait | undefined };
	images?: ImagePool | undefined;
}) {
	const name = requireParticipantName(input.definition.name);
	const openings = requireParticipantOpenings(input.definition.openings);
	const participant = requireParticipant(db, input.conversationId, input.participantId);
	db.update(participantTable).set({ name }).where(eq(participantTable.id, participant.id)).run();
	const promptRow = { ...toPromptChannelRow(input.definition.prompt), ...toPortraitColumns(input.definition.portrait) };
	db.insert(participantPromptTable).values({ participant_id: participant.id, ...promptRow })
		.onConflictDoUpdate({ target: participantPromptTable.participant_id, set: promptRow }).run();
	if (!syncDefinitionReferences(db, "participant_id", participant.id, input.definition, input.images)) {
		throw new InvalidConversationCommandError("The Portrait image was not provided.");
	}
	db.delete(participantOpeningTable).where(eq(participantOpeningTable.participant_id, participant.id)).run();
	if (openings.length > 0) db.insert(participantOpeningTable).values(openings.map((content, index) => ({ participant_id: participant.id, position: index + 1, content }))).run();
}
