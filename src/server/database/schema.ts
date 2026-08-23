// Drizzle schema source of truth.
// Domain modules add tables here; run `bun run db:generate` to produce migrations.

import { sql } from "drizzle-orm";
import {
	check,
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
		// Immutable Author Stamp: the authoring Cast Participant and the name
		// captured when the Message was created. Null only for preservation
		// records whose authors are not yet resolved into Participants.
		author_participant_id: int().references(() => participantTable.id),
		author_name: text(),
		// Historical Control context: the human/model pair active when native
		// generation (including initial openings) began. Set together or not
		// at all; imported history is never retrofitted with a pair.
		context_human_participant_id: int().references(() => participantTable.id),
		context_model_participant_id: int().references(() => participantTable.id),
	},
	(table) => [
		uniqueIndex("messages_chat_position_unique").on(
			table.chat_id,
			table.position,
		),
		check(
			"messages_context_pair_together",
			sql`(context_human_participant_id IS NULL) = (context_model_participant_id IS NULL)`,
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

// Conversation-local identity. Each Participant owns an independent copied
// Definition (participant_prompt and participant_opening children) and keeps
// immutable provenance pointing at the Character it forked, if any. The
// source reference is a plain structural reference without revision tracking
// or synchronization; deleting the source row is blocked while referenced.
//
// Removed Participants keep this base row only when a Message still refers
// to them (Author Stamp or historical Control pair): the base is reduced to
// a nonrestorable tombstone holding stable identity, final name,
// Conversation identity, and Character provenance, with the Definition
// children stripped and the row excluded from the Cast. Such tombstones are
// garbage-collected by the Conversation domain once their final retained
// reference disappears.
export const participantTable = sqliteTable(
	"participant",
	{
		id: int().primaryKey({ autoIncrement: true }),
		chat_id: int()
			.notNull()
			.references(() => chatTable.id, { onDelete: "cascade" }),
		// The Participant's own normalized nonblank name, independent of the
		// source Character and of every other Cast member. For a tombstone
		// this is the final name captured at removal.
		name: text().notNull(),
		// Explicit, stable Cast position. Contiguity is maintained by the
		// Conversation domain; uniqueness is enforced structurally on active
		// Participants. Tombstones are not in the Cast and carry no position:
		// removal writes the sentinel 0 (never used by active members, which
		// start at 1), and the partial unique index below excludes tombstoned
		// rows so the sentinel never collides.
		position: int().notNull(),
		source_character_id: int().references(() => characterTable.id),
		// Null while the Participant is active in the Cast; set when reduced
		// to a tombstone that only satisfies structural Message references.
		deleted_at: text(),
	},
	(table) => [
		uniqueIndex("participant_chat_position_unique")
			.on(table.chat_id, table.position)
			.where(sql`${table.deleted_at} IS NULL`),
	],
);

// One active Prompt row per Participant with every typed Prompt field,
// stored exactly as authored. Removed with the Participant when its copy is
// deleted; never shared with the source Character.
export const participantPromptTable = sqliteTable("participant_prompt", {
	participant_id: int()
		.primaryKey()
		.references(() => participantTable.id, { onDelete: "cascade" }),
	system_instruction: text().notNull(),
	identity: text().notNull(),
	scenario: text().notNull(),
	example_dialogue: text().notNull(),
	post_history_instruction: text().notNull(),
});

// Ordered, exact, nonblank Opening rows owned by the Participant.
export const participantOpeningTable = sqliteTable(
	"participant_opening",
	{
		id: int().primaryKey({ autoIncrement: true }),
		participant_id: int()
			.notNull()
			.references(() => participantTable.id, { onDelete: "cascade" }),
		position: int().notNull(),
		content: text().notNull(),
	},
	(table) => [
		uniqueIndex("participant_opening_participant_position_unique").on(
			table.participant_id,
			table.position,
		),
	],
);

// Control assignment: at most one human and one model seat per Conversation,
// each held by a distinct Cast Participant of the same Conversation. The
// primary key bounds each seat to one row, and the unique Participant
// reference makes the two seats structurally distinct.
export const conversationControlTable = sqliteTable(
	"conversation_control",
	{
		chat_id: int()
			.notNull()
			.references(() => chatTable.id, { onDelete: "cascade" }),
		seat: text().notNull(),
		participant_id: int()
			.notNull()
			.references(() => participantTable.id, { onDelete: "cascade" }),
	},
	(table) => [
		primaryKey({ columns: [table.chat_id, table.seat] }),
		uniqueIndex("conversation_control_participant_unique").on(
			table.participant_id,
		),
		check(
			"conversation_control_seat_check",
			sql`${table.seat} IN ('human', 'model')`,
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

// logical tables end here.

