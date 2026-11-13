PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_prompt_preset_block` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`preset_id` integer NOT NULL,
	`position` integer NOT NULL,
	`reference` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`role` text,
	`name` text,
	`content` text,
	FOREIGN KEY (`preset_id`) REFERENCES `prompt_preset`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "prompt_preset_block_shape_check" CHECK((
				"__new_prompt_preset_block"."reference" = 'history'
				AND "__new_prompt_preset_block"."role" IS NULL
				AND "__new_prompt_preset_block"."name" IS NULL
				AND "__new_prompt_preset_block"."content" IS NULL
			) OR (
				"__new_prompt_preset_block"."reference" = 'instruction'
				AND "__new_prompt_preset_block"."role" IS NOT NULL
				AND "__new_prompt_preset_block"."role" IN ('system', 'user', 'assistant')
				AND "__new_prompt_preset_block"."name" IS NOT NULL
				AND "__new_prompt_preset_block"."content" IS NOT NULL
			) OR (
				"__new_prompt_preset_block"."reference" IN (
					'model-system-instruction',
					'human-identity',
					'human-appearance',
					'model-identity',
					'model-appearance',
					'model-scenario',
					'model-example-dialogue',
					'model-post-history-instruction'
				)
				AND "__new_prompt_preset_block"."role" IS NOT NULL
				AND "__new_prompt_preset_block"."role" IN ('system', 'user', 'assistant')
				AND "__new_prompt_preset_block"."name" IS NULL
				AND "__new_prompt_preset_block"."content" IS NULL
			) OR (
				"__new_prompt_preset_block"."reference" = 'lore'
				AND "__new_prompt_preset_block"."role" IS NOT NULL
				AND "__new_prompt_preset_block"."role" IN ('system', 'user', 'assistant')
				AND "__new_prompt_preset_block"."name" IS NULL
				AND "__new_prompt_preset_block"."content" IS NULL
			) OR (
				("__new_prompt_preset_block"."reference" LIKE 'box:%' OR "__new_prompt_preset_block"."reference" = 'brief-instruction')
				AND "__new_prompt_preset_block"."role" IS NOT NULL
				AND "__new_prompt_preset_block"."role" IN ('system', 'user', 'assistant')
				AND "__new_prompt_preset_block"."name" IS NULL
				AND "__new_prompt_preset_block"."content" IS NOT NULL
			))
);
--> statement-breakpoint
INSERT INTO `__new_prompt_preset_block`("id", "preset_id", "position", "reference", "enabled", "role", "name", "content") SELECT "id", "preset_id", "position", "reference", "enabled", "role", "name", "content" FROM `prompt_preset_block`;--> statement-breakpoint
DROP TABLE `prompt_preset_block`;--> statement-breakpoint
ALTER TABLE `__new_prompt_preset_block` RENAME TO `prompt_preset_block`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_preset_block_position_unique` ON `prompt_preset_block` (`preset_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_preset_single_lore_block` ON `prompt_preset_block` (`preset_id`) WHERE "prompt_preset_block"."reference" = 'lore';--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_preset_single_brief_instruction` ON `prompt_preset_block` (`preset_id`) WHERE "prompt_preset_block"."reference" = 'brief-instruction';--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_preset_single_box_block` ON `prompt_preset_block` (`preset_id`,`reference`) WHERE "prompt_preset_block"."reference" LIKE 'box:%';--> statement-breakpoint
ALTER TABLE `prompt_preset` ADD `is_default_paint` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_preset_single_default_paint` ON `prompt_preset` (`is_default_paint`) WHERE "prompt_preset"."is_default_paint" = 1;
--> statement-breakpoint
INSERT INTO prompt_preset (name, is_default_paint) VALUES ('Default (Paint)', 1);
--> statement-breakpoint
INSERT INTO prompt_preset_block (preset_id, position, reference, role, content)
SELECT id, 1, 'lore', 'system', NULL FROM prompt_preset WHERE is_default_paint = 1;
--> statement-breakpoint
INSERT INTO prompt_preset_block (preset_id, position, reference, role, content)
SELECT id, 2, 'history', NULL, NULL FROM prompt_preset WHERE is_default_paint = 1;
--> statement-breakpoint
INSERT INTO prompt_preset_block (preset_id, position, reference, role, content)
SELECT id, 3, 'brief-instruction', 'user', 'Write a short description of the scene for an image model. Describe the visible characters, setting, composition and lighting. Follow the writer''s Ask. Return only the Brief.' FROM prompt_preset WHERE is_default_paint = 1;
--> statement-breakpoint
CREATE TABLE `__new_conversation_prompt_preset` (
	`conversation_id` integer PRIMARY KEY NOT NULL,
	`paint_preset_id` integer NOT NULL,
	`brief_message_count` integer DEFAULT 5,
	`prompt_preset_id` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`paint_preset_id`) REFERENCES `prompt_preset`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prompt_preset_id`) REFERENCES `prompt_preset`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "brief_message_count_positive" CHECK("__new_conversation_prompt_preset"."brief_message_count" IS NULL OR "__new_conversation_prompt_preset"."brief_message_count" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_conversation_prompt_preset`("conversation_id", "paint_preset_id", "brief_message_count", "prompt_preset_id") SELECT "conversation_id", (SELECT id FROM prompt_preset WHERE is_default_paint = 1), 5, "prompt_preset_id" FROM `conversation_prompt_preset`;--> statement-breakpoint
DROP TABLE `conversation_prompt_preset`;--> statement-breakpoint
ALTER TABLE `__new_conversation_prompt_preset` RENAME TO `conversation_prompt_preset`;--> statement-breakpoint
CREATE INDEX `conversation_paint_preset_id_index` ON `conversation_prompt_preset` (`paint_preset_id`);--> statement-breakpoint
CREATE INDEX `conversation_prompt_preset_prompt_preset_id_index` ON `conversation_prompt_preset` (`prompt_preset_id`);
