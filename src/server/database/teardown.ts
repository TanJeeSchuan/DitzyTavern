// Test data teardown. Run with `bun run db:teardown`.
// Removes only rows matching the seed script's values, so user-created
// data is left untouched. Safe to run repeatedly.

import { and, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openDatabase } from "./database";
import { chatCharacterTable, characterTable, chatTable } from "./schema";
import { characters, chats } from "./seed";

export function teardown(databasePath?: string) {
  const database = openDatabase({ path: databasePath });
  const db = drizzle(database);
  const log = (message: string) => console.log(`[teardown] ${message}`);

  try {
    const characterNames = characters.map((character) => character.name);
    const seedChats = chats.map(({ characterIds, ...chat }) => chat);

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
      const membershipResult = db
        .delete(chatCharacterTable)
        .where(inArray(chatCharacterTable.chat_id, seededChatIds))
        .run();
      log(`removed ${membershipResult.changes} chat_character rows`);
    }

    const chatResult = db
      .delete(chatTable)
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
    log(`removed ${chatResult.changes} chat rows`);

    const characterResult = db
      .delete(characterTable)
      .where(inArray(characterTable.name, characterNames))
      .run();
    log(`removed ${characterResult.changes} character rows`);
  } finally {
    database.close();
  }
}

const isDirectRun = import.meta.main;
if (isDirectRun) {
  teardown();
}