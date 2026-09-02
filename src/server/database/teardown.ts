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

import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { promptChannelOrder } from "../../shared/definition";
import { readCharacterSnapshot } from "../character-library/snapshot";
import { openDatabase } from "./database";
import {
	characterOpeningTable,
	characterPromptTable,
	characterTable,
	conversationTable,
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
				eq(conversationTable.name, conversation.name),
				eq(conversationTable.creation_time, conversation.createdAt),
				eq(conversationTable.last_message_time, conversation.createdAt),
			),
		);
		const seededChatIds =
			seedChatMatches.length > 0
				? db
						.select({ id: conversationTable.id })
						.from(conversationTable)
						.where(or(...seedChatMatches))
						.all()
						.map((row) => row.id)
				: [];

		if (seededChatIds.length > 0) {
			db.delete(conversationTable)
				.where(inArray(conversationTable.id, seededChatIds))
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
				const snapshot = readCharacterSnapshot(db, candidate.id);
				if (
					snapshot !== undefined &&
					promptChannelOrder.every(
						(channel) => snapshot.prompt[channel] === character.prompt[channel],
					) &&
					snapshot.openings.length === character.openings.length &&
					snapshot.openings.every(
						(content, index) => content === character.openings[index],
					)
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
