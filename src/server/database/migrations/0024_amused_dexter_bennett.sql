DROP TABLE `conversation_memory_settings`;--> statement-breakpoint
DROP TABLE `memory_settings`;--> statement-breakpoint
ALTER TABLE `conversation_data` ADD `revision` integer DEFAULT 0 NOT NULL;