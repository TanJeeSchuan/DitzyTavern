CREATE TABLE `generation_capture` (
	`generation_id` integer PRIMARY KEY NOT NULL,
	`variant_id` integer NOT NULL,
	`capture` blob NOT NULL,
	`image_references` text NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `message_variant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `generation_checkpoint` (
	`generation_id` integer NOT NULL,
	`event_id` integer NOT NULL,
	`content_end` integer NOT NULL,
	`reasoning_end` integer NOT NULL,
	`content` text NOT NULL,
	`reasoning` text NOT NULL,
	`checkpointed_at` text NOT NULL,
	PRIMARY KEY(`generation_id`, `event_id`),
	FOREIGN KEY (`generation_id`) REFERENCES `active_generation`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
--> statement-breakpoint
ALTER TABLE `active_generation` DROP COLUMN `prompt_plan_json`;--> statement-breakpoint
ALTER TABLE `active_generation` DROP COLUMN `prompt_inspection_json`;--> statement-breakpoint
ALTER TABLE `active_generation` DROP COLUMN `prompt_context_json`;--> statement-breakpoint
ALTER TABLE `active_generation` DROP COLUMN `checkpoint_content`;--> statement-breakpoint
ALTER TABLE `active_generation` DROP COLUMN `checkpoint_reasoning`;--> statement-breakpoint
ALTER TABLE `active_generation` DROP COLUMN `checkpoint_event_id`;--> statement-breakpoint
ALTER TABLE `active_generation` DROP COLUMN `checkpointed_at`;--> statement-breakpoint
DELETE FROM `generation_replay`;--> statement-breakpoint
ALTER TABLE `generation_replay` DROP COLUMN `prompt_plan_json`;--> statement-breakpoint
ALTER TABLE `generation_replay` DROP COLUMN `prompt_inspection_json`;--> statement-breakpoint
ALTER TABLE `generation_replay` DROP COLUMN `prompt_context_json`;