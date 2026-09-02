import type { Database } from "bun:sqlite";
import { desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { withDatabase } from "./database";
import { conversationTable } from "./schema";

export const listChatSummaries = (database?: Database) =>
	withDatabase(database, (connection) => {
		const db = drizzle(connection);

		const chats = db
			.select()
			.from(conversationTable)
			.orderBy(desc(conversationTable.last_message_time))
			.all();

		return chats.map((chat) => ({
			id: chat.id,
			name: chat.name,
			creationTime: chat.creation_time,
			lastMessageTime: chat.last_message_time,
		}));
	});
