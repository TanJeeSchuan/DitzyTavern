// ==[HUMAN APPROVED]== Test data teardown. Run with `bun run db:teardown`.
// Removes only rows matching the seed script's values, so user-created
// data is left untouched. Safe to run repeatedly.
//
// Seeded Conversations are identified by their exact seed name and derived
// Chat times, never by table-wide deletes; Participant, Prompt, Opening,
// Control, and Message rows go with them through cascade deletes. Seeded
// Characters are matched on their complete seed Definition (name, exact
// Prompt fields, and ordered Opening contents) after every referencing
// Conversation is gone.

import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openDatabase } from "./database";
import {
	characterOpeningTable,
	characterPromptTable,
	characterTable,
	chatTable,
} from "./schema";
import { characters, conversations } from "./seed";

export function teardown(databasePath?: string) {
	const database = openDatabase({ path: databasePath });
	const db = drizzle(database);
	const log = (message: string) => console.log(`[teardown] ${message}`);

	try {
		// ==[HUMAN APPROVED]== Seeded native Conversations carry both Chat times equal to the seed
		// base time: the greeting is their only history and carries no other
		// timestamps.
		const seedChatMatches = conversations.map((conversation) =>
			and(
				eq(chatTable.name, conversation.name),
				eq(chatTable.creation_time, conversation.createdAt),
				eq(chatTable.last_message_time, conversation.createdAt),
			),
		);
		const seededChatIds =
			seedChatMatches.length > 0
				? db
						.select({ id: chatTable.id })
						.from(chatTable)
						.where(or(...seedChatMatches))
						.all()
						.map((row) => row.id)
				: [];

		if (seededChatIds.length > 0) {
			db.delete(chatTable)
				.where(inArray(chatTable.id, seededChatIds))
				.run();
		}
		log(`removed ${seededChatIds.length} conversation rows with their Casts and history`);

		// ==[HUMAN APPROVED]== Match seeded Characters on their complete seed Definition.
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
