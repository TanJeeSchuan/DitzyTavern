ALTER TABLE `active_generation` ADD `macro_preset_id` integer;--> statement-breakpoint
ALTER TABLE `active_generation` ADD `macro_writes_json` text DEFAULT '[]' NOT NULL;