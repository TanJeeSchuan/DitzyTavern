PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_active_generation` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`human_message_id` integer,
	`message_id` integer NOT NULL,
	`variant_id` integer NOT NULL,
	`human_participant_id` integer NOT NULL,
	`model_participant_id` integer NOT NULL,
	`captured_model_name` text NOT NULL,
	`started_at` text NOT NULL,
	`prompt_plan_json` text NOT NULL,
	`history_roles_json` text NOT NULL,
	`generation_settings_json` text NOT NULL,
	`connection_json` text NOT NULL,
	`generation_intent_json` text DEFAULT '{"type":"tail"}' NOT NULL,
	`provenance_namespace` text,
	`provenance_key` text,
	`provenance_value` text,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`human_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `message_variant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`human_participant_id`) REFERENCES `participant`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_participant_id`) REFERENCES `participant`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_active_generation`("id", "chat_id", "human_message_id", "message_id", "variant_id", "human_participant_id", "model_participant_id", "captured_model_name", "started_at", "prompt_plan_json", "history_roles_json", "generation_settings_json", "connection_json", "generation_intent_json", "provenance_namespace", "provenance_key", "provenance_value") SELECT "id", "chat_id", "human_message_id", "message_id", "variant_id", "human_participant_id", "model_participant_id", "captured_model_name", "started_at", "prompt_plan_json", "history_roles_json", "generation_settings_json", "connection_json", '{"type":"tail"}', "provenance_namespace", "provenance_key", "provenance_value" FROM `active_generation`;--> statement-breakpoint
DROP TABLE `active_generation`;--> statement-breakpoint
ALTER TABLE `__new_active_generation` RENAME TO `active_generation`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `conversation_generation_settings` ADD `continuation_strategy` text DEFAULT 'instruction' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversation_generation_settings` ADD `continuation_instruction` text DEFAULT 'Continue the narrative naturally without repeating the previous text.' NOT NULL;
