// Test data generator. Run with `bun run db:seed`.
// Idempotent: does nothing if the tables already contain rows.

import { drizzle } from "drizzle-orm/bun-sqlite";
import { chatCharacterTable, characterTable, chatTable } from "./schema";
import { openDatabase } from "./database";

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
    characterIds: [1, 2, 3],
  },
  {
    name: "Salt and Ember",
    creation_time: "2026-07-19T18:30:00.000Z",
    last_message_time: "2026-08-18T09:12:00.000Z",
    characterIds: [4, 5],
  },
  {
    name: "The Cartographer's Daughter",
    creation_time: "2026-08-01T12:00:00.000Z",
    last_message_time: "2026-08-15T23:47:00.000Z",
    characterIds: [2, 5, 6],
  },
  {
    name: "Night Shift at the Observatory",
    creation_time: "2026-08-10T20:20:00.000Z",
    last_message_time: "2026-08-18T14:55:00.000Z",
    characterIds: [1, 6],
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

    db.insert(characterTable)
      .values(characters)
      .all();

    db.insert(chatTable)
      .values(chats.map(({ characterIds, ...chat }) => chat))
      .all();

    const memberships = chats.flatMap((chat, index) =>
      chat.characterIds.map((characterId) => ({
        chat_id: index + 1,
        character_id: characterId,
      })),
    );
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