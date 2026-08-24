import type { Database } from "bun:sqlite";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	conversationControlTable,
	messageTable,
	messageVariantTable,
	participantTable,
} from "../database/schema";
import type { ParticipantDefinition } from "./types";
import {
	InvalidConversationCommandError,
} from "./errors";

export const connectConversationDatabase = (database: Database) => drizzle(database);
export type ConversationDatabase = ReturnType<typeof connectConversationDatabase>;

export interface ControlAssignmentState {
	humanParticipantId: number | null;
	modelParticipantId: number | null;
}

// Reads the current Control assignment. A Conversation is playable only when
// both distinct seats are occupied; this derived state is never stored.
export const readControlAssignment = (
	db: ConversationDatabase,
	conversationId: number,
): ControlAssignmentState => {
	const rows = db
		.select({
			seat: conversationControlTable.seat,
			participantId: conversationControlTable.participant_id,
		})
		.from(conversationControlTable)
		.where(eq(conversationControlTable.chat_id, conversationId))
		.all();

	const state: ControlAssignmentState = {
		humanParticipantId: null,
		modelParticipantId: null,
	};
	for (const row of rows) {
		if (row.seat === "human") state.humanParticipantId = row.participantId;
		if (row.seat === "model") state.modelParticipantId = row.participantId;
	}
	return state;
};

export const isPlayable = (control: ControlAssignmentState): boolean =>
	control.humanParticipantId !== null &&
	control.modelParticipantId !== null;

// Writes a complete Control assignment by deleting the Conversation's rows
// and reinserting the occupied seats. Replace-all avoids a temporary unique
// violation on the per-Participant Control index during an atomic swap or an
// incomplete-import completion fill. Shared by assign-control and by the
// add-participant completion path so seat writes never diverge.
export const writeControlAssignment = (
	db: ConversationDatabase,
	conversationId: number,
	assignment: {
		humanParticipantId: number | null;
		modelParticipantId: number | null;
	},
) => {
	db.delete(conversationControlTable)
		.where(eq(conversationControlTable.chat_id, conversationId))
		.run();
	const rows = [];
	if (assignment.humanParticipantId !== null) {
		rows.push({
			chat_id: conversationId,
			seat: "human" as const,
			participant_id: assignment.humanParticipantId,
		});
	}
	if (assignment.modelParticipantId !== null) {
		rows.push({
			chat_id: conversationId,
			seat: "model" as const,
			participant_id: assignment.modelParticipantId,
		});
	}
	if (rows.length > 0) {
		db.insert(conversationControlTable).values(rows).run();
	}
};

// Names follow the shared Definition rules: surrounding whitespace is
// removed while case and Unicode are preserved; a nonblank result is
// required for every Participant.
export const normalizeParticipantName = (name: string) => name.trim();

export const requireParticipantName = (name: string): string => {
	const normalized = normalizeParticipantName(name);
	if (normalized === "") {
		throw new InvalidConversationCommandError(
			"A Participant name is required.",
		);
	}
	return normalized;
};

// Openings are stored exactly as authored; only fully blank entries are
// rejected, matching Character Library rules.
export const requireParticipantOpenings = (
	openings: readonly string[],
): readonly string[] => {
	openings.forEach((opening, index) => {
		if (opening.trim() === "") {
			throw new InvalidConversationCommandError(
				`Opening at position ${index + 1} is blank; openings must contain text.`,
			);
		}
	});
	return openings;
};

// Validates a complete Participant Definition for Cast management
// commands, mirroring creation-time rules.
export const requireParticipantDefinition = (
	definition: ParticipantDefinition,
): ParticipantDefinition => ({
	name: requireParticipantName(definition.name),
	prompt: definition.prompt,
	openings: requireParticipantOpenings(definition.openings),
});

export const requireParticipant = (
	db: ConversationDatabase,
	conversationId: number,
	participantId: number,
) => {
	const participant = db
		.select()
		.from(participantTable)
		.where(
			and(
				eq(participantTable.id, participantId),
				eq(participantTable.chat_id, conversationId),
				isNull(participantTable.deleted_at),
			),
		)
		.get();

	if (participant === undefined) {
		throw new InvalidConversationCommandError(
			`Participant ${participantId} does not belong to Conversation ${conversationId}.`,
		);
	}

	return participant;
};

// The reference columns a Message uses to refer to a Participant: its
// immutable Author Stamp or either side of its captured historical Control
// pair. The neutral shape lets the DB commands and the snapshot derivation
// share one predicate.
export interface ParticipantReferenceRow {
	authorParticipantId: number | null;
	contextHumanParticipantId: number | null;
	contextModelParticipantId: number | null;
}

// The single retained-reference rule shared by the snapshot derivation and
// the removal and tombstone-collection commands: a Message refers to a
// Participant through its Author Stamp or its historical Control pair.
// Every site consumes this predicate so a new reference kind can never
// drift between derivation and enforcement.
export const messageReferencesParticipant = (
	message: ParticipantReferenceRow,
	participantId: number,
): boolean =>
	message.authorParticipantId === participantId ||
	message.contextHumanParticipantId === participantId ||
	message.contextModelParticipantId === participantId;

// Whether any Message of the Conversation still refers to the Participant.
// These are the retained references that demand a tombstone; without any,
// the Participant can be hard-deleted.
export const hasRetainedParticipantReference = (
	db: ConversationDatabase,
	conversationId: number,
	participantId: number,
) =>
	db
		.select({
			authorParticipantId: messageTable.author_participant_id,
			contextHumanParticipantId: messageTable.context_human_participant_id,
			contextModelParticipantId: messageTable.context_model_participant_id,
		})
		.from(messageTable)
		.where(eq(messageTable.chat_id, conversationId))
		.all()
		.some((message) => messageReferencesParticipant(message, participantId));

export const requireMessage = (
	db: ConversationDatabase,
	conversationId: number,
	messageId: number,
) => {
	const message = db
		.select()
		.from(messageTable)
		.where(
			and(
				eq(messageTable.id, messageId),
				eq(messageTable.chat_id, conversationId),
			),
		)
		.get();

	if (message === undefined) {
		throw new InvalidConversationCommandError(
			`Message ${messageId} does not belong to Conversation ${conversationId}.`,
		);
	}

	return message;
};

export const requireVariant = (
	db: ConversationDatabase,
	conversationId: number,
	messageId: number,
	variantId: number,
) => {
	requireMessage(db, conversationId, messageId);
	const variant = db
		.select()
		.from(messageVariantTable)
		.where(
			and(
				eq(messageVariantTable.id, variantId),
				eq(messageVariantTable.message_id, messageId),
			),
		)
		.get();

	if (variant === undefined) {
		throw new InvalidConversationCommandError(
			`Variant ${variantId} does not belong to Message ${messageId}.`,
		);
	}

	return variant;
};
