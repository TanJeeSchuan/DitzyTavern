// Drizzle schema source of truth.
// Domain modules add tables here; run `bun run db:generate` to produce migrations.

import { sql } from "drizzle-orm";
import {
	int,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

// entity tables
export const chatTable = sqliteTable("chat", {
	id: int().primaryKey({ autoIncrement: true }),
	name: text().notNull(),
	creation_time: text().notNull(),
	last_message_time: text().notNull(),
	revision: int().notNull().default(0),
});

export const messageTable = sqliteTable(
	"messages",
	{
		id: int().primaryKey({ autoIncrement: true }),
		chat_id: int()
			.notNull()
			.references(() => chatTable.id, { onDelete: "cascade" }),
		position: int().notNull(),
		timestamp: text().notNull(),
	},
	(table) => [
		uniqueIndex("messages_chat_position_unique").on(
			table.chat_id,
			table.position,
		),
	],
);

export const messageVariantTable = sqliteTable(
	"message_variant",
	{
		id: int().primaryKey({ autoIncrement: true }),
		message_id: int()
			.notNull()
			.references(() => messageTable.id, { onDelete: "cascade" }),
		position: int().notNull(),
		content: text().notNull(),
		timestamp: text().notNull(),
		selected: int({ mode: "boolean" }).notNull().default(false),
	},
	(table) => [
		uniqueIndex("message_variant_message_position_unique").on(
			table.message_id,
			table.position,
		),
		uniqueIndex("message_variant_one_selected_per_message")
			.on(table.message_id)
			.where(sql`${table.selected} = 1`),
	],
);

// Character lifecycle base record. Definition content lives in the
// character_prompt and character_opening child tables, so a future
// tombstone can strip the Definition while retaining the referenced row.
export const characterTable = sqliteTable("character", {
	id: int().primaryKey({ autoIncrement: true }),
	name: text().notNull(),
	revision: int().notNull().default(0),
	pinned: int({ mode: "boolean" }).notNull().default(false),
	// Null while the Character is active; set when reduced to a tombstone.
	deleted_at: text(),
});

// One active Prompt row per Character with every typed Prompt field.
// Fields are required but may be empty; text is stored exactly as authored.
export const characterPromptTable = sqliteTable("character_prompt", {
	character_id: int()
		.primaryKey()
		.references(() => characterTable.id, { onDelete: "cascade" }),
	system_instruction: text().notNull(),
	identity: text().notNull(),
	scenario: text().notNull(),
	example_dialogue: text().notNull(),
	post_history_instruction: text().notNull(),
});

// Ordered, exact, nonblank Opening rows. Empty lists and duplicate
// contents are allowed; the (character, position) pair is unique.
export const characterOpeningTable = sqliteTable(
	"character_opening",
	{
		id: int().primaryKey({ autoIncrement: true }),
		character_id: int()
			.notNull()
			.references(() => characterTable.id, { onDelete: "cascade" }),
		position: int().notNull(),
		content: text().notNull(),
	},
	(table) => [
		uniqueIndex("character_opening_character_position_unique").on(
			table.character_id,
			table.position,
		),
	],
);

export const chatDataTable = sqliteTable(
	"chat_data",
	{
		id: int().primaryKey({ autoIncrement: true }),
		chat_id: int()
			.notNull()
			.references(() => chatTable.id, { onDelete: "cascade" }),
		namespace: text().notNull(),
		key: text().notNull(),
		value: text().notNull(),
	},
	(table) => [
		uniqueIndex("chat_data_owner_key_unique").on(
			table.chat_id,
			table.namespace,
			table.key,
		),
	],
);

export const messageDataTable = sqliteTable(
	"messages_data",
	{
		id: int().primaryKey({ autoIncrement: true }),
		message_id: int()
			.notNull()
			.references(() => messageTable.id, { onDelete: "cascade" }),
		namespace: text().notNull(),
		key: text().notNull(),
		value: text().notNull(),
	},
	(table) => [
		uniqueIndex("messages_data_owner_key_unique").on(
			table.message_id,
			table.namespace,
			table.key,
		),
	],
);

export const messageVariantDataTable = sqliteTable(
	"message_variant_data",
	{
		id: int().primaryKey({ autoIncrement: true }),
		message_variant_id: int()
			.notNull()
			.references(() => messageVariantTable.id, { onDelete: "cascade" }),
		namespace: text().notNull(),
		key: text().notNull(),
		value: text().notNull(),
	},
	(table) => [
		uniqueIndex("message_variant_data_owner_key_unique").on(
			table.message_variant_id,
			table.namespace,
			table.key,
		),
	],
);

// logical tables
export const chatCharacterTable = sqliteTable(
	"chat_character",
	{
		chat_id: int()
			.notNull()
			.references(() => chatTable.id, { onDelete: "cascade" }),
		character_id: int()
			.notNull()
			.references(() => characterTable.id, { onDelete: "cascade" }),
	},
	(table) => [primaryKey({ columns: [table.chat_id, table.character_id] })],
);
