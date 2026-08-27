ALTER TABLE `active_generation` ADD `captured_human_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `active_generation` ADD `prompt_inspection_json` text DEFAULT '{}' NOT NULL;
