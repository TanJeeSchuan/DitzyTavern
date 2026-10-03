CREATE TABLE `image_reference` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`image_hash` text NOT NULL,
	`kind` text NOT NULL,
	`variant_id` integer,
	`character_id` integer,
	`participant_id` integer,
	`variant_data_id` integer,
	`conversation_data_id` integer,
	`active_generation_id` integer,
	FOREIGN KEY (`image_hash`) REFERENCES `image`(`hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `message_variant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`) REFERENCES `character`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `participant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_data_id`) REFERENCES `message_variant_data`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_data_id`) REFERENCES `conversation_data`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`active_generation_id`) REFERENCES `active_generation`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "image_reference_one_owner_check" CHECK(("image_reference"."variant_id" IS NOT NULL) + ("image_reference"."character_id" IS NOT NULL) + ("image_reference"."participant_id" IS NOT NULL) + ("image_reference"."variant_data_id" IS NOT NULL) + ("image_reference"."conversation_data_id" IS NOT NULL) + ("image_reference"."active_generation_id" IS NOT NULL) = 1)
);
--> statement-breakpoint
CREATE INDEX `image_reference_image_hash_index` ON `image_reference` (`image_hash`);--> statement-breakpoint
CREATE INDEX `image_reference_variant_index` ON `image_reference` (`variant_id`);--> statement-breakpoint
CREATE INDEX `image_reference_character_index` ON `image_reference` (`character_id`);--> statement-breakpoint
CREATE INDEX `image_reference_participant_index` ON `image_reference` (`participant_id`);--> statement-breakpoint
CREATE INDEX `image_reference_variant_data_index` ON `image_reference` (`variant_data_id`);--> statement-breakpoint
CREATE INDEX `image_reference_conversation_data_index` ON `image_reference` (`conversation_data_id`);--> statement-breakpoint
CREATE INDEX `image_reference_active_generation_index` ON `image_reference` (`active_generation_id`);--> statement-breakpoint
CREATE TABLE `image` (
	`hash` text PRIMARY KEY NOT NULL,
	`bytes` blob NOT NULL,
	`media_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `character_prompt` ADD `portrait_hash` text;--> statement-breakpoint
ALTER TABLE `character_prompt` ADD `portrait_focal_x` real;--> statement-breakpoint
ALTER TABLE `character_prompt` ADD `portrait_focal_y` real;--> statement-breakpoint
ALTER TABLE `participant_prompt` ADD `portrait_hash` text;--> statement-breakpoint
ALTER TABLE `participant_prompt` ADD `portrait_focal_x` real;--> statement-breakpoint
ALTER TABLE `participant_prompt` ADD `portrait_focal_y` real;
--> statement-breakpoint
CREATE TRIGGER `image_reference_gc` AFTER DELETE ON `image_reference` BEGIN
	DELETE FROM `image` WHERE `hash` = OLD.`image_hash` AND NOT EXISTS (SELECT 1 FROM `image_reference` WHERE `image_hash` = OLD.`image_hash`);
END;
