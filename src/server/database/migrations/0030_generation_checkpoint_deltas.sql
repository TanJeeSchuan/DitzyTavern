CREATE TABLE `generation_capture` (
	`generation_id` integer PRIMARY KEY NOT NULL,
	`capture` blob NOT NULL,
	`image_references` text NOT NULL
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
-- An Active Generation interrupted by the upgrade keeps its checkpointed output for recovery. Its ends count
-- characters rather than UTF-16 units, which only matters to a runtime appending after them, and none survives a restart.
INSERT INTO `generation_checkpoint` SELECT `id`, `checkpoint_event_id`, length(`checkpoint_content`), length(`checkpoint_reasoning`), `checkpoint_content`, `checkpoint_reasoning`, coalesce(`checkpointed_at`, `started_at`)
	FROM `active_generation` WHERE `checkpoint_content` <> '' OR `checkpoint_reasoning` <> '';--> statement-breakpoint
-- An Active Generation that ends without terminal resolution (its human Message was deleted) leaves its checkpointed
-- output in its Variant, and its capture goes with it.
CREATE TRIGGER `active_generation_abandoned` BEFORE DELETE ON `active_generation`
WHEN NOT EXISTS (SELECT 1 FROM `generation_replay` WHERE `id` = OLD.`id`)
BEGIN
	UPDATE `message_variant`
		SET `content` = (SELECT group_concat(`content`, '' ORDER BY `event_id`) FROM `generation_checkpoint` WHERE `generation_id` = OLD.`id`)
		WHERE `id` = OLD.`variant_id` AND EXISTS (SELECT 1 FROM `generation_checkpoint` WHERE `generation_id` = OLD.`id` AND `content` <> '');
	DELETE FROM `generation_capture` WHERE `generation_id` = OLD.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `generation_replay_removed` AFTER DELETE ON `generation_replay`
BEGIN
	DELETE FROM `generation_capture` WHERE `generation_id` = OLD.`id`;
END;--> statement-breakpoint
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