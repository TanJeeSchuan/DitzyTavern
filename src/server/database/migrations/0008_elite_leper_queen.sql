DROP TABLE `embedding_cache`;--> statement-breakpoint
DROP TABLE `embedding_secret`;--> statement-breakpoint
DROP TABLE `embedding_settings`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_prompt_preset_block` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`preset_id` integer NOT NULL,
	`position` integer NOT NULL,
	`reference` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`role` text,
	`name` text,
	`content` text,
	FOREIGN KEY (`preset_id`) REFERENCES `prompt_preset`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "prompt_preset_block_shape_check" CHECK((
				"__new_prompt_preset_block"."reference" = 'history'
				AND "__new_prompt_preset_block"."role" IS NULL
				AND "__new_prompt_preset_block"."name" IS NULL
				AND "__new_prompt_preset_block"."content" IS NULL
			) OR (
				"__new_prompt_preset_block"."reference" = 'instruction'
				AND "__new_prompt_preset_block"."role" IS NOT NULL
				AND "__new_prompt_preset_block"."role" IN ('system', 'user', 'assistant')
				AND "__new_prompt_preset_block"."name" IS NOT NULL
				AND "__new_prompt_preset_block"."content" IS NOT NULL
			) OR (
				"__new_prompt_preset_block"."reference" IN (
					'model-system-instruction',
					'human-identity',
					'model-identity',
					'model-scenario',
					'model-example-dialogue',
					'model-post-history-instruction'
				)
				AND "__new_prompt_preset_block"."role" IS NOT NULL
				AND "__new_prompt_preset_block"."role" IN ('system', 'user', 'assistant')
				AND "__new_prompt_preset_block"."name" IS NULL
				AND "__new_prompt_preset_block"."content" IS NULL
			) OR (
				"__new_prompt_preset_block"."reference" = 'lore'
				AND "__new_prompt_preset_block"."role" IS NOT NULL
				AND "__new_prompt_preset_block"."role" IN ('system', 'user', 'assistant')
				AND "__new_prompt_preset_block"."name" IS NULL
				AND "__new_prompt_preset_block"."content" IS NULL
			) OR (
				"__new_prompt_preset_block"."reference" = 'memory'
				AND "__new_prompt_preset_block"."role" IS NOT NULL
				AND "__new_prompt_preset_block"."role" IN ('system', 'user', 'assistant')
				AND "__new_prompt_preset_block"."name" IS NULL
				AND "__new_prompt_preset_block"."content" IS NULL
			))
);
--> statement-breakpoint
INSERT INTO `__new_prompt_preset_block`("id", "preset_id", "position", "reference", "enabled", "role", "name", "content") SELECT "id", "preset_id", "position", "reference", "enabled", "role", "name", "content" FROM `prompt_preset_block`;--> statement-breakpoint
DROP TABLE `prompt_preset_block`;--> statement-breakpoint
ALTER TABLE `__new_prompt_preset_block` RENAME TO `prompt_preset_block`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_preset_block_position_unique` ON `prompt_preset_block` (`preset_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_preset_single_lore_block` ON `prompt_preset_block` (`preset_id`) WHERE "prompt_preset_block"."reference" = 'lore';--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_preset_single_memory_block` ON `prompt_preset_block` (`preset_id`) WHERE "prompt_preset_block"."reference" = 'memory';--> statement-breakpoint
ALTER TABLE `lorebook_entry` DROP COLUMN `semantic_threshold`;--> statement-breakpoint
CREATE TABLE `conversation_memory_settings` (
	`conversation_id` integer PRIMARY KEY NOT NULL,
	`allowance` integer DEFAULT 2048 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `memory_catchup_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`cancelled` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_catchup_run_conversation` ON `memory_catchup_run` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `memory_collection` (
	`variant_id` integer PRIMARY KEY NOT NULL,
	`conversation_id` integer NOT NULL,
	`message_id` integer NOT NULL,
	`source_hash` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`ownership` text DEFAULT 'automatic' NOT NULL,
	`work_epoch` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`source_snapshot_json` text NOT NULL,
	`claims_json` text DEFAULT '[]' NOT NULL,
	`trace_json` text,
	`catchup_run_id` integer,
	`source_changed` integer DEFAULT false NOT NULL,
	`index_space_key` text,
	`index_error` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `message_variant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`catchup_run_id`) REFERENCES `memory_catchup_run`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "memory_collection_status_check" CHECK("memory_collection"."status" IN ('pending', 'running', 'complete', 'failed')),
	CONSTRAINT "memory_collection_ownership_check" CHECK("memory_collection"."ownership" IN ('automatic', 'writer'))
);
--> statement-breakpoint
CREATE INDEX `memory_collection_conversation_message` ON `memory_collection` (`conversation_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `memory_collection_catchup_run` ON `memory_collection` (`catchup_run_id`);--> statement-breakpoint
CREATE TABLE `memory_embedding_cache` (
	`space_key` text NOT NULL,
	`text_hash` text NOT NULL,
	`vector` blob NOT NULL,
	PRIMARY KEY(`space_key`, `text_hash`)
);
--> statement-breakpoint
CREATE TABLE `memory_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`extraction_profile_id` integer,
	`extraction_model` text DEFAULT '' NOT NULL,
	`context_limit` integer DEFAULT 16384 NOT NULL,
	`output_reserve` integer DEFAULT 2048 NOT NULL,
	`safety_allowance` integer DEFAULT 500 NOT NULL,
	`usefulness_confidence_gate` real DEFAULT 0.3 NOT NULL,
	`recall_relevance_minimum` real DEFAULT 1.5 NOT NULL,
	`embedding_profile_id` integer,
	`embedding_model` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `typesafe_secret` (
	`id` integer PRIMARY KEY NOT NULL,
	`format_version` integer NOT NULL,
	`key_id` text NOT NULL,
	`nonce` text NOT NULL,
	`ciphertext` text NOT NULL,
	`tag` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `typesafe_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`jev_model` text DEFAULT 'jev-1.13.0' NOT NULL,
	`lore_trigger_mode` text DEFAULT 'jev' NOT NULL,
	`lore_trigger_threshold` real DEFAULT 0.5 NOT NULL,
	CONSTRAINT "typesafe_settings_lore_trigger_mode_check" CHECK("typesafe_settings"."lore_trigger_mode" IN ('jev', 'off'))
);--> statement-breakpoint
UPDATE `prompt_preset_block` SET `position` = -(`position` + 1) WHERE `preset_id` IN (SELECT `id` FROM `prompt_preset` WHERE `is_default` = 1) AND `position` >= (SELECT h.`position` FROM `prompt_preset_block` h WHERE h.`preset_id` = `prompt_preset_block`.`preset_id` AND h.`reference` = 'history');--> statement-breakpoint
UPDATE `prompt_preset_block` SET `position` = -`position` WHERE `position` < 0;--> statement-breakpoint
INSERT INTO `prompt_preset_block` (`preset_id`, `position`, `reference`, `role`) SELECT h.`preset_id`, h.`position` - 1, 'memory', 'system' FROM `prompt_preset_block` h JOIN `prompt_preset` p ON p.`id` = h.`preset_id` WHERE p.`is_default` = 1 AND h.`reference` = 'history';