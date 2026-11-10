import { readVariantData } from "./variant-data";
import { variantDataCodecs } from "../../shared/variant-data-codecs";
// @approved
//  Deliberate Generation detail reads. These are kept out of the ordinary
// Conversation snapshot/history paths so active prompt text is retained only
// for the bounded server-owned lifecycle and terminal reads expose only the
// compact safe provenance allow-list.

import type { Database } from "bun:sqlite";
import { and, eq, getTableColumns } from "drizzle-orm";
import {
	activeGenerationTable,
	generationCaptureTable,
	generationReplayTable,
	messageTable,
	messageVariantTable,
} from "../database/schema";
import {
	connectConversationDatabase,
	findConversation,
	readActiveCast,
	type ConversationDatabase,
} from "./internal";
import { checkpointColumns, liveVariantContent, selectActiveGenerations } from "./generation-checkpoint";
import { decodeGenerationCapture } from "./generation-capture";
import {
	toAuthorStamp,
	toHistoricalContext,
} from "./message-read-projection";
import type {
	ActiveGenerationDetails,
	VariantDetails,
} from "./types";
import { decodeStoredGenerationIntent } from "./generation-state";

export function readActiveGenerationDetails(
	database: Database,
	conversationId: number,
	generationId: number,
): ActiveGenerationDetails | undefined {
	return readActiveGenerationDetailsFromConnection(
		connectConversationDatabase(database),
		conversationId,
		generationId,
	);
}

export function readActiveGenerationDetailsFromConnection(
	db: ConversationDatabase,
	conversationId: number,
	generationId: number,
): ActiveGenerationDetails | undefined {
	const active = selectActiveGenerations(db).where(and(
		eq(activeGenerationTable.id, generationId),
		eq(activeGenerationTable.conversation_id, conversationId),
	)).get();
	const retained = active === undefined
		? db.select().from(generationReplayTable).where(and(
			eq(generationReplayTable.id, generationId),
			eq(generationReplayTable.conversation_id, conversationId),
		)).get()
		: undefined;
	if (retained !== undefined && retained.expires_at <= new Date().toISOString()) {
		db.delete(generationReplayTable)
			.where(eq(generationReplayTable.id, retained.id))
			.run();
		return undefined;
	}
	const row = active ?? retained;
	if (row === undefined) return undefined;
	if (findConversation(db, conversationId) === undefined) return undefined;
	const captured = db.select({ capture: generationCaptureTable.capture }).from(generationCaptureTable)
		.where(eq(generationCaptureTable.generation_id, row.id)).get()!;
	const capture = decodeGenerationCapture(captured.capture);
	const loreActivation = variantDataCodecs.loreActivation.decode(row.lore_activation_json);
	return {
		conversationId,
		generationId: row.id,
		messageId: row.message_id,
		variantId: row.variant_id,
		startedAt: row.started_at,
		status: "terminal_status" in row ? row.terminal_status : "active",
		intent: decodeStoredGenerationIntent(row.generation_intent_json),
		participants: {
			human: { id: row.human_participant_id, name: row.captured_human_name },
			model: { id: row.model_participant_id, name: row.captured_model_name },
		},
		modelId: capture.modelId,
		promptPlan: capture.promptPlan,
		loreActivation,
		boxTraces: variantDataCodecs.boxTraces.decode(row.box_traces_json),
		budget: capture.promptInspection,
		checkpoint: {
			content: row.checkpoint_content,
			reasoning: row.checkpoint_reasoning,
			latestEventId: row.checkpoint_event_id,
			checkpointedAt: row.checkpointed_at,
		},
	};
}

export function readVariantDetails(
	database: Database,
	conversationId: number,
	messageId: number,
	variantId: number,
): VariantDetails | undefined {
	return readVariantDetailsFromConnection(
		connectConversationDatabase(database),
		conversationId,
		messageId,
		variantId,
	);
}

export function readVariantDetailsFromConnection(
	db: ConversationDatabase,
	conversationId: number,
	messageId: number,
	variantId: number,
): VariantDetails | undefined {
	const message = db.select().from(messageTable).where(and(
		eq(messageTable.id, messageId),
		eq(messageTable.conversation_id, conversationId),
	)).get();
	if (message === undefined) return undefined;
	const variant = db.select({ ...getTableColumns(messageVariantTable), content: liveVariantContent }).from(messageVariantTable).where(and(
		eq(messageVariantTable.id, variantId),
		eq(messageVariantTable.message_id, messageId),
	)).get();
	if (variant === undefined) return undefined;
	const data = readVariantData(db, [variantId], ["provenance", "loreActivation", "boxTraces"]).get(variantId);
	const loreActivation = data?.loreActivation ?? null;
	const castIds = message.author_participant_id === null
		? new Set<number>()
		: new Set(readActiveCast(db, conversationId).map((participant) => participant.id));
	return {
		conversationId,
		messageId,
		variantId,
		content: variant.content,
		timestamp: variant.timestamp,
		author: toAuthorStamp(message, castIds),
		historicalContext: toHistoricalContext(message),
		provenance: data?.provenance ?? null,
		loreActivation,
		boxTraces: data?.boxTraces ?? {},
	};
}

export function readActiveGenerationsForRecovery(database: Database) {
 return connectConversationDatabase(database).select({
  id: activeGenerationTable.id,
  conversationId: activeGenerationTable.conversation_id,
  checkpointContent: checkpointColumns.checkpoint_content,
  checkpointReasoning: checkpointColumns.checkpoint_reasoning,
 }).from(activeGenerationTable).all();
}
