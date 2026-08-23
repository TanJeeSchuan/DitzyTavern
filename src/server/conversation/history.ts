// Paginated history read model: the normal Chat read seam for reading
// native Messages. Pages serve stable position-ordered (chronological)
// Messages with the lightweight Participant identity and selected Variant
// state needed for rendering — and nothing heavier. Exact artifact bytes,
// the canonical archive text, reasoning, signatures, generation IDs, and
// other message/variant/Conversation-scoped provenance are excluded here
// and load only through deliberate detail operations.
//
// Imported Chats graduate into exactly this read model: their Messages use
// the immutable Author Stamp created from the resolved Participant name,
// and ordinary swipe navigation after commit is the existing revisioned
// Variant-selection command, never a second source representation.

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { chatTable, messageTable, messageVariantTable, participantTable } from "../database/schema";
import type { ConversationDatabase } from "./internal";
import type {
	AuthorStampSnapshot,
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

// Reads one page of the stable Message sequence. The requested page is
// bounded into the available range (a page beyond the end serves the final
// page), matching how an accumulation client treats repeated reads. A
// missing Conversation is undefined; there is no partial page.
export function readChatHistory(
	db: ConversationDatabase,
	conversationId: number,
	request: ChatHistoryPageRequest = {},
): ChatHistoryPage | undefined {
	const conversation = db
		.select()
		.from(chatTable)
		.where(eq(chatTable.id, conversationId))
		.get();
	if (conversation === undefined) return undefined;

	const totalMessages = db
		.select({ count: messageTable.id })
		.from(messageTable)
		.where(eq(messageTable.chat_id, conversationId))
		.all().length;

	const pageSize = boundedPageSize(request.pageSize);
	const totalPages = Math.max(1, Math.ceil(totalMessages / pageSize));
	const requested = request.page ?? 1;
	const pageIndex = Math.min(
		totalPages,
		Math.max(1, Number.isInteger(requested) ? requested : 1),
	);
	const offset = (pageIndex - 1) * pageSize;

	// Stable chronology: creation order (position ascending) never reorders
	// when Variant selection changes or Messages are later edited.
	const messageRows = db
		.select()
		.from(messageTable)
		.where(eq(messageTable.chat_id, conversationId))
		.orderBy(asc(messageTable.position))
		.limit(pageSize)
		.offset(offset)
		.all();
	const messageIds = messageRows.map((message) => message.id);

	// Variant order is preserved with the selected state; empty and
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

	const variantsByMessage = new Map<number, ChatHistoryVariant[]>();
	for (const variant of variantRows) {
		const variants = variantsByMessage.get(variant.message_id) ?? [];
		variants.push({
			id: variant.id,
			position: variant.position,
			content: variant.content,
			timestamp: variant.timestamp,
			selected: variant.selected,
		});
		variantsByMessage.set(variant.message_id, variants);
	}

	const castIds = new Set<number>();
	const cast = db
		.select({
			id: participantTable.id,
			position: participantTable.position,
			name: participantTable.name,
		})
		.from(participantTable)
		.where(
			and(
				eq(participantTable.chat_id, conversationId),
				isNull(participantTable.deleted_at),
			),
		)
		.orderBy(asc(participantTable.position))
		.all();
	for (const participant of cast) castIds.add(participant.id);

	const messages: ChatHistoryMessage[] = messageRows.map((message) => {
		const author: AuthorStampSnapshot | null =
			message.author_participant_id !== null || message.author_name !== null
				? {
						participantId: message.author_participant_id,
						capturedName: message.author_name,
						// Derived historical display state: the captured name keeps
						// displaying with a no-longer-in-Cast marker after removal.
						inCast:
							message.author_participant_id !== null &&
							castIds.has(message.author_participant_id),
					}
				: null;
		return {
			id: message.id,
			position: message.position,
			timestamp: message.timestamp,
			author,
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
			hasPrevious: pageIndex > 1,
			hasNext: pageIndex < totalPages,
		},
		messages,
	};
}