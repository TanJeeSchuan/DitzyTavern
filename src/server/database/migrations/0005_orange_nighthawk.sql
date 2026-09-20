CREATE TABLE `character_lorebook_attachment` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`character_id` integer NOT NULL,
	`lorebook_id` integer NOT NULL,
	`scope` text DEFAULT 'cast' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `character`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lorebook_id`) REFERENCES `lorebook`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "character_lorebook_attachment_scope_check" CHECK("character_lorebook_attachment"."scope" IN ('controlled-participant', 'cast'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `character_lorebook_attachment_unique` ON `character_lorebook_attachment` (`character_id`,`lorebook_id`,`scope`);--> statement-breakpoint
CREATE TABLE `conversation_lore_settings` (
	`conversation_id` integer PRIMARY KEY NOT NULL,
	`scan_depth` integer DEFAULT 4 NOT NULL,
	`allowance` integer DEFAULT 2048 NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `conversation_lorebook_attachment` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`lorebook_id` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lorebook_id`) REFERENCES `lorebook`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_lorebook_attachment_unique` ON `conversation_lorebook_attachment` (`conversation_id`,`lorebook_id`);--> statement-breakpoint
CREATE TABLE `participant_lorebook_attachment` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`participant_id` integer NOT NULL,
	`lorebook_id` integer NOT NULL,
	`scope` text DEFAULT 'cast' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`participant_id`) REFERENCES `participant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lorebook_id`) REFERENCES `lorebook`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "participant_lorebook_attachment_scope_check" CHECK("participant_lorebook_attachment"."scope" IN ('controlled-participant', 'cast'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `participant_lorebook_attachment_unique` ON `participant_lorebook_attachment` (`participant_id`,`lorebook_id`,`scope`);