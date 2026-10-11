import { conversationDataTable } from "../../database/schema";
import { boxSetupEntry, readBoxSetups } from "../../box/setup";
import { serverBox } from "../../box/registry";
import type { ConversationDatabase } from "../internal";
import { InvalidConversationCommandError } from "../errors";
import type { BoxSetups, SetupBoxId } from "../../../shared/contract/box";

type BoxSetupCommand = { [Id in SetupBoxId]: { readonly box: Id; readonly setup: BoxSetups[Id] } }[SetupBoxId];

export function setBoxSetup(db: ConversationDatabase, input: { conversationId: number } & BoxSetupCommand) {
	const { setupError } = serverBox(input.box);
	const error = setupError?.(input.setup, readBoxSetups(db, input.conversationId)[input.box]);
	if (error !== undefined) throw new InvalidConversationCommandError(error);
	const entry = boxSetupEntry(input.box, input.setup);
	db.insert(conversationDataTable)
		.values({ conversation_id: input.conversationId, ...entry })
		.onConflictDoUpdate({ target: [conversationDataTable.conversation_id, conversationDataTable.namespace, conversationDataTable.key], set: { value: entry.value } })
		.run();
}
