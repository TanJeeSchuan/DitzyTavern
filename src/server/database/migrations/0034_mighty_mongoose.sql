PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_conversation_generation_settings` (
	`conversation_id` integer PRIMARY KEY NOT NULL,
	`connection_profile_id` integer,
	`model_id` text DEFAULT 'deepseek-chat' NOT NULL,
	`temperature` real,
	`top_p` real,
	`frequency_penalty` real,
	`presence_penalty` real,
	`context_limit` integer DEFAULT 32768 NOT NULL,
	`response_budget` integer DEFAULT 1024 NOT NULL,
	`safety_allowance` integer DEFAULT 500 NOT NULL,
	`sibling_generation_limit` integer DEFAULT 4 NOT NULL,
	`continuation_strategy` text DEFAULT 'instruction' NOT NULL,
	`continuation_instruction` text DEFAULT 'Continue the narrative naturally without repeating the previous text.' NOT NULL,
	`continuation_prefill_suffix` text DEFAULT '' NOT NULL,
	`repeated_image_placement` text DEFAULT 'first' NOT NULL,
	`request_overrides_json` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_profile_id`) REFERENCES `connection_profile`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_conversation_generation_settings`("conversation_id", "connection_profile_id", "model_id", "temperature", "top_p", "frequency_penalty", "presence_penalty", "context_limit", "response_budget", "safety_allowance", "sibling_generation_limit", "continuation_strategy", "continuation_instruction", "continuation_prefill_suffix", "repeated_image_placement", "request_overrides_json") SELECT "conversation_id", "connection_profile_id", "model_id", "temperature", "top_p", "frequency_penalty", "presence_penalty", "context_limit", "response_budget", "safety_allowance", "sibling_generation_limit", "continuation_strategy", "continuation_instruction", "continuation_prefill_suffix", "repeated_image_placement", "request_overrides_json" FROM `conversation_generation_settings`;--> statement-breakpoint
DROP TABLE `conversation_generation_settings`;--> statement-breakpoint
ALTER TABLE `__new_conversation_generation_settings` RENAME TO `conversation_generation_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;