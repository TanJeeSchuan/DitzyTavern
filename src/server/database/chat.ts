import type { Database } from "bun:sqlite";
import { desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { withDatabase } from "./database";
import { chatCharacterTable, chatTable } from "./schema";

export const listChatSummaries = (database?: Database) =>
	withDatabase(database, (connection) => {
		const db = drizzle(connection);

		const chats = db
			.select()
			.from(chatTable)
			.orderBy(desc(chatTable.last_message_time))
			.all();
		const memberships = db.select().from(chatCharacterTable).all();
		const characterIdsByChat = new Map<number, number[]>();

		for (const membership of memberships) {
			const characterIds = characterIdsByChat.get(membership.chat_id) ?? [];
			characterIds.push(membership.character_id);
			characterIdsByChat.set(membership.chat_id, characterIds);
		}

		return chats.map((chat) => ({
			id: chat.id,
			name: chat.name,
			creationTime: chat.creation_time,
			lastMessageTime: chat.last_message_time,
			characterIds: characterIdsByChat.get(chat.id) ?? [],
		}));
	});
