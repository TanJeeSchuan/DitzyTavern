CREATE TABLE `embedding_cache` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`endpoint` text NOT NULL,
	`model` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_text` text NOT NULL,
	`vector_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `embedding_cache_source_unique` ON `embedding_cache` (`endpoint`,`model`,`source_kind`,`source_text`);--> statement-breakpoint
CREATE TABLE `embedding_secret` (
	`settings_id` integer PRIMARY KEY NOT NULL,
	`format_version` integer NOT NULL,
	`key_id` text NOT NULL,
	`nonce` text NOT NULL,
	`ciphertext` text NOT NULL,
	`tag` text NOT NULL,
	FOREIGN KEY (`settings_id`) REFERENCES `embedding_settings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `embedding_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`endpoint` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`threshold` real DEFAULT 0.7 NOT NULL,
	`deadline_ms` integer DEFAULT 5000 NOT NULL
);
