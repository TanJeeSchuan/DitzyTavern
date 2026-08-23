import { asc, eq, inArray } from "drizzle-orm";
import {
	chatDataTable,
	chatTable,
	messageDataTable,
	messageTable,
	messageVariantDataTable,
	messageVariantTable,
	participantOpeningTable,
	participantPromptTable,
	participantTable,
} from "../database/schema";
import { type ConversationDatabase, readControlAssignment } from "./internal";
import type {
	AuthorStampSnapshot,
	CapabilityAvailability,
	CastParticipantSnapshot,
	ConversationCapabilities,
	ConversationControlSnapshot,
	ConversationDataEntry,
	ConversationMessageSnapshot,
	ConversationSnapshot,
	ConversationVariantSnapshot,
	HistoricalControlSnapshot,
} from "./types";

const toDataEntry = (row: { namespace: string; key: string; value: string }) => ({
	namespace: row.namespace,
	key: row.key,
	value: row.value,
});

// Play-gated capabilities share one derived reason: without two distinct
// seated Participants none of Compose, Generate, or Swipe may run. The
// literal is checked against the capability contract by deriveCapabilities.
const playCapability = (playable: boolean): CapabilityAvailability => ({
	available: playable,
	reason: playable ? null : "conversation-not-playable",
});

export function deriveCapabilities(playable: boolean): ConversationCapabilities {
	return {
		compose: playCapability(playable),
		generate: playCapability(playable),
		swipe: playCapability(playable),
	};
}

export function readConversationSnapshot(
	db: ConversationDatabase,
	conversationId: number,
): ConversationSnapshot | undefined {
	const conversation = db
		.select()
		.from(chatTable)
		.where(eq(chatTable.id, conversationId))
		.get();
	if (conversation === undefined) return undefined;

	const castRows = db
		.select({
			id: participantTable.id,
			position: participantTable.position,
			name: participantTable.name,
			sourceCharacterId: participantTable.source_character_id,
			systemInstruction: participantPromptTable.system_instruction,
			identity: participantPromptTable.identity,
			scenario: participantPromptTable.scenario,
			exampleDialogue: participantPromptTable.example_dialogue,
			postHistoryInstruction: participantPromptTable.post_history_instruction,
		})
		.from(participantTable)
		.innerJoin(participantPromptTable, eq(participantPromptTable.participant_id, participantTable.id))
		.where(eq(participantTable.chat_id, conversationId))
		.orderBy(asc(participantTable.position))
		.all();
	const castIds = castRows.map((participant) => participant.id);

	const openingRows =
		castIds.length === 0
			? []
			: db
					.select()
					.from(participantOpeningTable)
					.where(inArray(participantOpeningTable.participant_id, castIds))
					.orderBy(
						asc(participantOpeningTable.participant_id),
						asc(participantOpeningTable.position),
					)
					.all();

	const openingsByParticipant = new Map<number, string[]>();
	for (const opening of openingRows) {
		const openings = openingsByParticipant.get(opening.participant_id) ?? [];
		openings.push(opening.content);
		openingsByParticipant.set(opening.participant_id, openings);
	}

	const cast: CastParticipantSnapshot[] = castRows.map((participant) => ({
		id: participant.id,
		position: participant.position,
		name: participant.name,
		prompt: {
			systemInstruction: participant.systemInstruction,
			identity: participant.identity,
			scenario: participant.scenario,
			exampleDialogue: participant.exampleDialogue,
			postHistoryInstruction: participant.postHistoryInstruction,
		},
		openings: openingsByParticipant.get(participant.id) ?? [],
		sourceCharacterId: participant.sourceCharacterId ?? null,
	}));

	const controlState = readControlAssignment(db, conversationId);
	const control: ConversationControlSnapshot = {
		humanParticipantId: controlState.humanParticipantId,
		modelParticipantId: controlState.modelParticipantId,
	};

	const playable =
		control.humanParticipantId !== null && control.modelParticipantId !== null;

	const messageRows = db
		.select()
		.from(messageTable)
		.where(eq(messageTable.chat_id, conversationId))
		.orderBy(asc(messageTable.position))
		.all();
	const messageIds = messageRows.map((message) => message.id);
	const variantRows =
		messageIds.length === 0
			? []
			: db
					.select()
					.from(messageVariantTable)
					.where(inArray(messageVariantTable.message_id, messageIds))
					.orderBy(
						asc(messageVariantTable.message_id),
						asc(messageVariantTable.position),
					)
					.all();
	const variantIds = variantRows.map((variant) => variant.id);
	const messageDataRows =
		messageIds.length === 0
			? []
			: db
					.select()
					.from(messageDataTable)
					.where(inArray(messageDataTable.message_id, messageIds))
					.orderBy(
						asc(messageDataTable.message_id),
						asc(messageDataTable.namespace),
						asc(messageDataTable.key),
					)
					.all();
	const variantDataRows =
		variantIds.length === 0
			? []
			: db
					.select()
					.from(messageVariantDataTable)
					.where(inArray(messageVariantDataTable.message_variant_id, variantIds))
					.orderBy(
						asc(messageVariantDataTable.message_variant_id),
						asc(messageVariantDataTable.namespace),
						asc(messageVariantDataTable.key),
					)
					.all();

	const variantDataByVariant = new Map<number, ConversationDataEntry[]>();
	for (const row of variantDataRows) {
		const entries = variantDataByVariant.get(row.message_variant_id) ?? [];
		entries.push(toDataEntry(row));
		variantDataByVariant.set(row.message_variant_id, entries);
	}

	const variantsByMessage = new Map<number, ConversationVariantSnapshot[]>();
	for (const variant of variantRows) {
		const variants = variantsByMessage.get(variant.message_id) ?? [];
		variants.push({
			id: variant.id,
			position: variant.position,
			content: variant.content,
			timestamp: variant.timestamp,
			selected: variant.selected,
			data: variantDataByVariant.get(variant.id) ?? [],
		});
		variantsByMessage.set(variant.message_id, variants);
	}

	const messageDataByMessage = new Map<number, ConversationDataEntry[]>();
	for (const row of messageDataRows) {
		const entries = messageDataByMessage.get(row.message_id) ?? [];
		entries.push(toDataEntry(row));
		messageDataByMessage.set(row.message_id, entries);
	}

	const messages: ConversationMessageSnapshot[] = messageRows.map((message) => {
		const author: AuthorStampSnapshot | null =
			message.author_participant_id !== null || message.author_name !== null
				? {
						participantId: message.author_participant_id,
						capturedName: message.author_name,
					}
				: null;
		const historicalContext: HistoricalControlSnapshot | null =
			message.context_human_participant_id !== null &&
			message.context_model_participant_id !== null
				? {
						humanParticipantId: message.context_human_participant_id,
						modelParticipantId: message.context_model_participant_id,
					}
				: null;
		return {
			id: message.id,
			position: message.position,
			timestamp: message.timestamp,
			author,
			historicalContext,
			variants: variantsByMessage.get(message.id) ?? [],
			data: messageDataByMessage.get(message.id) ?? [],
		};
	});

	const data = db
		.select()
		.from(chatDataTable)
		.where(eq(chatDataTable.chat_id, conversationId))
		.orderBy(asc(chatDataTable.namespace), asc(chatDataTable.key))
		.all()
		.map(toDataEntry);

	return {
		id: conversation.id,
		name: conversation.name,
		revision: conversation.revision,
		cast,
		control,
		playable,
		capabilities: deriveCapabilities(playable),
		messages,
		data,
	};
}
