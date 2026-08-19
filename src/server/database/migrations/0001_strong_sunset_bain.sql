ALTER TABLE `users_table` RENAME TO `character`;--> statement-breakpoint
CREATE TABLE `chat_character` (
	`chat_id` integer NOT NULL,
	`character_id` integer NOT NULL,
	PRIMARY KEY(`chat_id`, `character_id`)
);
--> statement-breakpoint
CREATE TABLE `chat` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`creation_time` text NOT NULL,
	`last_message_time` text NOT NULL
);
--> statement-breakpoint
DROP INDEX `users_table_email_unique`;--> statement-breakpoint
ALTER TABLE `character` DROP COLUMN `age`;--> statement-breakpoint
ALTER TABLE `character` DROP COLUMN `email`;