import { and, eq, inArray, like } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";
import { boxRecords } from "../../../shared/contract/box-generation";
import { boxReference, type BoxId, type BoxState } from "../../../shared/contract/box";
import { boxInstanceEntry, boxStateEntry } from "../../box/setup";
import { BOX_VERSION_NAMESPACE, pinFirstBoxVersion } from "../../box/version-pin";
import { installBoxBlocks } from "../../prompt-preset";
import { activeGenerationTable, conversationDataTable, messageDataTable, messageTable, messageVariantDataTable, messageVariantTable, participantDataTable, participantTable } from "../../database/schema";
import { participantValueAccepted, requireBox, type ConversationDatabase } from "../internal";
import type { ConversationWriteChange } from "../../../shared/contract/conversation-write-change";

// @approved
//  Removing clears this Chat's lifecycle and Participant values. With
// deleteHistory it also clears every instance's records, Moves and pin,
// including pending records so a settling Generation cannot restore them.
// Inserting an absent Box starts a new instance and pins latest if unpinned.
export function setBoxState(db: ConversationDatabase, input: { conversationId: number; box: BoxId; state: BoxState; deleteHistory?: boolean }): ConversationWriteChange | void {
	const { version, descriptor } = requireBox(db, input.conversationId, input.box);
	const namespace = boxReference(input.box);
	if (input.state === "absent") {
		db.delete(conversationDataTable).where(and(eq(conversationDataTable.conversation_id, input.conversationId), eq(conversationDataTable.namespace, namespace))).run();
		const participants = db.select({ id: participantTable.id }).from(participantTable).where(eq(participantTable.conversation_id, input.conversationId));
		db.delete(participantDataTable).where(and(eq(participantDataTable.namespace, namespace), inArray(participantDataTable.participant_id, participants))).run();
		if (input.deleteHistory) {
			const messages = db.select({ id: messageTable.id }).from(messageTable).where(eq(messageTable.conversation_id, input.conversationId));
			const variants = db.select({ id: messageVariantTable.id }).from(messageVariantTable).where(inArray(messageVariantTable.message_id, messages));
			db.delete(messageVariantDataTable).where(and(inArray(messageVariantDataTable.message_variant_id, variants), eq(messageVariantDataTable.namespace, namespace), like(messageVariantDataTable.key, "record:%"))).run();
			db.delete(messageDataTable).where(and(inArray(messageDataTable.message_id, messages), eq(messageDataTable.namespace, namespace), eq(messageDataTable.key, "moves"))).run();
			db.delete(conversationDataTable).where(and(eq(conversationDataTable.conversation_id, input.conversationId), eq(conversationDataTable.namespace, BOX_VERSION_NAMESPACE), eq(conversationDataTable.key, input.box))).run();
			const pending = db.select({ id: activeGenerationTable.id, records: activeGenerationTable.box_records_json }).from(activeGenerationTable).where(eq(activeGenerationTable.conversation_id, input.conversationId)).all();
			for (const row of pending) {
				const records = Value.Parse(boxRecords, JSON.parse(row.records));
				delete records[input.box];
				db.update(activeGenerationTable).set({ box_records_json: JSON.stringify(records) }).where(eq(activeGenerationTable.id, row.id)).run();
			}
		}
	} else {
		const entry = boxStateEntry(input.box, input.state === "enabled");
		db.insert(conversationDataTable)
			.values({ conversation_id: input.conversationId, ...entry })
			.onConflictDoUpdate({ target: [conversationDataTable.conversation_id, conversationDataTable.namespace, conversationDataTable.key], set: { value: entry.value } })
			.run();
		const inserted = db.insert(conversationDataTable).values({ conversation_id: input.conversationId, ...boxInstanceEntry(input.box) }).onConflictDoNothing().returning({ id: conversationDataTable.id }).all().length > 0;
		if (version !== undefined) pinFirstBoxVersion(db, input.conversationId, input.box, version);
		if (inserted) {
			const participants = db.select({ id: participantTable.id }).from(participantTable).where(eq(participantTable.conversation_id, input.conversationId));
			const refused = db.select({ id: participantDataTable.id, key: participantDataTable.key, value: participantDataTable.value }).from(participantDataTable)
				.where(and(eq(participantDataTable.namespace, namespace), inArray(participantDataTable.participant_id, participants))).all()
				.filter(({ key, value }) => !participantValueAccepted(descriptor, key, value)).map(({ id }) => id);
			if (refused.length > 0) db.delete(participantDataTable).where(inArray(participantDataTable.id, refused)).run();
		}
		if (input.state === "enabled") installBoxBlocks(db, input.conversationId, [input.box]);
	}
	if (input.state !== "enabled") return { conversationId: input.conversationId, touchedVariantIds: [], removedVariantIds: [], stoppedBox: input.box };
}
