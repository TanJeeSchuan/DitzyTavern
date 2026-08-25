CREATE TABLE `conversation_generation_settings` (
	`chat_id` integer PRIMARY KEY NOT NULL,
	`model_id` text DEFAULT 'deepseek-chat' NOT NULL,
	`temperature` real,
	`top_p` real,
	`frequency_penalty` real,
	`presence_penalty` real,
	`context_limit` integer DEFAULT 32768 NOT NULL,
	`response_budget` integer DEFAULT 1024 NOT NULL,
	`request_overrides_json` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE cascade
);
