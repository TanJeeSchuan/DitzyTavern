import type { BoxId } from "../../../shared/contract/box";
import { fitsBoxSchema, type BoxValue } from "../../../shared/contract/box-value";
import { Value } from "@sinclair/typebox/value";
import { effectiveRecord, readRecordSlots, resetWriterRecord, writeWriterRecord } from "../../box/records";
import { InvalidConversationCommandError } from "../errors";
import type { ConversationDatabase } from "../internal";
import { requireBox, requireBoxInstance, requireVariant } from "../internal";
import { eq } from "drizzle-orm";
import { activeGenerationTable } from "../../database/schema";

/** @approved The record schema of a registered Box that keeps records; any other id fails the command. */
const requireRecord = (box: BoxId) => {
	const { label, record } = requireBox(box);
	if (record === undefined) throw new InvalidConversationCommandError(`The ${label} Box keeps no records.`);
	return { label, record };
};

// @approved
//  A Writer override is a complete record for one Variant. The record, and
//  the `expected` one it replaces, must pass the Box's record schema before
//  anything is written, so storage only ever holds decodable records, and the
//  Variant is checked to belong to this Conversation before anything lands.
export function setBoxRecord(db: ConversationDatabase, input: { conversationId: number; box: BoxId; messageId: number; variantId: number; record: BoxValue; expected?: BoxValue }): void {
	const { label, record } = requireRecord(input.box);
	if (!fitsBoxSchema(record, input.record) || !(input.expected === undefined || input.expected === null || fitsBoxSchema(record, input.expected))) {
		throw new InvalidConversationCommandError(`The ${label} record does not match its schema.`);
	}
	requireVariant(db, input.conversationId, input.messageId, input.variantId);
	// @approved
	//  A Variant still generating gets its records when it settles, so an
	//  override would collide with the record its Generation writes then.
	const active = db.select({ id: activeGenerationTable.id }).from(activeGenerationTable).where(eq(activeGenerationTable.variant_id, input.variantId)).get();
	if (active !== undefined) throw new InvalidConversationCommandError("This Variant is still generating. Override its record once it settles.");
	const instance = requireBoxInstance(db, input.conversationId, input.box);
	if (input.expected !== undefined && !Value.Equal(effectiveRecord(readRecordSlots(db, input.box, record, instance, [input.variantId]).get(input.variantId)) ?? null, input.expected)) {
		throw new InvalidConversationCommandError("This record changed since you read it. Review it before changing it again.");
	}
	writeWriterRecord(db, input.box, instance, input.variantId, input.record);
}

/** @approved Reset drops the override and leaves the automatic record, if any, in place. */
export function resetBoxRecord(db: ConversationDatabase, input: { conversationId: number; box: BoxId; messageId: number; variantId: number }): void {
	requireRecord(input.box);
	requireVariant(db, input.conversationId, input.messageId, input.variantId);
	resetWriterRecord(db, input.box, requireBoxInstance(db, input.conversationId, input.box), input.variantId);
}
