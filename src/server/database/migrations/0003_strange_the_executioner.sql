PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_message_variant` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`position` integer NOT NULL,
	`content` text NOT NULL,
	`timestamp` text NOT NULL,
	`selected` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_message_variant`("id", "message_id", "position", "content", "timestamp", "selected")
SELECT `message_variant`.`id`, `message_variant`.`message_id`, `message_variant`.`position`, `message_variant`.`content`, `messages`.`timestamp`, `message_variant`.`selected`
FROM `message_variant`
INNER JOIN `messages` ON `messages`.`id` = `message_variant`.`message_id`;--> statement-breakpoint
DROP TABLE `message_variant`;--> statement-breakpoint
ALTER TABLE `__new_message_variant` RENAME TO `message_variant`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `message_variant_message_position_unique` ON `message_variant` (`message_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_variant_one_selected_per_message` ON `message_variant` (`message_id`) WHERE "message_variant"."selected" = 1;
