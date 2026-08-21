CREATE TABLE `chat_data` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_data_owner_key_unique` ON `chat_data` (`chat_id`,`namespace`,`key`);--> statement-breakpoint
CREATE TABLE `messages_data` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_data_owner_key_unique` ON `messages_data` (`message_id`,`namespace`,`key`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`position` integer NOT NULL,
	`timestamp` text NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_chat_position_unique` ON `messages` (`chat_id`,`position`);--> statement-breakpoint
CREATE TABLE `message_variant_data` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_variant_id` integer NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`message_variant_id`) REFERENCES `message_variant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_variant_data_owner_key_unique` ON `message_variant_data` (`message_variant_id`,`namespace`,`key`);--> statement-breakpoint
CREATE TABLE `message_variant` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`position` integer NOT NULL,
	`content` text NOT NULL,
	`selected` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_variant_message_position_unique` ON `message_variant` (`message_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_variant_one_selected_per_message` ON `message_variant` (`message_id`) WHERE "message_variant"."selected" = 1;--> statement-breakpoint
ALTER TABLE `chat` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chat_character` (
	`chat_id` integer NOT NULL,
	`character_id` integer NOT NULL,
	PRIMARY KEY(`chat_id`, `character_id`),
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`) REFERENCES `character`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_chat_character`("chat_id", "character_id")
SELECT `membership`.`chat_id`, `membership`.`character_id`
FROM `chat_character` AS `membership`
INNER JOIN `chat` ON `chat`.`id` = `membership`.`chat_id`
INNER JOIN `character` ON `character`.`id` = `membership`.`character_id`;--> statement-breakpoint
DROP TABLE `chat_character`;--> statement-breakpoint
ALTER TABLE `__new_chat_character` RENAME TO `chat_character`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
