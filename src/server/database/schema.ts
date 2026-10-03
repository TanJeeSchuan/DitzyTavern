// ==[HUMAN APPROVED]== Drizzle schema source of truth.
// Domain modules add tables here; run `bun run db:generate` to produce migrations.

import { sql } from "drizzle-orm";
import {
	blob,
	check,
	index,
	int,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
	DEFAULT_CONTINUATION_STRATEGY,
	DEFAULT_SIBLING_GENERATION_LIMIT,
} from "../conversation/generation-defaults";
import type { Portrait } from "../../shared/contract/image";
import type { PromptChannels } from "../../shared/contract/prompt-schema";

export const imageTable = sqliteTable("image", {
	hash: text().primaryKey(),
	bytes: blob({ mode: "buffer" }).notNull(),
	media_type: text().notNull(),
	byte_size: int().notNull(),
	width: int().notNull(),
	height: int().notNull(),
});

function portraitColumns() {
	return {
		portrait_hash: text(),
		portrait_focal_x: real(),
		portrait_focal_y: real(),
	};
}

export interface PortraitColumnRow {
	portrait_hash: string | null;
	portrait_focal_x: number | null;
	portrait_focal_y: number | null;
}

export const toPortraitColumns = (portrait: Portrait | undefined): PortraitColumnRow => ({
	portrait_hash: portrait?.hash ?? null,
	portrait_focal_x: portrait?.focalX ?? null,
	portrait_focal_y: portrait?.focalY ?? null,
});

export const fromPortraitColumns = (row: PortraitColumnRow | undefined): Portrait | undefined =>
	row?.portrait_hash == null || row.portrait_focal_x === null || row.portrait_focal_y === null
		? undefined
		: { hash: row.portrait_hash, focalX: row.portrait_focal_x, focalY: row.portrait_focal_y };

// ==[HUMAN APPROVED]== The shared Prompt Preset library. A preset is an ordered assembly recipe
// only: Generation Settings and text-processing scripts are deliberately not
// part of it. Exactly one row is the Default preset, which every Conversation
// selects until it selects another.
export const promptPresetTable = sqliteTable(
	"prompt_preset",
	{
		id: int().primaryKey({ autoIncrement: true }),
		name: text().notNull(),
		is_default: int({ mode: "boolean" }).notNull().default(false),
		// ==[HUMAN APPROVED]== Optimistic-concurrency revision following the Character
		// Library convention: every authoritative library command carries the
		// revision the caller saw, so a stale rename or deletion cannot
		// silently act on state the caller never confirmed.
		revision: int().notNull().default(0),
	},
	(table) => [
		uniqueIndex("prompt_preset_single_default")
			.on(table.is_default)
			.where(sql`${table.is_default} = 1`),
	],
);

// ==[HUMAN APPROVED]== One ordered slot of a recipe. Enablement is stored on the slot so a
// disabled slot keeps its place in the order rather than leaving it. The
// outgoing role is stored per occurrence so deliberate duplicates can be
// presented differently; history rows keep it null because their entries
// carry the roles of their own Messages.
export const promptPresetBlockTable = sqliteTable(
	"prompt_preset_block",
	{
		id: int().primaryKey({ autoIncrement: true }),
		preset_id: int()
			.notNull()
			.references(() => promptPresetTable.id, { onDelete: "cascade" }),
		position: int().notNull(),
		reference: text().notNull(),
		enabled: int({ mode: "boolean" }).notNull().default(true),
		role: text({ enum: ["system", "user", "assistant"] }),
		// ==[HUMAN APPROVED]== The authored instruction block's own metadata and text. Null on
		// every referenced occurrence: the preset stores references, never
		// rendered Participant or history content.
		name: text(),
		content: text(),
	},
	(table) => [
		uniqueIndex("prompt_preset_block_position_unique").on(
			table.preset_id,
			table.position,
		),
		uniqueIndex("prompt_preset_single_lore_block")
			.on(table.preset_id)
			.where(sql`${table.reference} = 'lore'`),
		uniqueIndex("prompt_preset_single_memory_block")
			.on(table.preset_id)
			.where(sql`${table.reference} = 'memory'`),
		check(
			"prompt_preset_block_shape_check",
			sql`(
				${table.reference} = 'history'
				AND ${table.role} IS NULL
				AND ${table.name} IS NULL
				AND ${table.content} IS NULL
			) OR (
				${table.reference} = 'instruction'
				AND ${table.role} IS NOT NULL
				AND ${table.role} IN ('system', 'user', 'assistant')
				AND ${table.name} IS NOT NULL
				AND ${table.content} IS NOT NULL
			) OR (
				${table.reference} IN (
					'model-system-instruction',
					'human-identity',
					'model-identity',
					'model-scenario',
					'model-example-dialogue',
					'model-post-history-instruction'
				)
				AND ${table.role} IS NOT NULL
				AND ${table.role} IN ('system', 'user', 'assistant')
				AND ${table.name} IS NULL
				AND ${table.content} IS NULL
			) OR (
				${table.reference} = 'lore'
				AND ${table.role} IS NOT NULL
				AND ${table.role} IN ('system', 'user', 'assistant')
				AND ${table.name} IS NULL
				AND ${table.content} IS NULL
			) OR (
				${table.reference} = 'memory'
				AND ${table.role} IS NOT NULL
				AND ${table.role} IN ('system', 'user', 'assistant')
				AND ${table.name} IS NULL
				AND ${table.content} IS NULL
			)`,
		),
	],
);

// ==[HUMAN APPROVED]== Shared authored lore is independent of its future attachment uses.
// JSON columns keep the authoring vocabulary extensible while the library validates every
// value before persistence; identities and ordering remain relational and stable.
export const lorebookTable = sqliteTable("lorebook", {
	id: int().primaryKey({ autoIncrement: true }),
	name: text().notNull(),
	description: text().notNull().default(""),
	revision: int().notNull().default(0),
});

export const lorebookEntryTable = sqliteTable(
	"lorebook_entry",
	{
		id: int().primaryKey({ autoIncrement: true }),
		lorebook_id: int()
			.notNull()
			.references(() => lorebookTable.id, { onDelete: "cascade" }),
		position: int().notNull(),
		title: text().notNull(),
		content: text().notNull(),
		keywords_json: text().notNull().default("[]"),
		semantic_triggers_json: text().notNull().default("[]"),
		match_operator: text().notNull().default("or"),
		always: int({ mode: "boolean" }).notNull().default(false),
		require_any_json: text().notNull().default("[]"),
		require_all_json: text().notNull().default("[]"),
		exclude_any_json: text().notNull().default("[]"),
		exclude_all_json: text().notNull().default("[]"),
		case_sensitive: int({ mode: "boolean" }).notNull().default(false),
		whole_word: int({ mode: "boolean" }).notNull().default(true),
		keyword_mode: text().notNull().default("literal"),
		regex_flags: text().notNull().default(""),
		priority: int().notNull().default(0),
		enabled: int({ mode: "boolean" }).notNull().default(true),
	},
	(table) => [
		uniqueIndex("lorebook_entry_position_unique").on(table.lorebook_id, table.position),
	],
);

// ==[HUMAN APPROVED]== Lore content is shared; scope and enablement belong to each use. Character
// uses are copied into a Participant when that Participant is forked, while
// Chat uses remain independent of the Cast.
export const characterLorebookAttachmentTable = sqliteTable(
	"character_lorebook_attachment",
	{
		id: int().primaryKey({ autoIncrement: true }),
		character_id: int().notNull().references(() => characterTable.id, { onDelete: "cascade" }),
		lorebook_id: int().notNull().references(() => lorebookTable.id, { onDelete: "cascade" }),
		scope: text().notNull().default("cast"),
		enabled: int({ mode: "boolean" }).notNull().default(true),
	},
	(table) => [
		uniqueIndex("character_lorebook_attachment_unique").on(table.character_id, table.lorebook_id, table.scope),
		check("character_lorebook_attachment_scope_check", sql`${table.scope} IN ('controlled-participant', 'cast')`),
	],
);

export const participantLorebookAttachmentTable = sqliteTable(
	"participant_lorebook_attachment",
	{
		id: int().primaryKey({ autoIncrement: true }),
		participant_id: int().notNull().references(() => participantTable.id, { onDelete: "cascade" }),
		lorebook_id: int().notNull().references(() => lorebookTable.id, { onDelete: "cascade" }),
		scope: text().notNull().default("cast"),
		enabled: int({ mode: "boolean" }).notNull().default(true),
	},
	(table) => [
		uniqueIndex("participant_lorebook_attachment_unique").on(table.participant_id, table.lorebook_id, table.scope),
		check("participant_lorebook_attachment_scope_check", sql`${table.scope} IN ('controlled-participant', 'cast')`),
	],
);

export const conversationLorebookAttachmentTable = sqliteTable(
	"conversation_lorebook_attachment",
	{
		id: int().primaryKey({ autoIncrement: true }),
		conversation_id: int().notNull().references(() => conversationTable.id, { onDelete: "cascade" }),
		lorebook_id: int().notNull().references(() => lorebookTable.id, { onDelete: "cascade" }),
		enabled: int({ mode: "boolean" }).notNull().default(true),
	},
	(table) => [uniqueIndex("conversation_lorebook_attachment_unique").on(table.conversation_id, table.lorebook_id)],
);

export const conversationLoreSettingsTable = sqliteTable("conversation_lore_settings", {
	conversation_id: int().primaryKey().references(() => conversationTable.id, { onDelete: "cascade" }),
	scan_depth: int().notNull().default(4),
	allowance: int().notNull().default(2048),
});

export const memorySettingsTable = sqliteTable("memory_settings", {
	id: int().primaryKey(),
	revision: int().notNull().default(0),
	enabled: int({ mode: "boolean" }).notNull().default(true),
	// ==[HUMAN APPROVED]== Preserve deleted Profile identity so settings reads can report the broken choice.
	extraction_profile_id: int(),
	extraction_model: text().notNull().default(""),
	context_limit: int().notNull().default(16384),
	output_reserve: int().notNull().default(2048),
	safety_allowance: int().notNull().default(500),
	usefulness_confidence_gate: real().notNull().default(0.3),
	recall_relevance_minimum: real().notNull().default(1.5),
	embedding_profile_id: int(),
	embedding_model: text().notNull().default(""),
});

export const typesafeSettingsTable = sqliteTable("typesafe_settings", {
	id: int().primaryKey(),
	revision: int().notNull().default(0),
	jev_model: text().notNull().default("jev-1.13.0"),
	lore_trigger_mode: text().notNull().default("jev"),
	lore_trigger_threshold: real().notNull().default(0.5),
	format_version: int(),
	key_id: text(),
	nonce: text(),
	ciphertext: text(),
	tag: text(),
}, (table) => [
	check("typesafe_settings_lore_trigger_mode_check", sql`${table.lore_trigger_mode} IN ('jev', 'off')`),
]);

export const conversationTable = sqliteTable("conversation", {
	id: int().primaryKey({ autoIncrement: true }),
	name: text().notNull(),
	creation_time: text().notNull(),
	last_message_time: text().notNull(),
	revision: int().notNull().default(0),
});

// ==[HUMAN APPROVED]== The Conversation's own selection from the shared preset library. The
// preset is referenced, never copied: saved edits reach every Conversation
// that selected it. Every Conversation has exactly one row, written at
// creation, so no read has to invent a selection.
export const conversationPromptPresetTable = sqliteTable(
	"conversation_prompt_preset",
	{
		conversation_id: int()
			.primaryKey()
			.references(() => conversationTable.id, { onDelete: "cascade" }),
		prompt_preset_id: int()
			.notNull()
			.references(() => promptPresetTable.id),
	},
	(table) => [
		index("conversation_prompt_preset_prompt_preset_id_index").on(
			table.prompt_preset_id,
		),
	],
);

export const messageTable = sqliteTable(
	"messages",
	{
		id: int().primaryKey({ autoIncrement: true }),
		conversation_id: int()
			.notNull()
			.references(() => conversationTable.id, { onDelete: "cascade" }),
		position: int().notNull(),
		timestamp: text().notNull(),
		// ==[HUMAN APPROVED]== Immutable Author Stamp: the authoring Cast Participant and the name
		// captured when the Message was created. Null only for preservation
		// records whose authors are not yet resolved into Participants.
		author_participant_id: int().references(() => participantTable.id),
		author_name: text(),
		// ==[HUMAN APPROVED]== Historical Control context: the human/model pair active when native
		// generation (including initial openings) began. Set together or not
		// at all; imported history is never retrofitted with a pair.
		context_human_participant_id: int().references(() => participantTable.id),
		context_model_participant_id: int().references(() => participantTable.id),
	},
	(table) => [
		uniqueIndex("messages_conversation_position_unique").on(
			table.conversation_id,
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

export const conversationMemorySettingsTable = sqliteTable("conversation_memory_settings", {
	conversation_id: int().primaryKey().references(() => conversationTable.id, { onDelete: "cascade" }),
	allowance: int().notNull().default(2048),
	revision: int().notNull().default(0),
	label_revision: int().notNull().default(0),
	label_merges: text().notNull().default("[]"),
});

export const memoryCatchupRunTable = sqliteTable("memory_catchup_run", {
	id: int().primaryKey({ autoIncrement: true }),
	conversation_id: int().notNull().references(() => conversationTable.id, { onDelete: "cascade" }),
	cancelled: int({ mode: "boolean" }).notNull().default(false),
	created_at: text().notNull(),
}, (table) => [
	index("memory_catchup_run_conversation").on(table.conversation_id),
]);

export const memoryCollectionTable = sqliteTable("memory_collection", {
	variant_id: int().primaryKey().references(() => messageVariantTable.id, { onDelete: "cascade" }),
	conversation_id: int().notNull().references(() => conversationTable.id, { onDelete: "cascade" }),
	message_id: int().notNull().references(() => messageTable.id, { onDelete: "cascade" }),
	source_hash: text().notNull(),
	revision: int().notNull().default(0),
	ownership: text({ enum: ["automatic", "writer"] }).notNull().default("automatic"),
	work_epoch: int().notNull().default(0),
	status: text({ enum: ["pending", "running", "complete", "failed"] }).notNull().default("pending"),
	error: text(),
	source_snapshot_json: text().notNull(),
	claims_json: text().notNull().default("[]"),
	trace_json: text(),
	catchup_run_id: int().references(() => memoryCatchupRunTable.id, { onDelete: "set null" }),
	source_changed: int({ mode: "boolean" }).notNull().default(false),
	index_attempt_json: text(),
	updated_at: text().notNull(),
}, (table) => [
	index("memory_collection_conversation_message").on(table.conversation_id, table.message_id),
	index("memory_collection_catchup_run").on(table.catchup_run_id),
	check("memory_collection_status_check", sql`${table.status} IN ('pending', 'running', 'complete', 'failed')`),
	check("memory_collection_ownership_check", sql`${table.ownership} IN ('automatic', 'writer')`),
]);

export const memoryEmbeddingCacheTable = sqliteTable("memory_embedding_cache", {
	space_key: text().notNull(),
	text_hash: text().notNull(),
	vector: blob({ mode: "buffer" }).notNull(),
}, (table) => [
	primaryKey({ columns: [table.space_key, table.text_hash] }),
]);

// ==[HUMAN APPROVED]== Character lifecycle base record. Definition content lives in the
// character_prompt and character_opening child tables, so a future
// tombstone can strip the Definition while retaining the referenced row.
export const characterTable = sqliteTable("character", {
	id: int().primaryKey({ autoIncrement: true }),
	name: text().notNull(),
	revision: int().notNull().default(0),
	pinned: int({ mode: "boolean" }).notNull().default(false),
	// ==[HUMAN APPROVED]== Null while the Character is active; set when reduced to a tombstone.
	deleted_at: text(),
});

// ==[HUMAN APPROVED]== One active Prompt row per Character with every typed Prompt field.
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
	...portraitColumns(),
});

// ==[HUMAN APPROVED]== Ordered, exact, nonblank Opening rows. Empty lists and duplicate
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

// ==[HUMAN APPROVED]== Conversation-local identity. Each Participant owns an independent copied
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
		conversation_id: int()
			.notNull()
			.references(() => conversationTable.id, { onDelete: "cascade" }),
		// ==[HUMAN APPROVED]== The Participant's own normalized nonblank name, independent of the
		// source Character and of every other Cast member. For a tombstone
		// this is the final name captured at removal.
		name: text().notNull(),
		// ==[HUMAN APPROVED]== Explicit, stable Cast position. Contiguity is maintained by the
		// Conversation domain; uniqueness is enforced structurally on active
		// Participants. Tombstones are not in the Cast and carry no position:
		// removal writes the sentinel 0 (never used by active members, which
		// start at 1), and the partial unique index below excludes tombstoned
		// rows so the sentinel never collides.
		position: int().notNull(),
		source_character_id: int().references(() => characterTable.id),
		// ==[HUMAN APPROVED]== Null while the Participant is active in the Cast; set when reduced
		// to a tombstone that only satisfies structural Message references.
		deleted_at: text(),
	},
	(table) => [
		uniqueIndex("participant_conversation_position_unique")
			.on(table.conversation_id, table.position)
			.where(sql`${table.deleted_at} IS NULL`),
	],
);

// ==[HUMAN APPROVED]== One active Prompt row per Participant with every typed Prompt field,
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
	...portraitColumns(),
});

// ==[HUMAN APPROVED]== Database column row representation for prompt channels shared by
// character_prompt and participant_prompt tables.
export interface PromptChannelRow {
	system_instruction: string;
	identity: string;
	scenario: string;
	example_dialogue: string;
	post_history_instruction: string;
}

// ==[HUMAN APPROVED]== Maps canonical PromptChannels to database column names shared by
// character_prompt and participant_prompt tables.
export const toPromptChannelRow = (prompt: PromptChannels): PromptChannelRow => ({
	system_instruction: prompt.systemInstruction,
	identity: prompt.identity,
	scenario: prompt.scenario,
	example_dialogue: prompt.exampleDialogue,
	post_history_instruction: prompt.postHistoryInstruction,
});

export const toPromptChannels = (row: PromptChannelRow): PromptChannels => ({
	systemInstruction: row.system_instruction,
	identity: row.identity,
	scenario: row.scenario,
	exampleDialogue: row.example_dialogue,
	postHistoryInstruction: row.post_history_instruction,
});

// ==[HUMAN APPROVED]== Ordered, exact, nonblank Opening rows owned by the Participant.
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

// ==[HUMAN APPROVED]== Control assignment: at most one human and one model seat per Conversation,
// each held by a distinct Cast Participant of the same Conversation. The
// primary key bounds each seat to one row, and the unique Participant
// reference makes the two seats structurally distinct.
export const conversationControlTable = sqliteTable(
	"conversation_control",
	{
		conversation_id: int()
			.notNull()
			.references(() => conversationTable.id, { onDelete: "cascade" }),
		seat: text().notNull(),
		participant_id: int()
			.notNull()
			.references(() => participantTable.id, { onDelete: "cascade" }),
	},
	(table) => [
		primaryKey({ columns: [table.conversation_id, table.seat] }),
		uniqueIndex("conversation_control_participant_unique").on(
			table.participant_id,
		),
		check(
			"conversation_control_seat_check",
			sql`${table.seat} IN ('human', 'model')`,
		),
	],
);

export const conversationDataTable = sqliteTable(
	"conversation_data",
	{
		id: int().primaryKey({ autoIncrement: true }),
		conversation_id: int()
			.notNull()
			.references(() => conversationTable.id, { onDelete: "cascade" }),
		namespace: text().notNull(),
		key: text().notNull(),
		value: text().notNull(),
	},
	(table) => [
		uniqueIndex("conversation_data_owner_key_unique").on(
			table.conversation_id,
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

// ==[HUMAN APPROVED]== Generic Conversation artifact metadata: one row per owned filesystem
// artifact. The row commits atomically with its Conversation through the
// creation seam while the exact bytes live outside SQLite under a unique
// managed relative path; committed physical copies are never automatically
// deleted (a deleted Chat cascades only this metadata row, leaving the file
// for manual recovery).
export const artifactTable = sqliteTable(
	"artifact",
	{
		id: int().primaryKey({ autoIncrement: true }),
		conversation_id: int()
			.notNull()
			.references(() => conversationTable.id, { onDelete: "cascade" }),
		namespace: text().notNull(),
		key: text().notNull(),
		// ==[HUMAN APPROVED]== Path relative to the managed artifact directory of the owning
		// deployment, never an absolute filesystem path.
		relative_path: text().notNull(),
		// ==[HUMAN APPROVED]== The original leaf filename carried by the source, used verbatim for
		// download presentation (sanitized only in response metadata).
		original_filename: text().notNull(),
		media_type: text().notNull(),
		byte_length: int().notNull(),
		sha256: text().notNull(),
	},
	(table) => [
		uniqueIndex("artifact_conversation_namespace_key_unique").on(
			table.conversation_id,
			table.namespace,
			table.key,
		),
	],
);

// ==[HUMAN APPROVED]== A server-owned Tail Generation lives in this table only while its provider
// attempt is active.  Its provisional Message/Variant are ordinary
// Conversation rows, but this record keeps the captured generation input
// and target identity together so the provider can be contacted only after
// the target has committed authoritatively.  JSON columns deliberately keep
// the domain seam independent from provider-specific request types.
export const activeGenerationTable = sqliteTable(
	"active_generation",
	{
		id: int().primaryKey({ autoIncrement: true }),
		conversation_id: int()
			.notNull()
			.references(() => conversationTable.id, { onDelete: "cascade" }),
		human_message_id: int()
			.references(() => messageTable.id, { onDelete: "cascade" }),
		message_id: int()
			.notNull()
			.references(() => messageTable.id, { onDelete: "cascade" }),
		variant_id: int()
			.notNull()
			.references(() => messageVariantTable.id, { onDelete: "cascade" }),
		// ==[HUMAN APPROVED]== A sibling records the Variant that was selected before its provisional
		// target was created. Tail and Continuation rows leave this null.
		prior_variant_id: int().references(() => messageVariantTable.id, { onDelete: "set null" }),
		human_participant_id: int()
			.notNull()
			.references(() => participantTable.id),
		model_participant_id: int()
			.notNull()
			.references(() => participantTable.id),
		// ==[HUMAN APPROVED]== Names are captured with the Control pair so an inspection remains
		// stable when either Participant is renamed while the provider runs.
		captured_human_name: text().notNull().default(""),
		captured_model_name: text().notNull(),
		started_at: text().notNull(),
		prompt_plan_json: text().notNull(),
		// ==[HUMAN APPROVED]== Budget diagnostics are active-only inspection data. Keeping this
		// separate from the plan makes the lifecycle able to discard the
		// complete prompt while retaining only compact Variant provenance.
		prompt_inspection_json: text().notNull().default("{}"),
	prompt_context_json: text().notNull(),
		// ==[HUMAN APPROVED]== Captured lore evidence is copied to durable Variant data at terminal
		// resolution; keeping it on the active row makes restart/recovery lossless.
		lore_activation_json: text().notNull().default("null"),
		memory_activation_json: text().notNull().default("null"),
		generation_settings_json: text().notNull(),
		connection_json: text().notNull(),
		generation_intent_json: text().notNull().default('{"type":"tail"}'),
		// ==[HUMAN APPROVED]== Mutable execution state. Checkpoints deliberately live on the active
		// record rather than Conversation revision history: they are a bounded
		// crash-recovery aid and never represent a new authored edit.
		checkpoint_content: text().notNull().default(""),
		checkpoint_reasoning: text().notNull().default(""),
		checkpoint_event_id: int().notNull().default(0),
		checkpointed_at: text(),
		provenance_namespace: text(),
		provenance_key: text(),
		provenance_value: text(),
		// ==[HUMAN APPROVED]== Pending macro writes are captured with the originating preset and
		// survive a process restart until terminal Variant persistence can attach
		// them to the target. An attempt never derives these from completion order.
		macro_preset_id: int(),
		macro_writes_json: text().notNull().default("[]"),
	},
);

// ==[HUMAN APPROVED]== Terminal inspection copy retained only for the bounded SSE replay window.
// The durable Variant owns compact provenance; this row temporarily keeps the
// complete provider-neutral capture so a reconnecting client can inspect the
// Generation that produced the just-finished Variant.
export const generationReplayTable = sqliteTable(
	"generation_replay",
	{
		id: int().primaryKey(),
		conversation_id: int()
			.notNull()
			.references(() => conversationTable.id, { onDelete: "cascade" }),
		message_id: int()
			.notNull()
			.references(() => messageTable.id, { onDelete: "cascade" }),
		variant_id: int()
			.notNull()
			.references(() => messageVariantTable.id, { onDelete: "cascade" }),
		human_participant_id: int().notNull(),
		model_participant_id: int().notNull(),
		captured_human_name: text().notNull(),
		captured_model_name: text().notNull(),
		started_at: text().notNull(),
		prompt_plan_json: text().notNull(),
		prompt_inspection_json: text().notNull(),
		prompt_context_json: text().notNull(),
		lore_activation_json: text().notNull().default("null"),
		memory_activation_json: text().notNull().default("null"),
		generation_settings_json: text().notNull(),
		connection_json: text().notNull(),
		generation_intent_json: text().notNull(),
		checkpoint_content: text().notNull(),
		checkpoint_reasoning: text().notNull(),
		checkpoint_event_id: int().notNull(),
		checkpointed_at: text(),
		terminal_status: text().notNull(),
		terminal_at: text().notNull(),
		expires_at: text().notNull(),
	},
);

// ==[HUMAN APPROVED]== Conversation-owned generation controls. A model selection is the
// Connection Profile and provider model ID together, so changing one Chat
// never redirects another Chat's later Generations.
export const conversationGenerationSettingsTable = sqliteTable(
	"conversation_generation_settings",
	{
		conversation_id: int()
			.primaryKey()
			.references(() => conversationTable.id, { onDelete: "cascade" }),
		connection_profile_id: int().references(() => connectionProfileTable.id, {
			onDelete: "set null",
		}),
		model_id: text().notNull().default("deepseek-chat"),
		temperature: real(),
		top_p: real(),
		frequency_penalty: real(),
		presence_penalty: real(),
		context_limit: int().notNull().default(32768),
		response_budget: int().notNull().default(1024),
		safety_allowance: int().notNull().default(500),
		// ==[HUMAN APPROVED]== Maximum number of parallel Sibling Generations at one response
		// position. Tail and Continuation still use the single-position gate.
		sibling_generation_limit: int().notNull().default(DEFAULT_SIBLING_GENERATION_LIMIT),
		continuation_strategy: text().notNull().default(DEFAULT_CONTINUATION_STRATEGY),
		continuation_instruction: text()
			.notNull()
			.default("Continue the narrative naturally without repeating the previous text."),
		continuation_prefill_suffix: text().notNull().default(""),
		request_overrides_json: text().notNull().default("{}"),
	},
);

// ==[HUMAN APPROVED]== Application-global catalog of model connections. Every saved Profile is
// available to every Chat; the Chat stores which one its model selection uses.
export const connectionProfileTable = sqliteTable(
	"connection_profile",
	{
		id: int().primaryKey({ autoIncrement: true }),
		display_name: text().notNull(),
		api_format: text().notNull(),
		request_url: text().notNull(),
		models_url: text().notNull().default(""),
		model_backend: text().notNull(),
		adapter: text().notNull(),
		output_token_representation: text().notNull().default("automatic"),
		timeout_ms: int().default(120000),
	},
	(table) => [
		uniqueIndex("connection_profile_display_name_ci").on(
			sql`lower(${table.display_name})`,
		),
		check(
			"connection_profile_timeout_nonnegative",
			sql`${table.timeout_ms} IS NULL OR ${table.timeout_ms} >= 0`,
		),
	],
);

export const connectionSettingsTable = sqliteTable("connection_settings", {
	id: int().primaryKey(),
	revision: int().notNull().default(0),
});

// ==[HUMAN APPROVED]== One encrypted payload per Profile. The dedicated credential and custom
// header values are never represented in any client-facing row or snapshot.
export const connectionSecretTable = sqliteTable("connection_secret", {
	profile_id: int()
		.primaryKey()
		.references(() => connectionProfileTable.id, { onDelete: "cascade" }),
	format_version: int().notNull(),
	key_id: text().notNull(),
	nonce: text().notNull(),
	ciphertext: text().notNull(),
	tag: text().notNull(),
});

export const connectionProfilePinnedModelTable = sqliteTable(
	"connection_profile_pinned_model",
	{
		profile_id: int()
			.notNull()
			.references(() => connectionProfileTable.id, { onDelete: "cascade" }),
		position: int().notNull(),
		model_id: text().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.profile_id, table.position] }),
		uniqueIndex("connection_profile_pinned_model_id_unique").on(
			table.profile_id,
			table.model_id,
		),
	],
);

// ==[HUMAN APPROVED]== Advisory model IDs returned by the explicitly configured Models URL. The
// cache is separate from Connection Settings revision and is replaced only
// after a successful refresh. The composite key intentionally remains
// case-sensitive: provider identifiers preserve their exact spelling, while
// display sorting is performed by the Connection Settings domain.
export const connectionProfileDiscoveryModelTable = sqliteTable(
	"connection_profile_discovery_model",
	{
		profile_id: int()
			.notNull()
			.references(() => connectionProfileTable.id, { onDelete: "cascade" }),
		model_id: text().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.profile_id, table.model_id] }),
	],
);

export const imageReferenceTable = sqliteTable(
	"image_reference",
	{
		id: int().primaryKey({ autoIncrement: true }),
		image_hash: text()
			.notNull()
			.references(() => imageTable.hash),
		kind: text({
			enum: ["variant", "prompt", "opening", "portrait", "macro-state", "active-generation"],
		}).notNull(),
		variant_id: int().references(() => messageVariantTable.id, { onDelete: "cascade" }),
		character_id: int().references(() => characterTable.id, { onDelete: "cascade" }),
		participant_id: int().references(() => participantTable.id, { onDelete: "cascade" }),
		variant_data_id: int().references(() => messageVariantDataTable.id, { onDelete: "cascade" }),
		conversation_data_id: int().references(() => conversationDataTable.id, { onDelete: "cascade" }),
		active_generation_id: int().references(() => activeGenerationTable.id, { onDelete: "cascade" }),
	},
	(table) => [
		index("image_reference_image_hash_index").on(table.image_hash),
		index("image_reference_variant_index").on(table.variant_id),
		index("image_reference_character_index").on(table.character_id),
		index("image_reference_participant_index").on(table.participant_id),
		index("image_reference_variant_data_index").on(table.variant_data_id),
		index("image_reference_conversation_data_index").on(table.conversation_data_id),
		index("image_reference_active_generation_index").on(table.active_generation_id),
		check(
			"image_reference_one_owner_check",
			sql`(${table.variant_id} IS NOT NULL) + (${table.character_id} IS NOT NULL) + (${table.participant_id} IS NOT NULL) + (${table.variant_data_id} IS NOT NULL) + (${table.conversation_data_id} IS NOT NULL) + (${table.active_generation_id} IS NOT NULL) = 1`,
		),
	],
);
