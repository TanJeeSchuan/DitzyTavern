// Drizzle schema source of truth.
// Domain modules add tables here; run `bun run db:generate` to produce migrations.

import { int, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// entity tables
export const chatTable = sqliteTable("chat", {
	id: int().primaryKey({ autoIncrement: true }),
	name: text().notNull(),
	creation_time: text().notNull(),
	last_message_time: text().notNull(),
});

export const characterTable = sqliteTable("character", {
	id: int().primaryKey({ autoIncrement: true }),
	name: text().notNull(),
	// prompt fields for character
});

// logical tables
export const chatCharacterTable = sqliteTable(
	"chat_character",
	{
		chat_id: int().notNull(),
		character_id: int().notNull(),
	},
	(table) => [primaryKey({ columns: [table.chat_id, table.character_id] })],
);
