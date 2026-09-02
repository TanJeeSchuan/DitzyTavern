import type { Database } from "bun:sqlite";
import { asc, eq, inArray } from "drizzle-orm";
import { duplicateLabel } from "../../shared/cast";
import {
	activeGenerationTable,
	conversationDataTable,
	conversationTable,
	messageDataTable,
	messageTable,
	messageVariantDataTable,
	messageVariantTable,
	participantOpeningTable,
} from "../database/schema";
import {
	connectConversationDatabase,
	groupRowsByNumber,
	groupVariantsByMessage,
	messageReferencesParticipant,
	readActiveCast,
	readControlAssignment,
	type ConversationDatabase,
} from "./internal";
import type {
	AuthorStampSnapshot,
	CapabilityAvailability,
	CastParticipantSnapshot,
	ConversationCapabilities,
	ConversationControlSnapshot,
	ConversationControlValidity,
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

// ==[HUMAN APPROVED]== Play-gated capabilities share one derived reason: without two distinct
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

// ==[HUMAN APPROVED]== Control validity is the single derived playability rule: both seats set,
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

// ==[HUMAN APPROVED]== Derives per-Message targeted Swipe eligibility. The eligibility rule is
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
// ==[HUMAN APPROVED]== The Author Stamp and captured historical Control pair mappers shared
// by the snapshot and the paginated history read: one derivation per row
// shape, so the two read models can never disagree about Message identity.
export const toAuthorStamp = (
	row: { author_participant_id: number | null; author_name: string | null },
	castIds: ReadonlySet<number>,
): AuthorStampSnapshot | null =>
	row.author_participant_id !== null || row.author_name !== null
		? {
				participantId: row.author_participant_id,
				capturedName: row.author_name,
				// ==[HUMAN APPROVED]== Derived historical display state: the captured name keeps
				// displaying with a no-longer-in-Cast marker after removal.
				inCast:
					row.author_participant_id !== null &&
					castIds.has(row.author_participant_id),
			}
		: null;

export const toHistoricalContext = (
	row: {
		context_human_participant_id: number | null;
		context_model_participant_id: number | null;
	},
): HistoricalControlSnapshot | null =>
	row.context_human_participant_id !== null &&
	row.context_model_participant_id !== null
		? {
				humanParticipantId: row.context_human_participant_id,
				modelParticipantId: row.context_model_participant_id,
			}
		: null;

// ==[HUMAN APPROVED]== Derives one Participant's removal eligibility and impact. Seated
// Participants are protected (a Control seat must change first); every other
// Cast member is eligible, and the deletion mode states whether removal
// would hard-delete or tombstone. The affected-generation count states how
// many Messages currently able to generate a new sibling Variant would lose
// that ability. Messages are the only retained references, so the same
// messages array drives both the reference check and the impact count. The
// derivation covers exactly the Cast it is called with, so no caller ever
// needs a fallback for a missing result.
const deriveParticipantRemoval = (
	participantId: number,
	messages: readonly ConversationMessageSnapshot[],
	control: {
		humanParticipantId: number | null;
		modelParticipantId: number | null;
	},
): ParticipantRemovalEligibility => {
	const seated =
		participantId === control.humanParticipantId ||
		participantId === control.modelParticipantId;
	if (seated) {
		return {
			eligible: false,
			reason: "control-assigned",
			deletionMode: null,
			affectedGenerationCount: 0,
		};
	}

	let referenced = false;
	let affectedGenerationCount = 0;
	for (const message of messages) {
		const row = {
			authorParticipantId: message.author?.participantId ?? null,
			contextHumanParticipantId:
				message.historicalContext?.humanParticipantId ?? null,
			contextModelParticipantId:
				message.historicalContext?.modelParticipantId ?? null,
		};
		// ==[HUMAN APPROVED]== Same retained-reference rule the command enforces, so the derived
		// impact can never drift from the persisted behavior.
		if (messageReferencesParticipant(row, participantId)) {
			referenced = true;
		}
		// ==[HUMAN APPROVED]== Author-only references are retained (tombstone required) but never
		// count as regeneration loss: only Messages whose captured historical
		// pair includes this Participant and that currently could generate a
		// new sibling Variant lose that ability when it is removed.
		const referencesContext =
			row.contextHumanParticipantId === participantId ||
			row.contextModelParticipantId === participantId;
		if (referencesContext && message.swipe.eligible) {
			affectedGenerationCount += 1;
		}
	}

	return {
		eligible: true,
		reason: null,
		deletionMode: referenced ? "tombstone" : "hard-delete",
		affectedGenerationCount,
	};
};

// ==[HUMAN APPROVED]== Cheap existence probe for callers that only need to know whether the
// Conversation row is present. readConversationSnapshot runs many queries
// to assemble the full snapshot (cast, messages, variants, data, active
// generations), which is too costly to use as an existence check.
export function conversationExists(
	database: Database,
	conversationId: number,
): boolean {
	const db = connectConversationDatabase(database);
	return (
		db
			.select({ id: conversationTable.id })
			.from(conversationTable)
			.where(eq(conversationTable.id, conversationId))
			.get() !== undefined
	);
}

export function readConversationSnapshot(
	database: Database,
	conversationId: number,
): ConversationSnapshot | undefined {
	return readConversationSnapshotFromConnection(
		connectConversationDatabase(database),
		conversationId,
	);
}

export function readConversationSnapshotFromConnection(
	db: ConversationDatabase,
	conversationId: number,
): ConversationSnapshot | undefined {
	const conversation = db
		.select()
		.from(conversationTable)
		.where(eq(conversationTable.id, conversationId))
		.get();
	if (conversation === undefined) return undefined;

	// ==[HUMAN APPROVED]== Active Cast members only. Tombstoned Participants keep a minimal base
	// row solely to satisfy structural Message references; they are never
	// part of the Cast and carry no position.
	const castRows = readActiveCast(db, conversationId);
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

	const openingsByParticipant = groupRowsByNumber(
		openingRows,
		(opening) => opening.participant_id,
		(opening) => opening.content,
	);

	// ==[HUMAN APPROVED]== Intermediate Cast shape lacks the derived per-Participant fields; they
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

	// ==[HUMAN APPROVED]== Duplicate display labels derive from Cast order: the first Participant
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
		.where(eq(messageTable.conversation_id, conversationId))
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

	const variantDataByVariant = groupRowsByNumber(
		variantDataRows,
		(row) => row.message_variant_id,
		toDataEntry,
	);

	const variantsByMessage = groupVariantsByMessage(
		variantRows,
		(variant): ConversationVariantSnapshot => ({
			id: variant.id,
			position: variant.position,
			content: variant.content,
			timestamp: variant.timestamp,
			selected: variant.selected,
			data: variantDataByVariant.get(variant.id) ?? [],
		}),
	);

	const messageDataByMessage = groupRowsByNumber(
		messageDataRows,
		(row) => row.message_id,
		toDataEntry,
	);

	const messages: ConversationMessageSnapshot[] = messageRows.map((message) => {
		const author = toAuthorStamp(message, castIdsSet);
		const historicalContext = toHistoricalContext(message);
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
		.from(conversationDataTable)
		.where(eq(conversationDataTable.conversation_id, conversationId))
		.orderBy(asc(conversationDataTable.namespace), asc(conversationDataTable.key))
		.all()
		.map(toDataEntry);

	const activeGenerationRows = db
		.select({
			generationId: activeGenerationTable.id,
			messageId: activeGenerationTable.message_id,
			variantId: activeGenerationTable.variant_id,
			startedAt: activeGenerationTable.started_at,
		})
		.from(activeGenerationTable)
		.where(eq(activeGenerationTable.conversation_id, conversationId))
		.orderBy(asc(activeGenerationTable.id))
		.all();

	// ==[HUMAN APPROVED]== Removal eligibility follows Messages: the deletion mode and
	// affected-generation count derive from the same references the command
	// enforces, so clients never reconstruct the rule.
	return {
		id: conversation.id,
		name: conversation.name,
		revision: conversation.revision,
		cast: cast.map((participant) => ({
			...participant,
			duplicateLabel: labelsById.get(participant.id) ?? participant.name,
			removal: deriveParticipantRemoval(
				participant.id,
				messages,
				control,
			),
		})),
		control,
		controlValidity,
		playable,
		capabilities: deriveCapabilities(playable),
		activeGenerations: activeGenerationRows,
		messages,
		data,
	};
}
