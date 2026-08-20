import type { Database } from "bun:sqlite";
import { getCharacters } from "./character";
import { listChatSummaries } from "./chat";
import { withDatabase } from "./database";

export const getWorkspace = (database?: Database) =>
	withDatabase(database, (connection) => {
		const chats = listChatSummaries(connection);

		return {
			activeChatId: chats[0]?.id ?? null,
			chats,
			characters: getCharacters(connection),
		};
	});
