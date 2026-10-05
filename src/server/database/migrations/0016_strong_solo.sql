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
INSERT INTO `__new_character_prompt`("character_id", "system_instruction", "identity", "scenario", "example_dialogue", "post_history_instruction", "portrait_hash", "portrait_focal_x", "portrait_focal_y") SELECT "character_id", "system_instruction", "identity", "scenario", "example_dialogue", "post_history_instruction", "portrait_hash", "portrait_focal_x", "portrait_focal_y" FROM `character_prompt`;--> statement-breakpoint
DROP TABLE `character_prompt`;--> statement-breakpoint
ALTER TABLE `__new_character_prompt` RENAME TO `character_prompt`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
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
INSERT INTO `__new_participant_prompt`("participant_id", "system_instruction", "identity", "scenario", "example_dialogue", "post_history_instruction", "portrait_hash", "portrait_focal_x", "portrait_focal_y") SELECT "participant_id", "system_instruction", "identity", "scenario", "example_dialogue", "post_history_instruction", "portrait_hash", "portrait_focal_x", "portrait_focal_y" FROM `participant_prompt`;--> statement-breakpoint
DROP TABLE `participant_prompt`;--> statement-breakpoint
ALTER TABLE `__new_participant_prompt` RENAME TO `participant_prompt`;