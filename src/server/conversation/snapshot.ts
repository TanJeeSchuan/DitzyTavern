import { asc, eq, inArray } from "drizzle-orm";
import { duplicateLabel } from "../../shared/cast";
import {
	characterTable,
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
	ConversationControlValidity,
	ConversationDataEntry,
	ConversationMessageSnapshot,
	ConversationSnapshot,
	ConversationVariantSnapshot,
	ControlValidityReason,
	HistoricalControlSnapshot,
	MessageSwipeEligibility,
	ParticipantRemovalEligibility,
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

// Control validity is the single derived playability rule: both seats set,
// distinct, and referencing active Cast Participants. Playable and the
// capability gate both follow from it, so clients never reproduce the rule.
export function deriveControlValidity(
	control: { humanParticipantId: number | null; modelParticipantId: number | null },
	castIds: readonly number[],
): ConversationControlValidity {
	let reason: ControlValidityReason | null = null;
	if (control.humanParticipantId === null || control.modelParticipantId === null) {
		reason = "missing-seat";
	} else if (control.humanParticipantId === control.modelParticipantId) {
		reason = "seats-not-distinct";
	} else if (
		!castIds.includes(control.humanParticipantId) ||
		!castIds.includes(control.modelParticipantId)
	) {
		reason = "seat-not-in-cast";
	}
	return { valid: reason === null, reason };
}

// Derives per-Message targeted Swipe eligibility. The eligibility rule is
// the single derived answer for "can this Message generate a new sibling
// Variant": the Conversation must be playable, the Message must carry a
// captured historical Control pair, and both historical Participants must
// still be active Cast members with usable Definitions. Clients never
// reproduce the rule per Message.
export function deriveMessageSwipeEligibility(
	playable: boolean,
	historicalContext: HistoricalControlSnapshot | null,
	castIds: readonly number[],
): MessageSwipeEligibility {
	if (!playable) {
		return { eligible: false, reason: "conversation-not-playable" };
	}
	if (historicalContext === null) {
		return { eligible: false, reason: "missing-historical-context" };
	}
	if (
		!castIds.includes(historicalContext.humanParticipantId) ||
		!castIds.includes(historicalContext.modelParticipantId)
	) {
		return { eligible: false, reason: "historical-participant-unavailable" };
	}
	return { eligible: true, reason: null };
}

// Derives removal eligibility per Participant: seated Participants are
// protected, so only unseated Participants may be removed.
const deriveRemovalEligibility = (
	participantId: number,
	control: { humanParticipantId: number | null; modelParticipantId: number | null },
): ParticipantRemovalEligibility => {
	const seated =
		participantId === control.humanParticipantId ||
		participantId === control.modelParticipantId;
	return {
		eligible: !seated,
		reason: seated ? "control-assigned" : null,
	};
};

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
			sourceCharacterName: characterTable.name,
			systemInstruction: participantPromptTable.system_instruction,
			identity: participantPromptTable.identity,
			scenario: participantPromptTable.scenario,
			exampleDialogue: participantPromptTable.example_dialogue,
			postHistoryInstruction: participantPromptTable.post_history_instruction,
		})
		.from(participantTable)
		.innerJoin(participantPromptTable, eq(participantPromptTable.participant_id, participantTable.id))
		.leftJoin(characterTable, eq(characterTable.id, participantTable.source_character_id))
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

	// Intermediate Cast shape lacks the derived per-Participant fields; they
	// are attached after Control is read so labels and removal eligibility
	// derive from the final ordered roster.
	const cast: Omit<CastParticipantSnapshot, "duplicateLabel" | "removal">[] =
		castRows.map((participant) => ({
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
			sourceCharacterName: participant.sourceCharacterName ?? null,
		}));

	const controlState = readControlAssignment(db, conversationId);
	const control: ConversationControlSnapshot = {
		humanParticipantId: controlState.humanParticipantId,
		modelParticipantId: controlState.modelParticipantId,
	};

	const controlValidity = deriveControlValidity(control, cast.map((p) => p.id));
	const playable = controlValidity.valid;

	// Duplicate display labels derive from Cast order: the first Participant
	// sharing a name keeps the plain label, later ones receive ordinals.
	const nameOccurrences = new Map<string, number>();
	const labelsById = new Map<number, string>();
	for (const participant of cast) {
		const occurrence = (nameOccurrences.get(participant.name) ?? 0) + 1;
		nameOccurrences.set(participant.name, occurrence);
		labelsById.set(participant.id, duplicateLabel(participant.name, occurrence));
	}

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
			swipe: deriveMessageSwipeEligibility(
				playable,
				historicalContext,
				castIds,
			),
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
		cast: cast.map((participant) => ({
			...participant,
			duplicateLabel: labelsById.get(participant.id) ?? participant.name,
			removal: deriveRemovalEligibility(participant.id, control),
		})),
		control,
		controlValidity,
		playable,
		capabilities: deriveCapabilities(playable),
		messages,
		data,
	};
}
