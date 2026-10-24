ALTER TABLE `memory_embedding_cache` RENAME TO `embedding_cache`;--> statement-breakpoint
ALTER TABLE `active_generation` DROP COLUMN `memory_activation_json`;--> statement-breakpoint
ALTER TABLE `generation_replay` DROP COLUMN `memory_activation_json`;--> statement-breakpoint
DELETE FROM `message_variant_data` WHERE `namespace` = 'generation-memory';--> statement-breakpoint
ALTER TABLE `active_generation` ADD `box_traces_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `generation_replay` ADD `box_traces_json` text DEFAULT '{}' NOT NULL;
