import type { Database } from "bun:sqlite";
import { and, asc, eq, isNull, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	activeGenerationTable,
	characterTable,
	conversationControlTable,
	messageTable,
	messageVariantTable,
	participantOpeningTable,
	participantPromptTable,
	participantTable,
	toPromptChannelRow,
} from "../database/schema";
import type { ParticipantDefinition } from "./types";
import type { ControlAssignment } from "../../shared/cast";
import { isImportOwnedDataNamespace } from "../../shared/import-data";
import {
	InvalidConversationCommandError,
} from "./errors";

export const connectConversationDatabase = (database: Database) => drizzle(database);
export type ConversationDatabase = ReturnType<typeof connectConversationDatabase>;

// ==[HUMAN APPROVED]== The Control assignment state aliases the shared ControlAssignment
// declaration (ADR-0032) so the domain read model can never drift from the
// snapshot and client derivations.
export type ControlAssignmentState = ControlAssignment;

// ==[HUMAN APPROVED]== Reads the current Control assignment. A Conversation is playable only when
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
		.where(eq(conversationControlTable.conversation_id, conversationId))
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

export interface ActiveCastRow {
	id: number;
	position: number;
	name: string;
	sourceCharacterId: number | null;
	sourceCharacterName: string | null;
	systemInstruction: string;
	identity: string;
	scenario: string;
	exampleDialogue: string;
	postHistoryInstruction: string;
}

// ==[HUMAN APPROVED]== Every Conversation read model uses the same active Cast query. The
// complete row keeps lightweight history reads and detailed snapshots on one
// active-membership definition while callers choose their own projection.
export const readActiveCast = (
	db: ConversationDatabase,
	conversationId: number,
): ActiveCastRow[] =>
	db
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
				eq(participantTable.conversation_id, conversationId),
				isNull(participantTable.deleted_at),
			),
		)
		.orderBy(asc(participantTable.position))
		.all();

export const groupRowsByNumber = <Row, Value>(
	rows: readonly Row[],
	keyOf: (row: Row) => number,
	toValue: (row: Row) => Value,
): Map<number, Value[]> => {
	const grouped = new Map<number, Value[]>();
	for (const row of rows) {
		const key = keyOf(row);
		const values = grouped.get(key) ?? [];
		values.push(toValue(row));
		grouped.set(key, values);
	}
	return grouped;
};

export const groupVariantsByMessage = <
	Row extends { message_id: number },
	Value,
>(
	rows: readonly Row[],
	toValue: (row: Row) => Value,
): Map<number, Value[]> => groupRowsByNumber(rows, (row) => row.message_id, toValue);

// ==[HUMAN APPROVED]== The one Active-Generation existence probe: every gate that must
// treat a running Generation as mutually exclusive reads this predicate, so
// the probe query and its existence rule are written once for the module.
// Like every public entry point it takes the raw Database and connects
// internally, so no caller — including the workflows layer — ever
// constructs the module's Drizzle handle.
export const hasActiveGeneration = (
	database: Database,
	conversationId: number,
): boolean =>
	connectConversationDatabase(database)
		.select({ id: activeGenerationTable.id })
		.from(activeGenerationTable)
		.where(eq(activeGenerationTable.conversation_id, conversationId))
		.get() !== undefined;

// ==[HUMAN APPROVED]== Writes a complete Control assignment by deleting the Conversation's rows
// and reinserting the occupied seats. Replace-all avoids a temporary unique
// violation on the per-Participant Control index during an atomic swap or an
// incomplete-import completion fill. Shared by assign-control and by the
// add-participant completion path so seat writes never diverge.
export const writeControlAssignment = (
	db: ConversationDatabase,
	conversationId: number,
	assignment: ControlAssignmentState,
) => {
	db.delete(conversationControlTable)
		.where(eq(conversationControlTable.conversation_id, conversationId))
		.run();
	const rows = [];
	if (assignment.humanParticipantId !== null) {
		rows.push({
			conversation_id: conversationId,
			seat: "human" as const,
			participant_id: assignment.humanParticipantId,
		});
	}
	if (assignment.modelParticipantId !== null) {
		rows.push({
			conversation_id: conversationId,
			seat: "model" as const,
			participant_id: assignment.modelParticipantId,
		});
	}
	if (rows.length > 0) {
		db.insert(conversationControlTable).values(rows).run();
	}
};

// ==[HUMAN APPROVED]== Names follow the shared Definition rules: surrounding whitespace is
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

// ==[HUMAN APPROVED]== Openings are stored exactly as authored; only fully blank entries are
// rejected, matching Character Library rules.
export const requireParticipantOpenings = (
	openings: string[],
): string[] => {
	openings.forEach((opening, index) => {
		if (opening.trim() === "") {
			throw new InvalidConversationCommandError(
				`Opening at position ${index + 1} is blank; openings must contain text.`,
			);
		}
	});
	return openings;
};

// ==[HUMAN APPROVED]== Validates a complete Participant Definition for Cast management
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
				eq(participantTable.conversation_id, conversationId),
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

// ==[HUMAN APPROVED]== The reference columns a Message uses to refer to a Participant: its
// immutable Author Stamp or either side of its captured historical Control
// pair. The neutral shape lets the DB commands and the snapshot derivation
// share one predicate.
export interface ParticipantReferenceRow {
	authorParticipantId: number | null;
	contextHumanParticipantId: number | null;
	contextModelParticipantId: number | null;
}

// ==[HUMAN APPROVED]== The single retained-reference rule shared by the snapshot derivation and
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

// ==[HUMAN APPROVED]== Whether any Message of the Conversation still refers to the Participant.
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
		.where(eq(messageTable.conversation_id, conversationId))
		.all()
		.some((message) => messageReferencesParticipant(message, participantId));

// ==[HUMAN APPROVED]== Generic data commands write only generic namespaces. The import-owned
// namespaces hold server-owned provenance written by the import projection
// at Conversation creation (ADR-0028); no generic write or delete may ever
// address them, in any scope.
export const requireGenericDataNamespace = (namespace: string): void => {
	if (isImportOwnedDataNamespace(namespace)) {
		throw new InvalidConversationCommandError(
			`The ${namespace} namespace is import-owned provenance; generic data commands cannot address it.`,
		);
	}
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
				eq(messageTable.conversation_id, conversationId),
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

export interface InsertedParticipant {
	id: number;
	name: string;
	openings: readonly string[];
}

// ==[HUMAN APPROVED]== One Participant insertion: the active row, its complete local
// Definition prompt, and its ordered openings. Shared by native creation and
// the Cast append so the three written rows cannot drift. Insertion failures
// always throw the module's canonical command error; creation maps it to its
// own contract class at the creation boundary, so the shared write never
// learns about the creation/command transport split.
export const insertParticipant = (
	db: ConversationDatabase,
	conversationId: number,
	position: number,
	definition: ParticipantDefinition,
	sourceCharacterId: number | null,
): InsertedParticipant => {
	const name = normalizeParticipantName(definition.name);
	const inserted = db
		.insert(participantTable)
		.values({
			conversation_id: conversationId,
			name,
			position,
			source_character_id: sourceCharacterId,
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
			...toPromptChannelRow(definition.prompt),
		})
		.run();

	const openings = [...definition.openings];
	if (openings.length > 0) {
		db.insert(participantOpeningTable)
			.values(
				openings.map((content, index) => ({
					participant_id: inserted.id,
					position: index + 1,
					content,
				})),
			)
			.run();
	}

	return { id: inserted.id, name, openings };
};

// ==[HUMAN APPROVED]== The Author Stamp and captured historical Control pair a Message
// carries. The shared shapes keep every insertion site writing exactly the
// same columns.
export interface MessageAuthorStamp {
	participantId: number;
	name: string;
}

export interface MessageControlContext {
	humanParticipantId: number;
	modelParticipantId: number;
}

// ==[HUMAN APPROVED]== One Message insertion shared by creation, Compose, and the
// provisional Generation targets: the returning id is required, so a failed
// insert is an error instead of a silent undefined dereference. Insertion
// failures always throw the module's canonical command error; creation maps
// it to its own contract class at the creation boundary, so the shared write
// never learns about the creation/command transport split.
export const insertMessage = (
	db: ConversationDatabase,
	values: {
		conversationId: number;
		position: number;
		timestamp: string;
		author: MessageAuthorStamp | null;
		context: MessageControlContext | null;
	},
): number => {
	const inserted = db
		.insert(messageTable)
		.values({
			conversation_id: values.conversationId,
			position: values.position,
			timestamp: values.timestamp,
			author_participant_id: values.author?.participantId ?? null,
			author_name: values.author?.name ?? null,
			context_human_participant_id: values.context?.humanParticipantId ?? null,
			context_model_participant_id: values.context?.modelParticipantId ?? null,
		})
		.returning({ id: messageTable.id })
		.get();
	if (inserted === undefined) {
		throw new InvalidConversationCommandError(
			"The Message could not be persisted.",
		);
	}
	return inserted.id;
};

export interface VariantInsertValues {
	messageId: number;
	position: number;
	content: string;
	timestamp: string;
	selected: boolean;
}

// ==[HUMAN APPROVED]== One Variant insertion with its required returning id, so callers
// that address the new Variant (provisional targets, per-Variant data rows)
// never read an undefined identifier.
export const insertVariant = (
	db: ConversationDatabase,
	values: VariantInsertValues,
): number => {
	const inserted = db
		.insert(messageVariantTable)
		.values({
			message_id: values.messageId,
			position: values.position,
			content: values.content,
			timestamp: values.timestamp,
			selected: values.selected,
		})
		.returning({ id: messageVariantTable.id })
		.get();
	if (inserted === undefined) {
		throw new InvalidConversationCommandError(
			"The Variant could not be persisted.",
		);
	}
	return inserted.id;
};

// ==[HUMAN APPROVED]== Batch Variant insertion for Messages created with several Variants
// at once; the returning ids keep per-Variant data rows addressable.
export const insertVariants = (
	db: ConversationDatabase,
	values: readonly VariantInsertValues[],
): number[] => {
	if (values.length === 0) return [];
	return db
		.insert(messageVariantTable)
		.values(
			values.map((value) => ({
				message_id: value.messageId,
				position: value.position,
				content: value.content,
				timestamp: value.timestamp,
				selected: value.selected,
			})),
		)
		.returning({ id: messageVariantTable.id })
		.all()
		.map((row) => row.id);
};

// ==[HUMAN APPROVED]== Appending one selected Variant displaces the Message's current
// selection and takes the next position. Shared by Swipe creation and the
// provisional Sibling target so the deselect-then-insert rule is written once.
export const appendSelectedVariant = (
	db: ConversationDatabase,
	values: {
		messageId: number;
		content: string;
		timestamp: string;
	},
): number => {
	db.update(messageVariantTable)
		.set({ selected: false })
		.where(eq(messageVariantTable.message_id, values.messageId))
		.run();
	const position = db
		.select({ value: max(messageVariantTable.position) })
		.from(messageVariantTable)
		.where(eq(messageVariantTable.message_id, values.messageId))
		.get()?.value ?? 0;
	return insertVariant(db, {
		messageId: values.messageId,
		position: position + 1,
		content: values.content,
		timestamp: values.timestamp,
		selected: true,
	});
};
