CREATE TABLE `update_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`automatic_checks` integer DEFAULT true NOT NULL,
	CONSTRAINT "update_settings_singleton" CHECK("update_settings"."id" = 1)
);
