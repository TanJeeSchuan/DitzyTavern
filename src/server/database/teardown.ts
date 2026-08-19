// Test data teardown. Run with `bun run db:teardown`.
// Removes only rows matching the seed script's values, so user-created
// data is left untouched. Safe to run repeatedly.

import { and, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openDatabase } from "./database";
import { characterTable, chatCharacterTable, chatTable } from "./schema";
import { characters, chats } from "./seed";

export function teardown(databasePath?: string) {
	const database = openDatabase({ path: databasePath });
	const db = drizzle(database);
	const log = (message: string) => console.log(`[teardown] ${message}`);

	try {
		const characterNames = characters.map((character) => character.name);
		const seedChats = chats.map(({ characterIds: _characterIds, ...chat }) => chat);

		const seededChatIds = db
			.select({ id: chatTable.id })
			.from(chatTable)
			.where(
				or(
					...seedChats.map((chat) =>
						and(
							eq(chatTable.name, chat.name),
							eq(chatTable.creation_time, chat.creation_time),
							eq(chatTable.last_message_time, chat.last_message_time),
						),
					),
				),
			)
			.all()
			.map((row) => row.id);

		if (seededChatIds.length > 0) {
			const membershipCount = db
				.select({
					chat_id: chatCharacterTable.chat_id,
					character_id: chatCharacterTable.character_id,
				})
				.from(chatCharacterTable)
				.where(inArray(chatCharacterTable.chat_id, seededChatIds))
				.all().length;

			db.delete(chatCharacterTable)
				.where(inArray(chatCharacterTable.chat_id, seededChatIds))
				.run();
			log(`removed ${membershipCount} chat_character rows`);
		}

		db.delete(chatTable)
			.where(
				or(
					...seedChats.map((chat) =>
						and(
							eq(chatTable.name, chat.name),
							eq(chatTable.creation_time, chat.creation_time),
							eq(chatTable.last_message_time, chat.last_message_time),
						),
					),
				),
			)
			.run();
		log(`removed ${seededChatIds.length} chat rows`);

		const characterCount = db
			.select({ id: characterTable.id })
			.from(characterTable)
			.where(inArray(characterTable.name, characterNames))
			.all().length;
		db.delete(characterTable)
			.where(inArray(characterTable.name, characterNames))
			.run();
		log(`removed ${characterCount} character rows`);
	} finally {
		database.close();
	}
}

const isDirectRun = import.meta.main;
if (isDirectRun) {
	teardown();
}
