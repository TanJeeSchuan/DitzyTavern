DROP TABLE `embedding_cache`;--> statement-breakpoint
DROP TABLE `memory_secret`;--> statement-breakpoint
ALTER TABLE `embedding_settings` DROP COLUMN `threshold`;--> statement-breakpoint
ALTER TABLE `lorebook_entry` DROP COLUMN `semantic_threshold`;--> statement-breakpoint
ALTER TABLE `memory_settings` DROP COLUMN `jev_model`;