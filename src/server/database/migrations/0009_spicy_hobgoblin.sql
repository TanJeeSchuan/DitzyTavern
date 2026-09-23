PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_memory_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`extraction_profile_id` integer,
	`extraction_model` text DEFAULT '' NOT NULL,
	`context_limit` integer DEFAULT 16384 NOT NULL,
	`output_reserve` integer DEFAULT 2048 NOT NULL,
	`safety_allowance` integer DEFAULT 500 NOT NULL,
	`jev_model` text DEFAULT 'jev-1.13.0' NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_memory_settings`("id", "revision", "extraction_profile_id", "extraction_model", "context_limit", "output_reserve", "safety_allowance", "jev_model") SELECT "id", "revision", "extraction_profile_id", "extraction_model", "context_limit", "output_reserve", "safety_allowance", "jev_model" FROM `memory_settings`;--> statement-breakpoint
DROP TABLE `memory_settings`;--> statement-breakpoint
ALTER TABLE `__new_memory_settings` RENAME TO `memory_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `conversation_memory_settings` ADD `chat_epoch` integer DEFAULT 0 NOT NULL;