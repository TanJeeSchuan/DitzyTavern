CREATE TABLE `typesafe_secret` (
	`id` integer PRIMARY KEY NOT NULL,
	`format_version` integer NOT NULL,
	`key_id` text NOT NULL,
	`nonce` text NOT NULL,
	`ciphertext` text NOT NULL,
	`tag` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `typesafe_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`jev_model` text DEFAULT 'jev-1.13.0' NOT NULL,
	`lore_trigger_mode` text DEFAULT 'jev' NOT NULL,
	`lore_trigger_threshold` real DEFAULT 0.5 NOT NULL,
	CONSTRAINT "typesafe_settings_lore_trigger_mode_check" CHECK("typesafe_settings"."lore_trigger_mode" IN ('jev', 'off'))
);
--> statement-breakpoint
INSERT INTO `typesafe_settings` (`id`, `jev_model`) SELECT `id`, `jev_model` FROM `memory_settings`;--> statement-breakpoint
INSERT INTO `typesafe_secret` SELECT `id`, `format_version`, `key_id`, `nonce`, `ciphertext`, `tag` FROM `memory_secret`;
