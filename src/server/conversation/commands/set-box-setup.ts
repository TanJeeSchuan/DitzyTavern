import { conversationDataTable } from "../../database/schema";
import { boxSetupEntry } from "../../box/setup";
import type { ConversationDatabase } from "../internal";
import type { BoxSetups } from "../../../shared/contract/box";

export function setBoxSetup(db: ConversationDatabase, input: { conversationId: number; box: keyof BoxSetups; setup: BoxSetups[keyof BoxSetups] }) {
	const entry = boxSetupEntry(input.box, input.setup);
	db.insert(conversationDataTable)
		.values({ conversation_id: input.conversationId, ...entry })
		.onConflictDoUpdate({ target: [conversationDataTable.conversation_id, conversationDataTable.namespace, conversationDataTable.key], set: { value: entry.value } })
		.run();
}
