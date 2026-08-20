// Test data generator. Run with `bun run db:seed`.
// Idempotent: does nothing if the tables already contain rows.

import { drizzle } from "drizzle-orm/bun-sqlite";
import { openDatabase } from "./database";
import { characterTable, chatCharacterTable, chatTable } from "./schema";

export const characters = [
	{ name: "Maren Voss" },
	{ name: "Juno Ashfeld" },
	{ name: "Theodora Kline" },
	{ name: "Silas Mercer" },
	{ name: "Isolde Fairfax" },
	{ name: "Bram Okafor" },
];

export const chats = [
	{
		name: "The Lantern House",
		creation_time: "2026-07-02T10:15:00.000Z",
		last_message_time: "2026-08-17T21:04:00.000Z",
		characterNames: ["Maren Voss", "Juno Ashfeld", "Theodora Kline"],
	},
	{
		name: "Salt and Ember",
		creation_time: "2026-07-19T18:30:00.000Z",
		last_message_time: "2026-08-18T09:12:00.000Z",
		characterNames: ["Silas Mercer", "Isolde Fairfax"],
	},
	{
		name: "The Cartographer's Daughter",
		creation_time: "2026-08-01T12:00:00.000Z",
		last_message_time: "2026-08-15T23:47:00.000Z",
		characterNames: ["Juno Ashfeld", "Isolde Fairfax", "Bram Okafor"],
	},
	{
		name: "Night Shift at the Observatory",
		creation_time: "2026-08-10T20:20:00.000Z",
		last_message_time: "2026-08-18T14:55:00.000Z",
		characterNames: ["Maren Voss", "Bram Okafor"],
	},
];

export function seed(databasePath?: string) {
	const database = openDatabase({ path: databasePath });
	const db = drizzle(database);
	const log = (message: string) => console.log(`[seed] ${message}`);

	try {
		const existing = db.select().from(characterTable).limit(1).all();
		if (existing.length > 0) {
			log("database already contains data; skipping seed");
			return;
		}

		const insertedCharacters = db
			.insert(characterTable)
			.values(characters)
			.returning({ id: characterTable.id, name: characterTable.name })
			.all();
		const characterIdByName = new Map(
			insertedCharacters.map((character) => [character.name, character.id]),
		);

		const insertedChats = db
			.insert(chatTable)
			.values(chats.map(({ characterNames: _characterNames, ...chat }) => chat))
			.returning({ id: chatTable.id, name: chatTable.name })
			.all();
		const chatIdByName = new Map(insertedChats.map((chat) => [chat.name, chat.id]));

		const memberships = chats.flatMap((chat) => {
			const chatId = chatIdByName.get(chat.name);
			if (!chatId) {
				throw new Error(`Missing inserted Chat: ${chat.name}`);
			}

			return chat.characterNames.map((characterName) => {
				const characterId = characterIdByName.get(characterName);
				if (!characterId) {
					throw new Error(`Missing inserted Character: ${characterName}`);
				}

				return { chat_id: chatId, character_id: characterId };
			});
		});
		db.insert(chatCharacterTable).values(memberships).all();

		log(
			`inserted ${characters.length} characters, ${chats.length} chats, ${memberships.length} chat_character rows`,
		);
	} finally {
		database.close();
	}
}

const isDirectRun = import.meta.main;
if (isDirectRun) {
	seed();
}
