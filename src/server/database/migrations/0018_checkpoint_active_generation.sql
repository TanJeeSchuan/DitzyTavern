ALTER TABLE `active_generation` ADD `checkpoint_content` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `active_generation` ADD `checkpoint_reasoning` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `active_generation` ADD `checkpoint_event_id` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `active_generation` ADD `checkpointed_at` text;
