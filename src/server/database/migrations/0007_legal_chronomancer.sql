DROP INDEX `participant_chat_position_unique`;--> statement-breakpoint
ALTER TABLE `participant` ADD `deleted_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `participant_chat_position_unique` ON `participant` (`chat_id`,`position`) WHERE "participant"."deleted_at" IS NULL;