ALTER TABLE `conversation_memory_settings` ADD `label_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_collection` ADD `index_attempt_json` text;--> statement-breakpoint
ALTER TABLE `memory_collection` DROP COLUMN `index_space_key`;--> statement-breakpoint
ALTER TABLE `memory_collection` DROP COLUMN `index_error`;--> statement-breakpoint
DROP TABLE `typesafe_secret`;--> statement-breakpoint
ALTER TABLE `active_generation` ADD `memory_activation_json` text DEFAULT 'null' NOT NULL;--> statement-breakpoint
ALTER TABLE `generation_replay` ADD `memory_activation_json` text DEFAULT 'null' NOT NULL;--> statement-breakpoint
ALTER TABLE `typesafe_settings` ADD `format_version` integer;--> statement-breakpoint
ALTER TABLE `typesafe_settings` ADD `key_id` text;--> statement-breakpoint
ALTER TABLE `typesafe_settings` ADD `nonce` text;--> statement-breakpoint
ALTER TABLE `typesafe_settings` ADD `ciphertext` text;--> statement-breakpoint
ALTER TABLE `typesafe_settings` ADD `tag` text;