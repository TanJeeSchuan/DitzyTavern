import type { Database } from "bun:sqlite";
import { createCharacterLibraryModule } from "../character-library";
import { listChatSummaries } from "./chat";

export const getWorkspace = (database: Database) => {
	const chats = listChatSummaries(database);

	return {
		activeChatId: chats[0]?.id ?? null,
		chats,
		characters: createCharacterLibraryModule(database).list().map((character) => ({
				id: character.id,
				name: character.name,
			})),
	};
};
