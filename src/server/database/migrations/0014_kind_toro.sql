CREATE TABLE `memory_embedding_cache` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`endpoint` text NOT NULL,
	`model` text NOT NULL,
	`text_hash` text NOT NULL,
	`rendered_text` text NOT NULL,
	`vector_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_embedding_cache_identity` ON `memory_embedding_cache` (`endpoint`,`model`,`text_hash`);--> statement-breakpoint
CREATE TABLE `memory_index_work` (
	`variant_id` integer PRIMARY KEY NOT NULL,
	`collection_revision` integer NOT NULL,
	`epoch` integer NOT NULL,
	`endpoint` text NOT NULL,
	`model` text NOT NULL,
	`deadline_ms` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `memory_collection`(`variant_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "memory_index_work_status_check" CHECK("memory_index_work"."status" IN ('pending', 'running', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `memory_index_work_status_updated` ON `memory_index_work` (`status`,`updated_at`);--> statement-breakpoint
ALTER TABLE `memory_collection` ADD `index_epoch` integer DEFAULT 0 NOT NULL;