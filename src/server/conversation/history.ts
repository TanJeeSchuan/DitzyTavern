import { loadMessageRows } from "./message-rows";
import { authorRoleOf, continuationEligibility } from "./continuation";
// @approved
//  Paginated history read model: the normal Chat read seam for reading
// native Messages. Pages serve stable position-ordered (chronological)
// Messages with the lightweight Participant identity, selected Variant
// state, and persisted Reasoning Content needed for rendering. Exact artifact
// bytes, the canonical archive text, signatures, generation IDs, and other
// message/variant/Conversation-scoped provenance are excluded here
// and load only through deliberate detail operations.
// Imported Chats graduate into exactly this read model: their Messages use
// the immutable Author Stamp created from the resolved Participant name,
// and ordinary swipe navigation after commit is the existing revisioned
// Variant-selection command, never a second source representation.

import type { Database } from "bun:sqlite";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
	conversationTable,
	conversationGenerationSettingsTable,
	activeGenerationTable,
	messageTable,
} from "../database/schema";
import { DEFAULT_CONTINUATION_STRATEGY } from "../database/schema";
import {
	connectConversationDatabase,
	groupVariantsByMessage,
	readActiveCast,
	readControlAssignment,
} from "./internal";
import {
	deriveControlValidity,
	deriveMessageSwipeEligibility,
} from "./snapshot";
import {
	toAuthorStamp,
	toHistoricalContext,
} from "./message-read-projection";
import type {
	ChatHistoryMessage,
	ChatHistoryPage,
	ChatHistoryPageRequest,
	ChatHistoryVariant,
} from "./types";

export const DEFAULT_HISTORY_PAGE_SIZE = 50;
export const MAX_HISTORY_PAGE_SIZE = 200;

const boundedPageSize = (pageSize: number | undefined): number => {
	if (pageSize === undefined) return DEFAULT_HISTORY_PAGE_SIZE;
	if (!Number.isInteger(pageSize) || pageSize < 1) return DEFAULT_HISTORY_PAGE_SIZE;
	return Math.min(pageSize, MAX_HISTORY_PAGE_SIZE);
};

// @approved
//  Reads one page of the stable Message sequence, counted backward from the
// newest Message: page 1 serves the latest window and later pages reach
// further into older history. Each served page is still chronological. The
// requested page is bounded into the available range (a page beyond the end
// serves the final, oldest page), matching how an accumulation client treats
// repeated reads. A missing Conversation is undefined; there is no partial
// page. An aroundMessageId selects the same fixed page containing that Message;
// a missing Message in this Conversation is undefined.
export function readChatHistory(
	database: Database,
	conversationId: number,
	request: ChatHistoryPageRequest = {},
): ChatHistoryPage | undefined {
	const db = connectConversationDatabase(database);
	const conversation = db
		.select()
		.from(conversationTable)
		.where(eq(conversationTable.id, conversationId))
		.get();
	if (conversation === undefined) return undefined;
	const continuationStrategy = db
		.select({ strategy: conversationGenerationSettingsTable.continuation_strategy })
		.from(conversationGenerationSettingsTable)
		.where(eq(conversationGenerationSettingsTable.conversation_id, conversationId))
		.get()?.strategy ?? DEFAULT_CONTINUATION_STRATEGY;

	const totalMessages = db
		.select({ count: sql<number>`count(*)` })
		.from(messageTable)
		.where(eq(messageTable.conversation_id, conversationId))
		.get()?.count ?? 0;

	const pageSize = boundedPageSize(request.pageSize);
	const totalPages = Math.max(1, Math.ceil(totalMessages / pageSize));
	let requested = request.page ?? 1;
	if (request.aroundMessageId !== undefined) {
		const target = db.select({ position: messageTable.position }).from(messageTable)
			.where(and(eq(messageTable.conversation_id, conversationId), eq(messageTable.id, request.aroundMessageId))).get();
		if (target === undefined) return undefined;
		const newer = db.select({ count: sql<number>`count(*)` }).from(messageTable)
			.where(and(eq(messageTable.conversation_id, conversationId), gt(messageTable.position, target.position))).get()!.count;
		requested = Math.floor(newer / pageSize) + 1;
	}
	const pageIndex = Math.min(
		totalPages,
		Math.max(1, Number.isInteger(requested) ? requested : 1),
	);
	const offset = (pageIndex - 1) * pageSize;

	// @approved
	//  Stable chronology: creation order (position ascending) never reorders
	// when Variant selection changes or Messages are later edited. Pages are
	// cut from the tail (newest first) and reversed so every served page is
	// chronological while page 1 remains the latest window.
	const pageRows = db
		.select({ id: messageTable.id })
		.from(messageTable)
		.where(eq(messageTable.conversation_id, conversationId))
		.orderBy(desc(messageTable.position))
		.limit(pageSize)
		.offset(offset)
		.all()
		.reverse();
	const messageIds = pageRows.map((message) => message.id);

	const rows = loadMessageRows(db, conversationId, { ids: messageIds, variantData: { namespace: "generation", keys: ["reasoning"] } });
	const messageRows = rows.messages;
	const variantRows = rows.variants;
	const reasoningByVariant = new Map([...rows.variantData].map(([id, entries]) => [id, entries[0]!.value]));
	const liveGenerationByVariant = new Map(
		variantRows.length === 0
			? []
			: db
					.select({
						generationId: activeGenerationTable.id,
						variantId: activeGenerationTable.variant_id,
						eventId: activeGenerationTable.checkpoint_event_id,
						content: activeGenerationTable.checkpoint_content,
						reasoning: activeGenerationTable.checkpoint_reasoning,
					})
					.from(activeGenerationTable)
					.where(inArray(
						activeGenerationTable.variant_id,
						variantRows.map((variant) => variant.id),
					))
					.all()
					.map((row) => [row.variantId, {
						generationId: row.generationId,
						eventId: row.eventId,
						content: row.content,
						reasoning: row.reasoning,
					}] as const),
	);

	const variantsByMessage = groupVariantsByMessage(
		variantRows,
		(variant): ChatHistoryVariant => {
			const historyVariant: ChatHistoryVariant = {
				id: variant.id,
				position: variant.position,
				content: variant.content,
				timestamp: variant.timestamp,
				selected: variant.selected,
			};
			const reasoning = reasoningByVariant.get(variant.id);
			if (reasoning !== undefined) historyVariant.reasoning = reasoning;
			const liveGeneration = liveGenerationByVariant.get(variant.id);
			if (liveGeneration !== undefined) historyVariant.liveGeneration = liveGeneration;
			return historyVariant;
		},
	);

	const activeCast = readActiveCast(db, conversationId);
	const cast = activeCast.map(({ id, position, name }) => ({ id, position, name }));
	const castIds = activeCast.map((participant) => participant.id);
	const castIdsSet = new Set(castIds);

	// @approved
	//  Playability is the single derived Control-validity rule, and the
	// capability objects below flow through the canonical snapshot helpers,
	// so the history seam can never disagree with the snapshot or the
	// commands about sibling eligibility.
	const control = readControlAssignment(db, conversationId);
	const playable = deriveControlValidity(
		control,
		castIds,
	).valid;

	const messages: ChatHistoryMessage[] = messageRows.map((message) => {
		const author = toAuthorStamp(message, castIdsSet);
		const historicalContext = toHistoricalContext(message);
		const selected = variantsByMessage.get(message.id)?.find((variant) => variant.selected);
		return {
			id: message.id,
			position: message.position,
			timestamp: message.timestamp,
			author,
			modelParticipantIdAtCreation:
				message.context_model_participant_id ?? null,
			continuable: selected !== undefined && continuationEligibility({
				authorRole: authorRoleOf({ author, historicalContext }, control),
				content: selected.content,
				hasReasoning: (selected.reasoning?.length ?? 0) > 0,
			}, continuationStrategy) === null,
			// @approved
			//  Server-derived targeted Swipe eligibility from the canonical rule
			// (ADR-0003): the client never reconstructs it from hints.
			swipe: deriveMessageSwipeEligibility(
				playable,
				historicalContext,
				castIds,
			),
			variants: [...(variantsByMessage.get(message.id) ?? [])],
		};
	});

	return {
		conversationId: conversation.id,
		name: conversation.name,
		revision: conversation.revision,
		cast,
		page: {
			index: pageIndex,
			pageSize,
			totalMessages,
			totalPages,
			hasOlder: pageIndex < totalPages,
			hasNewer: pageIndex > 1,
		},
		messages,
	};
}
