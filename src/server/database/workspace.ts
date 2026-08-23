import type { Database } from "bun:sqlite";
import { withCharacterLibrary } from "../character-library";
import { listChatSummaries } from "./chat";
import { withDatabase } from "./database";

export const getWorkspace = (database?: Database) =>
	withDatabase(database, (connection) => {
		const chats = listChatSummaries(connection);

		return {
			activeChatId: chats[0]?.id ?? null,
			chats,
			characters: withCharacterLibrary(connection, (library) =>
				library.list().map((character) => ({
					id: character.id,
					name: character.name,
				})),
			),
		};
	});
