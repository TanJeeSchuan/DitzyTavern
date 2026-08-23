CREATE TABLE `conversation_control` (
	`chat_id` integer NOT NULL,
	`seat` text NOT NULL,
	`participant_id` integer NOT NULL,
	PRIMARY KEY(`chat_id`, `seat`),
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `participant`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_control_seat_check" CHECK("conversation_control"."seat" IN ('human', 'model'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_control_participant_unique` ON `conversation_control` (`participant_id`);--> statement-breakpoint
CREATE TABLE `participant_opening` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`participant_id` integer NOT NULL,
	`position` integer NOT NULL,
	`content` text NOT NULL,
	FOREIGN KEY (`participant_id`) REFERENCES `participant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `participant_opening_participant_position_unique` ON `participant_opening` (`participant_id`,`position`);--> statement-breakpoint
CREATE TABLE `participant_prompt` (
	`participant_id` integer PRIMARY KEY NOT NULL,
	`system_instruction` text NOT NULL,
	`identity` text NOT NULL,
	`scenario` text NOT NULL,
	`example_dialogue` text NOT NULL,
	`post_history_instruction` text NOT NULL,
	FOREIGN KEY (`participant_id`) REFERENCES `participant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `participant` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`source_character_id` integer,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_character_id`) REFERENCES `character`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `participant_chat_position_unique` ON `participant` (`chat_id`,`position`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`position` integer NOT NULL,
	`timestamp` text NOT NULL,
	`author_participant_id` integer,
	`author_name` text,
	`context_human_participant_id` integer,
	`context_model_participant_id` integer,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_participant_id`) REFERENCES `participant`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`context_human_participant_id`) REFERENCES `participant`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`context_model_participant_id`) REFERENCES `participant`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "messages_context_pair_together" CHECK((context_human_participant_id IS NULL) = (context_model_participant_id IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_messages`("id", "chat_id", "position", "timestamp", "author_participant_id", "author_name", "context_human_participant_id", "context_model_participant_id") SELECT "id", "chat_id", "position", "timestamp", "author_participant_id", "author_name", "context_human_participant_id", "context_model_participant_id" FROM `messages`;--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_chat_position_unique` ON `messages` (`chat_id`,`position`);