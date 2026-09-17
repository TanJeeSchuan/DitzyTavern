CREATE TABLE `lorebook_entry` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lorebook_id` integer NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`keywords_json` text DEFAULT '[]' NOT NULL,
	`semantic_triggers_json` text DEFAULT '[]' NOT NULL,
	`match_operator` text DEFAULT 'or' NOT NULL,
	`always` integer DEFAULT false NOT NULL,
	`require_any_json` text DEFAULT '[]' NOT NULL,
	`require_all_json` text DEFAULT '[]' NOT NULL,
	`exclude_any_json` text DEFAULT '[]' NOT NULL,
	`exclude_all_json` text DEFAULT '[]' NOT NULL,
	`case_sensitive` integer DEFAULT false NOT NULL,
	`whole_word` integer DEFAULT true NOT NULL,
	`keyword_mode` text DEFAULT 'literal' NOT NULL,
	`regex_flags` text DEFAULT '' NOT NULL,
	`semantic_threshold` real,
	`priority` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`lorebook_id`) REFERENCES `lorebook`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lorebook_entry_position_unique` ON `lorebook_entry` (`lorebook_id`,`position`);--> statement-breakpoint
CREATE TABLE `lorebook` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
