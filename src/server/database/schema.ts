// ==[HUMAN APPROVED]== Drizzle schema source of truth.
// Domain modules add tables here; run `bun run db:generate` to produce migrations.

import { sql } from "drizzle-orm";
import {
	check,
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
import type { PromptChannels } from "../../shared/contract/prompt-schema";

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
// disabled slot keeps its place in the order rather than leaving it.
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
	},
	(table) => [
		uniqueIndex("prompt_preset_block_position_unique").on(
			table.preset_id,
			table.position,
		),
	],
);

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

// ==[HUMAN APPROVED]== Conversation-owned generation controls. These values are deliberately
// separate from the application-global Connection Profile: activating or
// editing a Profile changes the transport used by later Generations, never
// the model selection or sampling choices of an existing Conversation.
export const conversationGenerationSettingsTable = sqliteTable(
	"conversation_generation_settings",
	{
		conversation_id: int()
			.primaryKey()
			.references(() => conversationTable.id, { onDelete: "cascade" }),
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

// ==[HUMAN APPROVED]== Application-global model connection configuration. These tables are
// deliberately separate from Chat/Conversation state: changing the active
// Profile changes only future Generations and never rewrites Conversation
// data.
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
	active_profile_id: int().references(() => connectionProfileTable.id, {
		onDelete: "set null",
	}),
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

