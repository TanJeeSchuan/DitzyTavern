// Test data teardown. Run with `bun run db:teardown`.
// Removes only rows matching the seed script's values, so user-created
// data is left untouched. Safe to run repeatedly.
//
// Seeded Characters are identified by their full seed Definition (name,
// exact Prompt fields, and ordered Opening contents), never by table-wide
// deletes. Dependent rows are removed before their parents.

import {
	and,
	asc,
	eq,
	inArray,
	isNull,
	or,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openDatabase } from "./database";
import {
	characterOpeningTable,
	characterPromptTable,
	characterTable,
	chatCharacterTable,
	chatTable,
} from "./schema";
import { characters, chats } from "./seed";

export function teardown(databasePath?: string) {
	const database = openDatabase({ path: databasePath });
	const db = drizzle(database);
	const log = (message: string) => console.log(`[teardown] ${message}`);

	try {
		const seedChats = chats.map(
			({ characterNames: _characterNames, ...chat }) => chat,
		);

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

		// Match seeded Characters on their complete seed Definition.
		let removedCharacters = 0;
		for (const character of characters) {
			const candidates = db
				.select({ id: characterTable.id })
				.from(characterTable)
				.where(
					and(eq(characterTable.name, character.name), isNull(characterTable.deleted_at)),
				)
				.all();

			const matchingIds: number[] = [];
			for (const candidate of candidates) {
				const prompt = db
					.select({
						systemInstruction: characterPromptTable.system_instruction,
						identity: characterPromptTable.identity,
						scenario: characterPromptTable.scenario,
						exampleDialogue: characterPromptTable.example_dialogue,
						postHistoryInstruction: characterPromptTable.post_history_instruction,
					})
					.from(characterPromptTable)
					.where(eq(characterPromptTable.character_id, candidate.id))
					.get();
				const openings = db
					.select({ content: characterOpeningTable.content })
					.from(characterOpeningTable)
					.where(eq(characterOpeningTable.character_id, candidate.id))
					.orderBy(asc(characterOpeningTable.position))
					.all()
					.map((row) => row.content);

				if (
					prompt !== undefined &&
					prompt.systemInstruction === character.prompt.systemInstruction &&
					prompt.identity === character.prompt.identity &&
					prompt.scenario === character.prompt.scenario &&
					prompt.exampleDialogue === character.prompt.exampleDialogue &&
					prompt.postHistoryInstruction ===
						character.prompt.postHistoryInstruction &&
					JSON.stringify(openings) === JSON.stringify(character.openings)
				) {
					matchingIds.push(candidate.id);
				}
			}

			if (matchingIds.length > 0) {
				db.delete(characterOpeningTable)
					.where(inArray(characterOpeningTable.character_id, matchingIds))
					.run();
				db.delete(characterPromptTable)
					.where(inArray(characterPromptTable.character_id, matchingIds))
					.run();
				db.delete(characterTable)
					.where(inArray(characterTable.id, matchingIds))
					.run();
				removedCharacters += matchingIds.length;
			}
		}
		log(`removed ${removedCharacters} character rows with their Definition children`);
	} finally {
		database.close();
	}
}

const isDirectRun = import.meta.main;
if (isDirectRun) {
	teardown();
}
