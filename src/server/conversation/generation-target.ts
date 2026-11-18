import { and, desc, eq } from "drizzle-orm";
import type { GenerationIntent } from "../../shared/contract/conversation-schema";
import { messageTable, messageVariantTable } from "../database/schema";
import { authorRoleOf, continuationEligibility } from "./continuation";
import { ContinuationUnavailableError, ConversationNotPlayableError, SiblingVariantUnavailableError } from "./errors";
import { readActiveCast, readControlAssignment, requireMessage, type ConversationDatabase } from "./internal";
import { toAuthorStamp, toHistoricalContext } from "./message-read-projection";
import { deriveControlValidity, deriveMessageSwipeEligibility } from "./snapshot";
import { readVariantData } from "./variant-data";
import type { CapturedGenerationTarget, ConversationGenerationSettings, HistoricalControlSnapshot } from "./types";

type ContinuationTarget = Extract<CapturedGenerationTarget, { kind: "continuation" }>;
interface TerminalTarget { messageId: number; variantId: number; position: number }

export const promptIntentOf = (target: CapturedGenerationTarget): GenerationIntent | undefined =>
	target.kind === "continuation" ? target.intent : target.kind === "sibling" ? { type: "sibling" } : undefined;

export function requireSiblingHistoricalControl(db: ConversationDatabase, conversationId: number, messageId: number): HistoricalControlSnapshot {
	const control = readControlAssignment(db, conversationId);
	const context = toHistoricalContext(requireMessage(db, conversationId, messageId));
	const castIds = readActiveCast(db, conversationId).map(({ id }) => id);
	const eligibility = deriveMessageSwipeEligibility(deriveControlValidity(control, castIds).valid, context, castIds);
	if (!eligibility.eligible) {
		if (eligibility.reason === "conversation-not-playable") throw new ConversationNotPlayableError(conversationId);
		throw new SiblingVariantUnavailableError(eligibility.reason);
	}
	if (context === null) throw new SiblingVariantUnavailableError("missing-historical-context");
	return context;
}

export function requireTerminalTarget(
	db: ConversationDatabase,
	conversationId: number,
	strategy: ConversationGenerationSettings["continuationStrategy"],
	preceding?: Pick<ContinuationTarget, "precedingMessageId" | "precedingVariantId">,
): TerminalTarget {
	const control = readControlAssignment(db, conversationId);
	const latest = db.select().from(messageTable).where(eq(messageTable.conversation_id, conversationId)).orderBy(desc(messageTable.position)).limit(1).get();
	if (latest === undefined || (preceding !== undefined && latest.id !== preceding.precedingMessageId)) {
		throw new ContinuationUnavailableError("not-terminal-model-message");
	}
	const variant = db.select({ id: messageVariantTable.id, content: messageVariantTable.content }).from(messageVariantTable)
		.where(and(eq(messageVariantTable.message_id, latest.id), eq(messageVariantTable.selected, true))).get();
	if (variant === undefined || (preceding !== undefined && variant.id !== preceding.precedingVariantId)) {
		throw new ContinuationUnavailableError("not-terminal-model-message");
	}
	const castIds = new Set(readActiveCast(db, conversationId).map(({ id }) => id));
	const reason = continuationEligibility({
		authorRole: authorRoleOf({ author: toAuthorStamp(latest, castIds), historicalContext: toHistoricalContext(latest) }, control),
		content: variant.content,
		hasReasoning: (readVariantData(db, [variant.id], ["reasoning"]).get(variant.id)?.reasoning?.length ?? 0) > 0,
	}, strategy);
	if (reason !== null) throw new ContinuationUnavailableError(reason);
	return { messageId: latest.id, variantId: variant.id, position: latest.position };
}
