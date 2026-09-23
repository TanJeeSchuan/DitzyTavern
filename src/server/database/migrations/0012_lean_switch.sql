PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_memory_catchup_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`path_snapshot_json` text NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "memory_catchup_run_state_check" CHECK("__new_memory_catchup_run"."state" IN ('running', 'complete', 'failed', 'cancelled'))
);
--> statement-breakpoint
INSERT INTO `__new_memory_catchup_run`("id", "conversation_id", "path_snapshot_json", "state", "created_at") SELECT "id", "conversation_id", "path_snapshot_json", "state", "created_at" FROM `memory_catchup_run`;--> statement-breakpoint
DROP TABLE `memory_catchup_run`;--> statement-breakpoint
ALTER TABLE `__new_memory_catchup_run` RENAME TO `memory_catchup_run`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `memory_catchup_run_conversation_state` ON `memory_catchup_run` (`conversation_id`,`state`);