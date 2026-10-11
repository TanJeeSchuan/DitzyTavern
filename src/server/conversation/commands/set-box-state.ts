import { and, eq, inArray } from "drizzle-orm";
import { boxReference, type BoxId, type BoxState } from "../../../shared/contract/box";
import { boxInstanceEntry, boxStateEntry } from "../../box/setup";
import { conversationDataTable, participantDataTable, participantTable } from "../../database/schema";
import type { ConversationDatabase } from "../internal";
import type { ConversationMemoryChange } from "../../../shared/contract/conversation-memory-change";

// @approved
//  Inserts, disables or removes one Box in this Chat. Removing deletes the
// Box's Chat-scoped setup and data, its instance included; the Variant
// records and Message Moves already in the story stay, because history is
// immutable. Inserting a Box that is absent starts a new instance.
export function setBoxState(db: ConversationDatabase, input: { conversationId: number; box: BoxId; state: BoxState }): ConversationMemoryChange | void {
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
		db.insert(conversationDataTable).values({ conversation_id: input.conversationId, ...boxInstanceEntry(input.box) }).onConflictDoNothing().run();
	}
	if (input.state !== "enabled") return { conversationId: input.conversationId, touchedVariantIds: [], removedVariantIds: [], stoppedBox: { id: input.box, removed: input.state === "absent" } };
}
