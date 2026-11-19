import type { Database } from "bun:sqlite";
import { listChatSummaries } from "../conversation";

export const getWorkspace = (database: Database) => {
	const chats = listChatSummaries(database);

	return {
		activeChatId: chats[0]?.id ?? null,
		chats,
	};
};
