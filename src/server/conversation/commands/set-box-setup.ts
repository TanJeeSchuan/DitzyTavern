import { conversationDataTable } from "../../database/schema";
import { boxSetupEntry } from "../../box/setup";
import type { ConversationDatabase } from "../internal";
import { InvalidConversationCommandError } from "../errors";
import { isWorldClockStart, type BoxSetups } from "../../../shared/contract/box";

type BoxSetupCommand = { [Id in keyof BoxSetups]: { readonly box: Id; readonly setup: BoxSetups[Id] } }[keyof BoxSetups];

export function setBoxSetup(db: ConversationDatabase, input: { conversationId: number } & BoxSetupCommand) {
	if (input.box === "world-clock" && !isWorldClockStart(input.setup.start)) {
		throw new InvalidConversationCommandError("Enter a real calendar date and time, such as 2025-06-01T08:00.");
	}
	const entry = boxSetupEntry(input.box, input.setup);
	db.insert(conversationDataTable)
		.values({ conversation_id: input.conversationId, ...entry })
		.onConflictDoUpdate({ target: [conversationDataTable.conversation_id, conversationDataTable.namespace, conversationDataTable.key], set: { value: entry.value } })
		.run();
}
