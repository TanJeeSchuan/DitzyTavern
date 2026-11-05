import type { BoxId } from "../../../shared/contract/box";
import { fitsBoxSchema, type BoxValue } from "../../../shared/contract/box-value";
import { Value } from "@sinclair/typebox/value";
import { effectiveRecord, readRecordSlots, resetWriterRecord, writeWriterRecord } from "../../box/records";
import { InvalidConversationCommandError } from "../errors";
import type { ConversationDatabase } from "../internal";
import { requireBox, requireBoxInstance, requireVariant } from "../internal";

/** @approved The record schema of a registered Box that keeps records, at the version this Chat runs; any other id fails the command. */
const requireRecord = (db: ConversationDatabase, conversationId: number, box: BoxId) => {
	const { descriptor } = requireBox(db, conversationId, box);
	if (descriptor.record === undefined) throw new InvalidConversationCommandError(`The ${descriptor.label} Box keeps no records.`);
	return { descriptor, label: descriptor.label, record: descriptor.record };
};

// @approved
//  A Writer override is a complete record for one Variant. The record, and
//  the `expected` one it replaces, must pass the Box's record schema before
//  anything is written, so storage only ever holds decodable records, and the
//  Variant is checked to belong to this Conversation before anything lands.
export function setBoxRecord(db: ConversationDatabase, input: { conversationId: number; box: BoxId; messageId: number; variantId: number; record: BoxValue; expected: BoxValue }): void {
	const { descriptor, label, record } = requireRecord(db, input.conversationId, input.box);
	if (!fitsBoxSchema(record, input.record) || !(input.expected === null || fitsBoxSchema(record, input.expected))) {
		throw new InvalidConversationCommandError(`The ${label} record does not match its schema.`);
	}
	requireVariant(db, input.conversationId, input.messageId, input.variantId);
	const instance = requireBoxInstance(db, input.conversationId, input.box);
	if (!Value.Equal(effectiveRecord(readRecordSlots(db, input.box, record, instance, [input.variantId]).get(input.variantId)) ?? null, input.expected)) {
		throw new InvalidConversationCommandError("This record changed since you read it. Review it before changing it again.");
	}
	writeWriterRecord(db, descriptor, instance, input.variantId, input.record);
}

/** @approved Reset drops the override and leaves the automatic record, if any, in place. */
export function resetBoxRecord(db: ConversationDatabase, input: { conversationId: number; box: BoxId; messageId: number; variantId: number }): void {
	const { descriptor } = requireRecord(db, input.conversationId, input.box);
	requireVariant(db, input.conversationId, input.messageId, input.variantId);
	resetWriterRecord(db, descriptor, requireBoxInstance(db, input.conversationId, input.box), input.variantId);
}
