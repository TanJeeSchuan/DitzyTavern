import type { DigestBoxId, WorldClockRecord } from "../../../shared/contract/box";
import { resetWriterRecord, writeWriterRecord } from "../../box/records";
import { readBoxInstances } from "../../box/setup";
import { InvalidConversationCommandError } from "../errors";
import type { ConversationDatabase } from "../internal";
import { requireVariant } from "../internal";

/** @approved A Writer override belongs to the Box instance present now; an absent Box takes none. */
const requireInstance = (db: ConversationDatabase, conversationId: number, box: DigestBoxId): string => {
	const instance = readBoxInstances(db, conversationId)[box];
	if (instance === undefined) throw new InvalidConversationCommandError(`The ${box} Box is not in this Chat.`);
	return instance;
};

// @approved
//  A Writer override is a complete record for one Variant. The command route
//  validates it against the Box's record schema before the handler runs, so
//  storage only ever holds decodable records, and the Variant is checked to
//  belong to this Conversation before anything lands.
export function setBoxRecord(db: ConversationDatabase, input: { conversationId: number; box: DigestBoxId; messageId: number; variantId: number; record: WorldClockRecord }): void {
	requireVariant(db, input.conversationId, input.messageId, input.variantId);
	writeWriterRecord(db, input.box, requireInstance(db, input.conversationId, input.box), input.variantId, input.record);
}

/** @approved Reset drops the override and leaves the automatic record, if any, in place. */
export function resetBoxRecord(db: ConversationDatabase, input: { conversationId: number; box: DigestBoxId; messageId: number; variantId: number }): void {
	requireVariant(db, input.conversationId, input.messageId, input.variantId);
	resetWriterRecord(db, input.box, requireInstance(db, input.conversationId, input.box), input.variantId);
}
