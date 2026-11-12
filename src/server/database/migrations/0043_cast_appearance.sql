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
				"__new_prompt_preset_block"."reference" IN ('lore', 'cast-appearance')
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
CREATE UNIQUE INDEX `prompt_preset_single_cast_appearance` ON `prompt_preset_block` (`preset_id`) WHERE "prompt_preset_block"."reference" = 'cast-appearance';--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_preset_single_brief_instruction` ON `prompt_preset_block` (`preset_id`) WHERE "prompt_preset_block"."reference" = 'brief-instruction';--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_preset_single_box_block` ON `prompt_preset_block` (`preset_id`,`reference`) WHERE "prompt_preset_block"."reference" LIKE 'box:%';--> statement-breakpoint
UPDATE prompt_preset_block SET position = -position
WHERE preset_id = (SELECT id FROM prompt_preset WHERE is_default_paint = 1)
AND position >= COALESCE((SELECT position FROM prompt_preset_block WHERE preset_id = (SELECT id FROM prompt_preset WHERE is_default_paint = 1) AND reference = 'lore'), 1);
--> statement-breakpoint
UPDATE prompt_preset_block SET position = 1 - position
WHERE preset_id = (SELECT id FROM prompt_preset WHERE is_default_paint = 1) AND position < 0;
--> statement-breakpoint
INSERT INTO prompt_preset_block (preset_id, position, reference, enabled, role)
SELECT id, COALESCE((SELECT position - 1 FROM prompt_preset_block WHERE preset_id = prompt_preset.id AND reference = 'lore'), 1), 'cast-appearance', 1, 'system'
FROM prompt_preset WHERE is_default_paint = 1;
