ALTER TABLE `conversation_memory_settings` ADD `label_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_collection` ADD `index_attempt_json` text;--> statement-breakpoint
ALTER TABLE `memory_collection` DROP COLUMN `index_space_key`;--> statement-breakpoint
ALTER TABLE `memory_collection` DROP COLUMN `index_error`;