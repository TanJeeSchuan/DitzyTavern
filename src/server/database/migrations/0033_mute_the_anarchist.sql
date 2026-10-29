ALTER TABLE `conversation` ADD `forked_from_conversation_id` integer REFERENCES `conversation`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `conversation` ADD `forked_from_message_id` integer REFERENCES `messages`(`id`) ON DELETE SET NULL CHECK (`forked_from_conversation_id` IS NOT NULL OR `forked_from_message_id` IS NULL);