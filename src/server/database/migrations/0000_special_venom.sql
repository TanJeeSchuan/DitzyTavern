CREATE TABLE `active_generation` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`human_message_id` integer,
	`message_id` integer NOT NULL,
	`variant_id` integer NOT NULL,
	`prior_variant_id` integer,
	`human_participant_id` integer NOT NULL,
	`model_participant_id` integer NOT NULL,
	`captured_human_name` text DEFAULT '' NOT NULL,
	`captured_model_name` text NOT NULL,
	`started_at` text NOT NULL,
	`prompt_plan_json` text NOT NULL,
	`prompt_inspection_json` text DEFAULT '{}' NOT NULL,
	`prompt_context_json` text NOT NULL,
	`generation_settings_json` text NOT NULL,
	`connection_json` text NOT NULL,
	`generation_intent_json` text DEFAULT '{"type":"tail"}' NOT NULL,
	`checkpoint_content` text DEFAULT '' NOT NULL,
	`checkpoint_reasoning` text DEFAULT '' NOT NULL,
	`checkpoint_event_id` integer DEFAULT 0 NOT NULL,
	`checkpointed_at` text,
	`provenance_namespace` text,
	`provenance_key` text,
	`provenance_value` text,
	`macro_preset_id` integer,
	`macro_writes_json` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`human_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `message_variant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prior_variant_id`) REFERENCES `message_variant`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`human_participant_id`) REFERENCES `participant`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_participant_id`) REFERENCES `participant`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `artifact` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`relative_path` text NOT NULL,
	`original_filename` text NOT NULL,
	`media_type` text NOT NULL,
	`byte_length` integer NOT NULL,
	`sha256` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_conversation_namespace_key_unique` ON `artifact` (`conversation_id`,`namespace`,`key`);--> statement-breakpoint
CREATE TABLE `character_opening` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`character_id` integer NOT NULL,
	`position` integer NOT NULL,
	`content` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `character`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `character_opening_character_position_unique` ON `character_opening` (`character_id`,`position`);--> statement-breakpoint
CREATE TABLE `character_prompt` (
	`character_id` integer PRIMARY KEY NOT NULL,
	`system_instruction` text NOT NULL,
	`identity` text NOT NULL,
	`scenario` text NOT NULL,
	`example_dialogue` text NOT NULL,
	`post_history_instruction` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `character`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `character` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE TABLE `connection_profile_discovery_model` (
	`profile_id` integer NOT NULL,
	`model_id` text NOT NULL,
	PRIMARY KEY(`profile_id`, `model_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `connection_profile`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `connection_profile_pinned_model` (
	`profile_id` integer NOT NULL,
	`position` integer NOT NULL,
	`model_id` text NOT NULL,
	PRIMARY KEY(`profile_id`, `position`),
	FOREIGN KEY (`profile_id`) REFERENCES `connection_profile`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connection_profile_pinned_model_id_unique` ON `connection_profile_pinned_model` (`profile_id`,`model_id`);--> statement-breakpoint
CREATE TABLE `connection_profile` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`display_name` text NOT NULL,
	`api_format` text NOT NULL,
	`request_url` text NOT NULL,
	`models_url` text DEFAULT '' NOT NULL,
	`model_backend` text NOT NULL,
	`adapter` text NOT NULL,
	`output_token_representation` text DEFAULT 'automatic' NOT NULL,
	`timeout_ms` integer DEFAULT 120000,
	CONSTRAINT "connection_profile_timeout_nonnegative" CHECK("connection_profile"."timeout_ms" IS NULL OR "connection_profile"."timeout_ms" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connection_profile_display_name_ci` ON `connection_profile` (lower("display_name"));--> statement-breakpoint
CREATE TABLE `connection_secret` (
	`profile_id` integer PRIMARY KEY NOT NULL,
	`format_version` integer NOT NULL,
	`key_id` text NOT NULL,
	`nonce` text NOT NULL,
	`ciphertext` text NOT NULL,
	`tag` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `connection_profile`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `connection_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`active_profile_id` integer,
	FOREIGN KEY (`active_profile_id`) REFERENCES `connection_profile`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `conversation_control` (
	`conversation_id` integer NOT NULL,
	`seat` text NOT NULL,
	`participant_id` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `seat`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `participant`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_control_seat_check" CHECK("conversation_control"."seat" IN ('human', 'model'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_control_participant_unique` ON `conversation_control` (`participant_id`);--> statement-breakpoint
CREATE TABLE `conversation_data` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_data_owner_key_unique` ON `conversation_data` (`conversation_id`,`namespace`,`key`);--> statement-breakpoint
CREATE TABLE `conversation_generation_settings` (
	`conversation_id` integer PRIMARY KEY NOT NULL,
	`model_id` text DEFAULT 'deepseek-chat' NOT NULL,
	`temperature` real,
	`top_p` real,
	`frequency_penalty` real,
	`presence_penalty` real,
	`context_limit` integer DEFAULT 32768 NOT NULL,
	`response_budget` integer DEFAULT 1024 NOT NULL,
	`safety_allowance` integer DEFAULT 500 NOT NULL,
	`sibling_generation_limit` integer DEFAULT 4 NOT NULL,
	`continuation_strategy` text DEFAULT 'instruction' NOT NULL,
	`continuation_instruction` text DEFAULT 'Continue the narrative naturally without repeating the previous text.' NOT NULL,
	`continuation_prefill_suffix` text DEFAULT '' NOT NULL,
	`request_overrides_json` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `conversation_prompt_preset` (
	`conversation_id` integer PRIMARY KEY NOT NULL,
	`prompt_preset_id` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prompt_preset_id`) REFERENCES `prompt_preset`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversation_prompt_preset_prompt_preset_id_index` ON `conversation_prompt_preset` (`prompt_preset_id`);
--> statement-breakpoint
CREATE TABLE `conversation` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`creation_time` text NOT NULL,
	`last_message_time` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `generation_replay` (
	`id` integer PRIMARY KEY NOT NULL,
	`conversation_id` integer NOT NULL,
	`message_id` integer NOT NULL,
	`variant_id` integer NOT NULL,
	`human_participant_id` integer NOT NULL,
	`model_participant_id` integer NOT NULL,
	`captured_human_name` text NOT NULL,
	`captured_model_name` text NOT NULL,
	`started_at` text NOT NULL,
	`prompt_plan_json` text NOT NULL,
	`prompt_inspection_json` text NOT NULL,
	`prompt_context_json` text NOT NULL,
	`generation_settings_json` text NOT NULL,
	`connection_json` text NOT NULL,
	`generation_intent_json` text NOT NULL,
	`checkpoint_content` text NOT NULL,
	`checkpoint_reasoning` text NOT NULL,
	`checkpoint_event_id` integer NOT NULL,
	`checkpointed_at` text,
	`terminal_status` text NOT NULL,
	`terminal_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `message_variant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `messages_data` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_data_owner_key_unique` ON `messages_data` (`message_id`,`namespace`,`key`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`position` integer NOT NULL,
	`timestamp` text NOT NULL,
	`author_participant_id` integer,
	`author_name` text,
	`context_human_participant_id` integer,
	`context_model_participant_id` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_participant_id`) REFERENCES `participant`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`context_human_participant_id`) REFERENCES `participant`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`context_model_participant_id`) REFERENCES `participant`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "messages_context_pair_together" CHECK((context_human_participant_id IS NULL) = (context_model_participant_id IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conversation_position_unique` ON `messages` (`conversation_id`,`position`);--> statement-breakpoint
CREATE TABLE `message_variant_data` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_variant_id` integer NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`message_variant_id`) REFERENCES `message_variant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_variant_data_owner_key_unique` ON `message_variant_data` (`message_variant_id`,`namespace`,`key`);--> statement-breakpoint
CREATE TABLE `message_variant` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`position` integer NOT NULL,
	`content` text NOT NULL,
	`timestamp` text NOT NULL,
	`selected` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_variant_message_position_unique` ON `message_variant` (`message_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_variant_one_selected_per_message` ON `message_variant` (`message_id`) WHERE "message_variant"."selected" = 1;--> statement-breakpoint
CREATE TABLE `participant_opening` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`participant_id` integer NOT NULL,
	`position` integer NOT NULL,
	`content` text NOT NULL,
	FOREIGN KEY (`participant_id`) REFERENCES `participant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `participant_opening_participant_position_unique` ON `participant_opening` (`participant_id`,`position`);--> statement-breakpoint
CREATE TABLE `participant_prompt` (
	`participant_id` integer PRIMARY KEY NOT NULL,
	`system_instruction` text NOT NULL,
	`identity` text NOT NULL,
	`scenario` text NOT NULL,
	`example_dialogue` text NOT NULL,
	`post_history_instruction` text NOT NULL,
	FOREIGN KEY (`participant_id`) REFERENCES `participant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `participant` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`source_character_id` integer,
	`deleted_at` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_character_id`) REFERENCES `character`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `participant_conversation_position_unique` ON `participant` (`conversation_id`,`position`) WHERE "participant"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `prompt_preset_block` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`preset_id` integer NOT NULL,
	`position` integer NOT NULL,
	`reference` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`role` text,
	`name` text,
	`content` text,
	CONSTRAINT "prompt_preset_block_shape_check" CHECK((
		"prompt_preset_block"."reference" = 'history'
		AND "prompt_preset_block"."role" IS NULL
		AND "prompt_preset_block"."name" IS NULL
		AND "prompt_preset_block"."content" IS NULL
	) OR (
		"prompt_preset_block"."reference" = 'instruction'
		AND "prompt_preset_block"."role" IS NOT NULL
		AND "prompt_preset_block"."role" IN ('system', 'user', 'assistant')
		AND "prompt_preset_block"."name" IS NOT NULL
		AND "prompt_preset_block"."content" IS NOT NULL
	) OR (
		"prompt_preset_block"."reference" IN ('model-system-instruction', 'human-identity', 'model-identity', 'model-scenario', 'model-example-dialogue', 'lore', 'memory', 'model-post-history-instruction')
		AND "prompt_preset_block"."role" IS NOT NULL
		AND "prompt_preset_block"."role" IN ('system', 'user', 'assistant')
		AND "prompt_preset_block"."name" IS NULL
		AND "prompt_preset_block"."content" IS NULL
	)),
	FOREIGN KEY (`preset_id`) REFERENCES `prompt_preset`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_preset_block_position_unique` ON `prompt_preset_block` (`preset_id`,`position`);--> statement-breakpoint
CREATE TABLE `prompt_preset` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_preset_single_default` ON `prompt_preset` (`is_default`) WHERE "prompt_preset"."is_default" = 1;
--> statement-breakpoint
INSERT INTO `prompt_preset` (`name`, `is_default`) VALUES ('Default', 1);
--> statement-breakpoint
INSERT INTO `prompt_preset_block` (`preset_id`, `position`, `reference`, `enabled`, `role`)
SELECT `prompt_preset`.`id`, `recipe`.`position`, `recipe`.`reference`, 1, `recipe`.`role`
FROM `prompt_preset`, (
	SELECT 1 AS `position`, 'model-system-instruction' AS `reference`, 'system' AS `role`
	UNION ALL SELECT 2, 'human-identity', 'user'
	UNION ALL SELECT 3, 'model-identity', 'assistant'
	UNION ALL SELECT 4, 'model-scenario', 'system'
	UNION ALL SELECT 5, 'model-example-dialogue', 'user'
	UNION ALL SELECT 6, 'lore', 'system'
	UNION ALL SELECT 7, 'memory', 'system'
	UNION ALL SELECT 8, 'history', NULL
	UNION ALL SELECT 9, 'model-post-history-instruction', 'system'
) AS `recipe` WHERE `prompt_preset`.`is_default` = 1;
