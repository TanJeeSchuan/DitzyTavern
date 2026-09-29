DROP TABLE `memory_index_work`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_memory_catchup_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_memory_catchup_run`("id", "conversation_id", "created_at") SELECT "id", "conversation_id", "created_at" FROM `memory_catchup_run`;--> statement-breakpoint
DROP TABLE `memory_catchup_run`;--> statement-breakpoint
ALTER TABLE `__new_memory_catchup_run` RENAME TO `memory_catchup_run`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `memory_catchup_run_conversation` ON `memory_catchup_run` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `__new_memory_embedding_cache` (
	`space_key` text NOT NULL,
	`text_hash` text NOT NULL,
	PRIMARY KEY(`space_key`, `text_hash`)
);
--> statement-breakpoint
DROP TABLE `memory_embedding_cache`;--> statement-breakpoint
ALTER TABLE `__new_memory_embedding_cache` RENAME TO `memory_embedding_cache`;--> statement-breakpoint
ALTER TABLE `conversation_memory_settings` DROP COLUMN `chat_epoch`;--> statement-breakpoint
ALTER TABLE `memory_collection` DROP COLUMN `chat_epoch`;--> statement-breakpoint
ALTER TABLE `memory_collection` DROP COLUMN `index_epoch`;