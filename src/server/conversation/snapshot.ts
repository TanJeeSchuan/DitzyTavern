import type { Database } from "bun:sqlite";
import { and, asc, count, eq, inArray, or } from "drizzle-orm";
import { duplicateLabel } from "../../shared/cast";
import {
	activeGenerationTable,
	conversationTable,
	messageTable,
	participantOpeningTable,
} from "../database/schema";
import {
	connectConversationDatabase,
	findConversation,
	groupRowsByNumber,
	readActiveCast,
	readControlAssignment,
	type ConversationDatabase,
} from "./internal";
import type {
	CapabilityAvailability,
	CastParticipantSnapshot,
	ConversationCapabilities,
	ConversationControlSnapshot,
	ConversationControlValidity,
	ConversationSummary,
	ControlValidityReason,
	HistoricalControlSnapshot,
	MessageSwipeEligibility,
	ParticipantRemovalEligibility,
} from "./types";

// @approved
//  Play-gated capabilities share one derived reason: without two distinct
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

// @approved
//  Control validity is the single derived playability rule: both seats set,
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

// @approved
//  Derives per-Message targeted Swipe eligibility. The eligibility rule is
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
const deriveParticipantRemovalFromDatabase = (
	db: ConversationDatabase,
	conversationId: number,
	participantId: number,
	castIds: readonly number[],
	playable: boolean,
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

	const referenced =
		db
			.select({ id: messageTable.id })
			.from(messageTable)
			.where(
				and(
					eq(messageTable.conversation_id, conversationId),
					or(
						eq(messageTable.author_participant_id, participantId),
						eq(messageTable.context_human_participant_id, participantId),
						eq(messageTable.context_model_participant_id, participantId),
					),
				),
			)
			.limit(1)
			.get() !== undefined;

	const affectedGenerationCount =
		!playable || castIds.length === 0
			? 0
			: db
					.select({ value: count(messageTable.id) })
					.from(messageTable)
					.where(
						and(
							eq(messageTable.conversation_id, conversationId),
							or(
								eq(messageTable.context_human_participant_id, participantId),
								eq(messageTable.context_model_participant_id, participantId),
							),
							inArray(messageTable.context_human_participant_id, castIds),
							inArray(messageTable.context_model_participant_id, castIds),
						),
					)
					.get()?.value ?? 0;

	return {
		eligible: true,
		reason: null,
		deletionMode: referenced ? "tombstone" : "hard-delete",
		affectedGenerationCount,
	};
};

// @approved
//  Cheap existence probe for callers that only need to know whether the
// Conversation row is present.
export function conversationExists(
	database: Database,
	conversationId: number,
): boolean {
	return findConversation(
		connectConversationDatabase(database),
		conversationId,
	) !== undefined;
}

// @approved
//  Narrow revision read for server-owned preview sends. The
// preview capture already owns the exact Prompt Plan, so refreshing the
// acceptance guard must not materialize the complete Conversation snapshot.
export function readConversationRevision(
	database: Database,
	conversationId: number,
): number | undefined {
	return findConversation(
		connectConversationDatabase(database),
		conversationId,
	)?.revision;
}

export function readConversationSummary(
	database: Database,
	conversationId: number,
): ConversationSummary | undefined {
	return readConversationSummaryFromConnection(
		connectConversationDatabase(database),
		conversationId,
	);
}

export function readConversationSummaryFromConnection(
	db: ConversationDatabase,
	conversationId: number,
): ConversationSummary | undefined {
	const conversation = db
		.select()
		.from(conversationTable)
		.where(eq(conversationTable.id, conversationId))
		.get();
	if (conversation === undefined) return undefined;

	// @approved
	//  Active Cast members only. Tombstoned Participants keep a minimal base
	// row solely to satisfy structural Message references; they are never
	// part of the Cast and carry no position.
	const castRows = readActiveCast(db, conversationId);
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

	const openingsByParticipant = groupRowsByNumber(
		openingRows,
		(opening) => opening.participant_id,
		(opening) => opening.content,
	);

	// @approved
	//  Intermediate Cast shape lacks the derived per-Participant fields; they
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
			portrait: participant.portrait,
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

	// @approved
	//  Duplicate display labels derive from Cast order: the first Participant
	// sharing a name keeps the plain label, later ones receive ordinals.
	const nameOccurrences = new Map<string, number>();
	const labelsById = new Map<number, string>();
	for (const participant of cast) {
		const occurrence = (nameOccurrences.get(participant.name) ?? 0) + 1;
		nameOccurrences.set(participant.name, occurrence);
		labelsById.set(participant.id, duplicateLabel(participant.name, occurrence));
	}

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

	// @approved
	//  Removal eligibility follows Messages: the deletion mode and
	// affected-generation count derive from the same references the command
	// enforces, so clients never reconstruct the rule.
	return {
		id: conversation.id,
		authorNote: conversation.author_note,
		name: conversation.name,
		revision: conversation.revision,
		cast: cast.map((participant) => ({
			...participant,
			duplicateLabel: labelsById.get(participant.id) ?? participant.name,
			removal: deriveParticipantRemovalFromDatabase(
				db,
				conversationId,
				participant.id,
				castIds,
				playable,
				control,
			),
		})),
		control,
		controlValidity,
		playable,
		capabilities: deriveCapabilities(playable),
		activeGenerations: activeGenerationRows,
	};
}
