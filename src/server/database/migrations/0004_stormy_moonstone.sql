CREATE TABLE `character_opening` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`character_id` integer NOT NULL,
	`position` integer NOT NULL,
	`content` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `character`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `character_opening_character_position_unique` ON `character_opening` (`character_id`,`position`);--> statement-breakpoint
CREATE TABLE `character_prompt` (
	`character_id` integer PRIMARY KEY NOT NULL,
	`system_instruction` text NOT NULL,
	`identity` text NOT NULL,
	`scenario` text NOT NULL,
	`example_dialogue` text NOT NULL,
	`post_history_instruction` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `character`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `character` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `character` ADD `pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `character` ADD `deleted_at` text;