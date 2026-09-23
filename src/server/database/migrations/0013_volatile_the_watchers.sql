ALTER TABLE `memory_collection` ADD `source_changed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_catchup_run` DROP COLUMN `path_snapshot_json`;