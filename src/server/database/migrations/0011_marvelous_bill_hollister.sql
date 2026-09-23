CREATE TABLE `memory_catchup_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`path_snapshot_json` text NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "memory_catchup_run_state_check" CHECK("memory_catchup_run"."state" IN ('running', 'complete', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `memory_catchup_run_conversation_state` ON `memory_catchup_run` (`conversation_id`,`state`);--> statement-breakpoint
ALTER TABLE `memory_collection` ADD `catchup_run_id` integer REFERENCES memory_catchup_run(id);--> statement-breakpoint
CREATE INDEX `memory_collection_catchup_run` ON `memory_collection` (`catchup_run_id`);