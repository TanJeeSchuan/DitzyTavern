import { and, eq, inArray } from "drizzle-orm";
import { boxReference, type BoxId, type BoxState } from "../../../shared/contract/box";
import { boxInstanceEntry, boxStateEntry } from "../../box/setup";
import { pinFirstBoxVersion } from "../../box/version-pin";
import { installBoxBlocks } from "../../prompt-preset";
import { conversationDataTable, participantDataTable, participantTable } from "../../database/schema";
import { participantValueAccepted, requireBox, type ConversationDatabase } from "../internal";
import type { ConversationWriteChange } from "../../../shared/contract/conversation-write-change";

// @approved
//  Inserts, disables or removes one Box in this Chat. Removing deletes the
// Box's Chat-scoped setup and data, its instance included; the Variant records
// and Message Moves already in the story stay, because history is immutable.
// Inserting a Box that is absent starts a new instance, and turning a Box on
// adds its block to the Chat's preset when the preset has none. A versioned
// Box's first insertion pins the version it runs at, `latest`; the pin
// outlives removal, so inserting it again runs the version the Chat's
// history was written with. While the Box is absent, Characters seed its
// Participant values unchecked, so inserting it drops each one the version
// it now runs doesn't declare or refuses, as the seed copy does for a Box
// present.
export function setBoxState(db: ConversationDatabase, input: { conversationId: number; box: BoxId; state: BoxState }): ConversationWriteChange | void {
	const { version, descriptor } = requireBox(db, input.conversationId, input.box);
	const namespace = boxReference(input.box);
	if (input.state === "absent") {
		db.delete(conversationDataTable).where(and(eq(conversationDataTable.conversation_id, input.conversationId), eq(conversationDataTable.namespace, namespace))).run();
		const participants = db.select({ id: participantTable.id }).from(participantTable).where(eq(participantTable.conversation_id, input.conversationId));
		db.delete(participantDataTable).where(and(eq(participantDataTable.namespace, namespace), inArray(participantDataTable.participant_id, participants))).run();
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
