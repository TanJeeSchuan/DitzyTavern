CREATE TABLE `connection_profile_pinned_model` (
	`profile_id` integer NOT NULL,
	`position` integer NOT NULL,
	`model_id` text NOT NULL,
	PRIMARY KEY(`profile_id`, `position`),
	FOREIGN KEY (`profile_id`) REFERENCES `connection_profile`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connection_profile_pinned_model_id_unique` ON `connection_profile_pinned_model` (`profile_id`,`model_id`);--> statement-breakpoint
CREATE TABLE `connection_profile` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`display_name` text NOT NULL,
	`api_format` text NOT NULL,
	`request_url` text NOT NULL,
	`models_url` text DEFAULT '' NOT NULL,
	`model_backend` text NOT NULL,
	`adapter` text NOT NULL,
	`output_token_representation` text DEFAULT 'automatic' NOT NULL,
	`timeout_ms` integer DEFAULT 120000 NOT NULL,
	`backend_options_json` text DEFAULT '{}' NOT NULL,
	CONSTRAINT "connection_profile_timeout_positive" CHECK("connection_profile"."timeout_ms" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connection_profile_display_name_ci` ON `connection_profile` (lower("display_name"));--> statement-breakpoint
CREATE TABLE `connection_secret` (
	`profile_id` integer PRIMARY KEY NOT NULL,
	`format_version` integer NOT NULL,
	`key_id` text NOT NULL,
	`nonce` text NOT NULL,
	`ciphertext` text NOT NULL,
	`tag` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `connection_profile`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `connection_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`active_profile_id` integer,
	FOREIGN KEY (`active_profile_id`) REFERENCES `connection_profile`(`id`) ON UPDATE no action ON DELETE set null
);
