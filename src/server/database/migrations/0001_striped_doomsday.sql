PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_connection_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_connection_settings`("id", "revision") SELECT "id", "revision" FROM `connection_settings`;--> statement-breakpoint
DROP TABLE `connection_settings`;--> statement-breakpoint
ALTER TABLE `__new_connection_settings` RENAME TO `connection_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `conversation_generation_settings` ADD `connection_profile_id` integer REFERENCES connection_profile(id) ON DELETE SET NULL;
