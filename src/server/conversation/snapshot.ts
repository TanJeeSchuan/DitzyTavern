import { and, asc, eq, inArray, isNull } from "drizzle-orm";
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
// Derives per-Participant removal eligibility and impact. Seated
// Participants are protected (a Control seat must change first). For every
// unseated Participant the deletion mode states whether removal would
// hard-delete or tombstone, and the affected-generation count states how
// many Messages currently able to generate a new sibling Variant would lose
// that ability. Messages are the only retained references, so the same
// messages array drives both the reference check and the impact count.
const deriveRemovalEligibility = (
	cast: readonly Omit<CastParticipantSnapshot, "duplicateLabel" | "removal">[],
	messages: readonly ConversationMessageSnapshot[],
	control: {
		humanParticipantId: number | null;
		modelParticipantId: number | null;
	},
): Map<number, ParticipantRemovalEligibility> => {
	const byParticipant = new Map<number, ParticipantRemovalEligibility>();
	for (const participant of cast) {
		const seated =
			participant.id === control.humanParticipantId ||
			participant.id === control.modelParticipantId;
		if (seated) {
			byParticipant.set(participant.id, {
				eligible: false,
				reason: "control-assigned",
				deletionMode: null,
				affectedGenerationCount: 0,
			});
			continue;
		}

		let referenced = false;
		let affectedGenerationCount = 0;
		for (const message of messages) {
			const context = message.historicalContext;
			const referencesContext =
				context !== null &&
				(context.humanParticipantId === participant.id ||
					context.modelParticipantId === participant.id);
			const referencesAuthor =
				message.author?.participantId === participant.id;
			if (referencesContext || referencesAuthor) referenced = true;
			if (referencesContext && message.swipe.eligible) {
				affectedGenerationCount += 1;
			}
		}

		byParticipant.set(participant.id, {
			eligible: true,
			reason: null,
			deletionMode: referenced ? "tombstone" : "hard-delete",
			affectedGenerationCount,
		});
	}
	return byParticipant;
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

	// Active Cast members only. Tombstoned Participants keep a minimal base
	// row solely to satisfy structural Message references; they are never
	// part of the Cast and carry no position.
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
		.where(
			and(
				eq(participantTable.chat_id, conversationId),
				isNull(participantTable.deleted_at),
			),
		)
		.orderBy(asc(participantTable.position))
		.all();
	const castIds = castRows.map((participant) => participant.id);
	const castIdsSet = new Set(castIds);

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
						// Derived historical display state: the captured name keeps
						// displaying with a no-longer-in-Cast marker after removal.
						inCast:
							message.author_participant_id !== null &&
							castIdsSet.has(message.author_participant_id),
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

	// Removal eligibility follows Messages: the deletion mode and
	// affected-generation count derive from the same references the command
	// enforces, so clients never reconstruct the rule.
	const removalByParticipant = deriveRemovalEligibility(cast, messages, control);

	return {
		id: conversation.id,
		name: conversation.name,
		revision: conversation.revision,
		cast: cast.map((participant) => ({
			...participant,
			duplicateLabel: labelsById.get(participant.id) ?? participant.name,
			removal: removalByParticipant.get(participant.id) ?? {
				eligible: true,
				reason: null,
				deletionMode: "hard-delete",
				affectedGenerationCount: 0,
			},
		})),
		control,
		controlValidity,
		playable,
		capabilities: deriveCapabilities(playable),
		messages,
		data,
	};
}
