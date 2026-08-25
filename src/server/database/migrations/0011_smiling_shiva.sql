PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_connection_profile` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`display_name` text NOT NULL,
	`api_format` text NOT NULL,
	`request_url` text NOT NULL,
	`models_url` text DEFAULT '' NOT NULL,
	`model_backend` text NOT NULL,
	`adapter` text NOT NULL,
	`output_token_representation` text DEFAULT 'automatic' NOT NULL,
	`timeout_ms` integer DEFAULT 120000,
	`backend_options_json` text DEFAULT '{}' NOT NULL,
	CONSTRAINT "connection_profile_timeout_nonnegative" CHECK("__new_connection_profile"."timeout_ms" IS NULL OR "__new_connection_profile"."timeout_ms" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_connection_profile`("id", "display_name", "api_format", "request_url", "models_url", "model_backend", "adapter", "output_token_representation", "timeout_ms", "backend_options_json") SELECT "id", "display_name", "api_format", "request_url", "models_url", "model_backend", "adapter", "output_token_representation", "timeout_ms", "backend_options_json" FROM `connection_profile`;--> statement-breakpoint
DROP TABLE `connection_profile`;--> statement-breakpoint
ALTER TABLE `__new_connection_profile` RENAME TO `connection_profile`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `connection_profile_display_name_ci`;--> statement-breakpoint
CREATE UNIQUE INDEX `connection_profile_display_name_ci` ON `connection_profile` (lower("display_name"));
