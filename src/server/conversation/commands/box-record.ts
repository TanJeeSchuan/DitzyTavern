import type { RecordBoxId } from "../../../shared/contract/box";
import type { BoxRecord } from "../../../shared/contract/box-generation";
import { resetWriterRecord, writeWriterRecord } from "../../box/records";
import { InvalidConversationCommandError } from "../errors";
import type { ConversationDatabase } from "../internal";
import { requireBoxInstance, requireVariant } from "../internal";
import { eq } from "drizzle-orm";
import { activeGenerationTable } from "../../database/schema";

// @approved
//  A Writer override is a complete record for one Variant. The command route
//  validates it against the Box's record schema before the handler runs, so
//  storage only ever holds decodable records, and the Variant is checked to
//  belong to this Conversation before anything lands.
export function setBoxRecord(db: ConversationDatabase, input: { conversationId: number; box: RecordBoxId; messageId: number; variantId: number; record: BoxRecord<RecordBoxId> }): void {
	requireVariant(db, input.conversationId, input.messageId, input.variantId);
	// @approved
	//  A Variant still generating gets its records when it settles, so an
	//  override would collide with the record its Generation writes then.
	const active = db.select({ id: activeGenerationTable.id }).from(activeGenerationTable).where(eq(activeGenerationTable.variant_id, input.variantId)).get();
	if (active !== undefined) throw new InvalidConversationCommandError("This Variant is still generating. Override its record once it settles.");
	writeWriterRecord(db, input.box, requireBoxInstance(db, input.conversationId, input.box), input.variantId, input.record);
}

/** @approved Reset drops the override and leaves the automatic record, if any, in place. */
export function resetBoxRecord(db: ConversationDatabase, input: { conversationId: number; box: RecordBoxId; messageId: number; variantId: number }): void {
	requireVariant(db, input.conversationId, input.messageId, input.variantId);
	resetWriterRecord(db, input.box, requireBoxInstance(db, input.conversationId, input.box), input.variantId);
}
