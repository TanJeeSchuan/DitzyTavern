DROP TABLE `embedding_secret`;--> statement-breakpoint
DROP TABLE `embedding_settings`;--> statement-breakpoint
ALTER TABLE `memory_settings` ADD `embedding_profile_id` integer;--> statement-breakpoint
ALTER TABLE `memory_settings` ADD `embedding_model` text DEFAULT '' NOT NULL;