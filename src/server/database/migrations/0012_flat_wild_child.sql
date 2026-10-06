CREATE TABLE `semantic_trigger_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`decision_profile_id` integer,
	`decision_model` text DEFAULT '' NOT NULL,
	`decision_state_token_limit` integer DEFAULT 16000 NOT NULL,
	`trigger_threshold` real DEFAULT 0.5 NOT NULL
);
--> statement-breakpoint
DROP TABLE `typesafe_settings`;--> statement-breakpoint
ALTER TABLE `memory_settings` ADD `retain_probability_minimum` real DEFAULT 0.6 NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_settings` ADD `decision_profile_id` integer;--> statement-breakpoint
ALTER TABLE `memory_settings` ADD `decision_model` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_settings` ADD `decision_state_token_limit` integer DEFAULT 16000 NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_settings` DROP COLUMN `usefulness_confidence_gate`;