-- Custom SQL migration file, put your code below! --
ALTER TABLE `chat` RENAME TO `conversation`;
--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `chat_id` TO `conversation_id`;
--> statement-breakpoint
ALTER TABLE `participant` RENAME COLUMN `chat_id` TO `conversation_id`;
--> statement-breakpoint
ALTER TABLE `conversation_control` RENAME COLUMN `chat_id` TO `conversation_id`;
--> statement-breakpoint
ALTER TABLE `chat_data` RENAME TO `conversation_data`;
--> statement-breakpoint
ALTER TABLE `conversation_data` RENAME COLUMN `chat_id` TO `conversation_id`;
--> statement-breakpoint
ALTER TABLE `artifact` RENAME COLUMN `chat_id` TO `conversation_id`;
--> statement-breakpoint
ALTER TABLE `active_generation` RENAME COLUMN `chat_id` TO `conversation_id`;
--> statement-breakpoint
ALTER TABLE `generation_replay` RENAME COLUMN `chat_id` TO `conversation_id`;
--> statement-breakpoint
ALTER TABLE `conversation_generation_settings` RENAME COLUMN `chat_id` TO `conversation_id`;
--> statement-breakpoint
DROP INDEX `messages_chat_position_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conversation_position_unique` ON `messages` (`conversation_id`,`position`);
--> statement-breakpoint
DROP INDEX `participant_chat_position_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `participant_conversation_position_unique` ON `participant` (`conversation_id`,`position`) WHERE "participant"."deleted_at" IS NULL;
--> statement-breakpoint
DROP INDEX `chat_data_owner_key_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_data_owner_key_unique` ON `conversation_data` (`conversation_id`,`namespace`,`key`);
--> statement-breakpoint
DROP INDEX `artifact_chat_namespace_key_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_conversation_namespace_key_unique` ON `artifact` (`conversation_id`,`namespace`,`key`);
