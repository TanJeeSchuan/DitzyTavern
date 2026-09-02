// ==[HUMAN APPROVED]== Paginated history read model: the normal Chat read seam for reading
// native Messages. Pages serve stable position-ordered (chronological)
// Messages with the lightweight Participant identity, selected Variant
// state, and persisted Reasoning Content needed for rendering. Exact artifact
// bytes, the canonical archive text, signatures, generation IDs, and other
// message/variant/Conversation-scoped provenance are excluded here
// and load only through deliberate detail operations.
//
// Imported Chats graduate into exactly this read model: their Messages use
// the immutable Author Stamp created from the resolved Participant name,
// and ordinary swipe navigation after commit is the existing revisioned
// Variant-selection command, never a second source representation.

import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
	chatTable,
	conversationGenerationSettingsTable,
	messageTable,
	messageVariantDataTable,
	messageVariantTable,
} from "../database/schema";
import { DEFAULT_CONTINUATION_STRATEGY } from "./generation-defaults";
import {
	connectConversationDatabase,
	groupVariantsByMessage,
	readActiveCast,
	readControlAssignment,
} from "./internal";
import {
	deriveControlValidity,
	deriveMessageSwipeEligibility,
	toAuthorStamp,
	toHistoricalContext,
} from "./snapshot";
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

// ==[HUMAN APPROVED]== A Message is continuable when its selected Variant carries visible
// content or — under the instruction strategy — persisted Reasoning
// Content. Named (not an inline IIFE) so the read model states its rule
// once, beside the acceptance path's related but deliberately different
// reasoning rule.
const isContinuable = (
	selected: ChatHistoryVariant | undefined,
	continuationStrategy: string,
): boolean =>
	selected !== undefined &&
	(selected.content.length > 0 ||
		(continuationStrategy === "instruction" &&
			(selected.reasoning?.length ?? 0) > 0));

// ==[HUMAN APPROVED]== Reads one page of the stable Message sequence, counted backward from the
// newest Message: page 1 serves the latest window and later pages reach
// further into older history. Each served page is still chronological. The
// requested page is bounded into the available range (a page beyond the end
// serves the final, oldest page), matching how an accumulation client treats
// repeated reads. A missing Conversation is undefined; there is no partial
// page.
export function readChatHistory(
	database: Database,
	conversationId: number,
	request: ChatHistoryPageRequest = {},
): ChatHistoryPage | undefined {
	const db = connectConversationDatabase(database);
	const conversation = db
		.select()
		.from(chatTable)
		.where(eq(chatTable.id, conversationId))
		.get();
	if (conversation === undefined) return undefined;
	const continuationStrategy = db
		.select({ strategy: conversationGenerationSettingsTable.continuation_strategy })
		.from(conversationGenerationSettingsTable)
		.where(eq(conversationGenerationSettingsTable.chat_id, conversationId))
		.get()?.strategy ?? DEFAULT_CONTINUATION_STRATEGY;

	const totalMessages = db
		.select({ count: sql<number>`count(*)` })
		.from(messageTable)
		.where(eq(messageTable.chat_id, conversationId))
		.get()?.count ?? 0;

	const pageSize = boundedPageSize(request.pageSize);
	const totalPages = Math.max(1, Math.ceil(totalMessages / pageSize));
	const requested = request.page ?? 1;
	const pageIndex = Math.min(
		totalPages,
		Math.max(1, Number.isInteger(requested) ? requested : 1),
	);
	const offset = (pageIndex - 1) * pageSize;

	// ==[HUMAN APPROVED]== Stable chronology: creation order (position ascending) never reorders
	// when Variant selection changes or Messages are later edited. Pages are
	// cut from the tail (newest first) and reversed so every served page is
	// chronological while page 1 remains the latest window.
	const messageRows = db
		.select()
		.from(messageTable)
		.where(eq(messageTable.chat_id, conversationId))
		.orderBy(desc(messageTable.position))
		.limit(pageSize)
		.offset(offset)
		.all()
		.reverse();
	const messageIds = messageRows.map((message) => message.id);

	// ==[HUMAN APPROVED]== Variant order is preserved with the selected state; empty and
	// duplicate variants remain distinct positions with their exact content.
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

	const reasoningByVariant = new Map<number, string>(
		variantRows.length === 0
			? []
			: db
					.select({
						variantId: messageVariantDataTable.message_variant_id,
						value: messageVariantDataTable.value,
					})
					.from(messageVariantDataTable)
					.where(
						and(
							inArray(
								messageVariantDataTable.message_variant_id,
								variantRows.map((variant) => variant.id),
							),
							eq(messageVariantDataTable.namespace, "generation"),
							eq(messageVariantDataTable.key, "reasoning"),
						),
					)
					.all()
					.map((row) => [row.variantId, row.value]),
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
			return historyVariant;
		},
	);

	const activeCast = readActiveCast(db, conversationId);
	const cast = activeCast.map(({ id, position, name }) => ({ id, position, name }));
	const castIds = activeCast.map((participant) => participant.id);
	const castIdsSet = new Set(castIds);

	// ==[HUMAN APPROVED]== Playability is the single derived Control-validity rule, and the
	// capability objects below flow through the canonical snapshot helpers,
	// so the history seam can never disagree with the snapshot or the
	// commands about sibling eligibility.
	const playable = deriveControlValidity(
		readControlAssignment(db, conversationId),
		castIds,
	).valid;

	const messages: ChatHistoryMessage[] = messageRows.map((message) => {
		const author = toAuthorStamp(message, castIdsSet);
		const historicalContext = toHistoricalContext(message);
		return {
			id: message.id,
			position: message.position,
			timestamp: message.timestamp,
			author,
			modelParticipantIdAtCreation:
				message.context_model_participant_id ?? null,
			continuable: isContinuable(
				variantsByMessage.get(message.id)?.find((variant) => variant.selected),
				continuationStrategy,
			),
			// ==[HUMAN APPROVED]== Server-derived targeted Swipe eligibility from the canonical rule
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
