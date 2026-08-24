CREATE TABLE `artifact` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`relative_path` text NOT NULL,
	`original_filename` text NOT NULL,
	`media_type` text NOT NULL,
	`byte_length` integer NOT NULL,
	`sha256` text NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_chat_namespace_key_unique` ON `artifact` (`chat_id`,`namespace`,`key`);