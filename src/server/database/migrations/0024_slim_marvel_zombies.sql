ALTER TABLE `memory_catchup_run` ADD `cancelled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_collection` ADD `index_space_key` text;--> statement-breakpoint
ALTER TABLE `memory_collection` ADD `index_error` text;--> statement-breakpoint
ALTER TABLE `memory_embedding_cache` ADD `vector` blob NOT NULL;