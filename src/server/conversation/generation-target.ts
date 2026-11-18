import { and, desc, eq } from "drizzle-orm";
import { messageTable, messageVariantTable } from "../database/schema";
import { authorRoleOf, continuationEligibility } from "./continuation";
import { ContinuationUnavailableError, ConversationNotPlayableError, SiblingVariantUnavailableError } from "./errors";
import { readActiveCast, readControlAssignment, requireMessage, type ConversationDatabase } from "./internal";
import { toAuthorStamp, toHistoricalContext } from "./message-read-projection";
import { deriveControlValidity, deriveMessageSwipeEligibility } from "./snapshot";
import { readVariantData } from "./variant-data";
import type { CapturedGenerationTarget, ConversationGenerationSettings, HistoricalControlSnapshot } from "./types";

type SiblingTarget = Extract<CapturedGenerationTarget, { kind: "sibling" }>;
interface ContinuationTarget {
	kind: "continuation";
	strategy: ConversationGenerationSettings["continuationStrategy"];
	preceding?: { messageId: number; variantId: number };
}
interface TerminalTarget { messageId: number; variantId: number; position: number }

export function requireGenerationTarget(db: ConversationDatabase, conversationId: number, target: SiblingTarget): HistoricalControlSnapshot;
export function requireGenerationTarget(db: ConversationDatabase, conversationId: number, target: ContinuationTarget): TerminalTarget;
export function requireGenerationTarget(db: ConversationDatabase, conversationId: number, target: SiblingTarget | ContinuationTarget): HistoricalControlSnapshot | TerminalTarget {
	const control = readControlAssignment(db, conversationId);
	if (target.kind === "sibling") {
		const context = toHistoricalContext(requireMessage(db, conversationId, target.messageId));
		const castIds = readActiveCast(db, conversationId).map(({ id }) => id);
		const eligibility = deriveMessageSwipeEligibility(deriveControlValidity(control, castIds).valid, context, castIds);
		if (!eligibility.eligible) {
			if (eligibility.reason === "conversation-not-playable") throw new ConversationNotPlayableError(conversationId);
			throw new SiblingVariantUnavailableError(eligibility.reason);
		}
		if (context === null) throw new SiblingVariantUnavailableError("missing-historical-context");
		return context;
	}
	const latest = db.select().from(messageTable).where(eq(messageTable.conversation_id, conversationId)).orderBy(desc(messageTable.position)).limit(1).get();
	if (latest === undefined || (target.preceding !== undefined && latest.id !== target.preceding.messageId)) {
		throw new ContinuationUnavailableError("not-terminal-model-message");
	}
	const variant = db.select({ id: messageVariantTable.id, content: messageVariantTable.content }).from(messageVariantTable)
		.where(and(eq(messageVariantTable.message_id, latest.id), eq(messageVariantTable.selected, true))).get();
	if (variant === undefined || (target.preceding !== undefined && variant.id !== target.preceding.variantId)) {
		throw new ContinuationUnavailableError("not-terminal-model-message");
	}
	const castIds = new Set(readActiveCast(db, conversationId).map(({ id }) => id));
	const reason = continuationEligibility({
		authorRole: authorRoleOf({ author: toAuthorStamp(latest, castIds), historicalContext: toHistoricalContext(latest) }, control),
		content: variant.content,
		hasReasoning: (readVariantData(db, [variant.id], ["reasoning"]).get(variant.id)?.reasoning?.length ?? 0) > 0,
	}, target.strategy);
	if (reason !== null) throw new ContinuationUnavailableError(reason);
	return { messageId: latest.id, variantId: variant.id, position: latest.position };
}
