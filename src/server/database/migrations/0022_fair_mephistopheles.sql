DELETE FROM `memory_embedding_cache`;--> statement-breakpoint
DELETE FROM `memory_index_work`;--> statement-breakpoint
DROP INDEX `memory_embedding_cache_identity`;--> statement-breakpoint
ALTER TABLE `memory_embedding_cache` ADD `space_key` text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `memory_embedding_cache_identity` ON `memory_embedding_cache` (`space_key`,`endpoint`,`model`,`text_hash`);--> statement-breakpoint
ALTER TABLE `memory_index_work` ADD `space_key` text NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_collection` DROP COLUMN `source_epoch`;--> statement-breakpoint
ALTER TABLE `memory_collection` DROP COLUMN `provenance_json`;