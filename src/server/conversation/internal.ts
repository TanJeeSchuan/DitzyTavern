import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
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
