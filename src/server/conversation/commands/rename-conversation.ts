import { eq } from "drizzle-orm";
import { conversationTable } from "../../database/schema";
import { InvalidConversationCommandError } from "../errors";
import type { ConversationDatabase } from "../internal";

export function renameConversation(
	db: ConversationDatabase,
	input: { conversationId: number; name: string },
) {
	const name = input.name.trim();
	if (name === "") throw new InvalidConversationCommandError("A Chat name is required.");
	db.update(conversationTable).set({ name }).where(eq(conversationTable.id, input.conversationId)).run();
}
