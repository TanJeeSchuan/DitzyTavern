import { conversationDataTable } from "../../database/schema";
import { boxSetupEntry } from "../../box/registry";
import type { ConversationDatabase } from "../internal";
import type { BoxId, BoxSetups } from "../../../shared/contract/box";

export function setBoxSetup(db: ConversationDatabase, input: { conversationId: number; box: BoxId; setup: BoxSetups[BoxId] }) {
	const entry = boxSetupEntry(input.box, input.setup);
	db.insert(conversationDataTable)
		.values({ conversation_id: input.conversationId, ...entry })
		.onConflictDoUpdate({ target: [conversationDataTable.conversation_id, conversationDataTable.namespace, conversationDataTable.key], set: { value: entry.value } })
		.run();
}
