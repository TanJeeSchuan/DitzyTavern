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

export const characterTable = sqliteTable("character", {
	id: int().primaryKey({ autoIncrement: true }),
	name: text().notNull(),
	// prompt fields for character
});

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
