CREATE TABLE `prompt_preset` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_preset_single_default` ON `prompt_preset` (`is_default`) WHERE "prompt_preset"."is_default" = 1;--> statement-breakpoint
CREATE TABLE `prompt_preset_block` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`preset_id` integer NOT NULL,
	`position` integer NOT NULL,
	`reference` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`preset_id`) REFERENCES `prompt_preset`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_preset_block_position_unique` ON `prompt_preset_block` (`preset_id`,`position`);--> statement-breakpoint
CREATE TABLE `conversation_prompt_preset` (
	`conversation_id` integer PRIMARY KEY NOT NULL,
	`prompt_preset_id` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prompt_preset_id`) REFERENCES `prompt_preset`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- The required Default preset and its recipe. This is domain initialization,
-- not sample data: it is written once here and never rewritten by a later
-- start, so edits to Default survive restarts.
INSERT INTO `prompt_preset` (`name`, `is_default`) VALUES ('Default', 1);--> statement-breakpoint
INSERT INTO `prompt_preset_block` (`preset_id`, `position`, `reference`, `enabled`)
SELECT `id`, `position`, `reference`, 1 FROM `prompt_preset`, (
	SELECT 1 AS `position`, 'model-system-instruction' AS `reference`
	UNION ALL SELECT 2, 'human-identity'
	UNION ALL SELECT 3, 'model-identity'
	UNION ALL SELECT 4, 'model-scenario'
	UNION ALL SELECT 5, 'model-example-dialogue'
	UNION ALL SELECT 6, 'history'
	UNION ALL SELECT 7, 'model-post-history-instruction'
) WHERE `is_default` = 1;--> statement-breakpoint
INSERT INTO `conversation_prompt_preset` (`conversation_id`, `prompt_preset_id`)
SELECT `conversation`.`id`, `prompt_preset`.`id`
FROM `conversation`, `prompt_preset` WHERE `prompt_preset`.`is_default` = 1;
