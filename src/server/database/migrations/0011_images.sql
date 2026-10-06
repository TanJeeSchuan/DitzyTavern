CREATE TABLE `connection_profile_text_only_model` (
	`profile_id` integer NOT NULL,
	`model_id` text NOT NULL,
	PRIMARY KEY(`profile_id`, `model_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `connection_profile`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `image` (
	`hash` text PRIMARY KEY NOT NULL,
	`bytes` blob NOT NULL,
	`media_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`orphaned_at` integer
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_character_prompt` (
	`character_id` integer PRIMARY KEY NOT NULL,
	`system_instruction` text NOT NULL,
	`identity` text NOT NULL,
	`scenario` text NOT NULL,
	`example_dialogue` text NOT NULL,
	`post_history_instruction` text NOT NULL,
	`portrait_hash` text,
	`portrait_focal_x` real,
	`portrait_focal_y` real,
	FOREIGN KEY (`character_id`) REFERENCES `character`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "character_prompt_portrait_complete" CHECK(("__new_character_prompt"."portrait_hash" IS NULL AND "__new_character_prompt"."portrait_focal_x" IS NULL AND "__new_character_prompt"."portrait_focal_y" IS NULL) OR ("__new_character_prompt"."portrait_hash" IS NOT NULL AND "__new_character_prompt"."portrait_focal_x" IS NOT NULL AND "__new_character_prompt"."portrait_focal_y" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_character_prompt`("character_id", "system_instruction", "identity", "scenario", "example_dialogue", "post_history_instruction") SELECT "character_id", "system_instruction", "identity", "scenario", "example_dialogue", "post_history_instruction" FROM `character_prompt`;--> statement-breakpoint
DROP TABLE `character_prompt`;--> statement-breakpoint
ALTER TABLE `__new_character_prompt` RENAME TO `character_prompt`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `conversation_generation_settings` ADD `repeated_image_placement` text DEFAULT 'last' NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_participant_prompt` (
	`participant_id` integer PRIMARY KEY NOT NULL,
	`system_instruction` text NOT NULL,
	`identity` text NOT NULL,
	`scenario` text NOT NULL,
	`example_dialogue` text NOT NULL,
	`post_history_instruction` text NOT NULL,
	`portrait_hash` text,
	`portrait_focal_x` real,
	`portrait_focal_y` real,
	FOREIGN KEY (`participant_id`) REFERENCES `participant`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "participant_prompt_portrait_complete" CHECK(("__new_participant_prompt"."portrait_hash" IS NULL AND "__new_participant_prompt"."portrait_focal_x" IS NULL AND "__new_participant_prompt"."portrait_focal_y" IS NULL) OR ("__new_participant_prompt"."portrait_hash" IS NOT NULL AND "__new_participant_prompt"."portrait_focal_x" IS NOT NULL AND "__new_participant_prompt"."portrait_focal_y" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_participant_prompt`("participant_id", "system_instruction", "identity", "scenario", "example_dialogue", "post_history_instruction") SELECT "participant_id", "system_instruction", "identity", "scenario", "example_dialogue", "post_history_instruction" FROM `participant_prompt`;--> statement-breakpoint
DROP TABLE `participant_prompt`;--> statement-breakpoint
ALTER TABLE `__new_participant_prompt` RENAME TO `participant_prompt`;