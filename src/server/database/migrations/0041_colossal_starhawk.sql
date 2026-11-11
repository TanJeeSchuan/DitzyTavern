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
				"__new_prompt_preset_block"."reference" LIKE 'box:%'
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
CREATE UNIQUE INDEX `prompt_preset_single_box_block` ON `prompt_preset_block` (`preset_id`,`reference`) WHERE "prompt_preset_block"."reference" LIKE 'box:%';--> statement-breakpoint
ALTER TABLE `character_prompt` ADD `appearance` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `character_prompt` ADD `send_appearance_images` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `participant_prompt` ADD `appearance` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `participant_prompt` ADD `send_appearance_images` integer DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE TEMP TABLE appearance_default_recipe AS
SELECT id, preset_id, row_number() OVER (ORDER BY sort_position) AS position, reference, enabled, role, name, content FROM (
 SELECT b.id, b.preset_id, b.position * 2 AS sort_position, b.reference, b.enabled, b.role, b.name, b.content
 FROM prompt_preset_block b JOIN prompt_preset p ON p.id = b.preset_id WHERE p.is_default = 1
 UNION ALL
 SELECT NULL, b.preset_id, b.position * 2 + 1,
 CASE b.reference WHEN 'human-identity' THEN 'human-appearance' ELSE 'model-appearance' END,
 b.enabled, b.role, NULL, NULL
 FROM prompt_preset_block b JOIN prompt_preset p ON p.id = b.preset_id
 WHERE p.is_default = 1 AND b.reference IN ('human-identity', 'model-identity')
);
--> statement-breakpoint
DELETE FROM prompt_preset_block WHERE preset_id IN (SELECT id FROM prompt_preset WHERE is_default = 1);
--> statement-breakpoint
INSERT INTO prompt_preset_block (id, preset_id, position, reference, enabled, role, name, content)
SELECT id, preset_id, position, reference, enabled, role, name, content FROM appearance_default_recipe WHERE id IS NOT NULL;
--> statement-breakpoint
INSERT INTO prompt_preset_block (preset_id, position, reference, enabled, role, name, content)
SELECT preset_id, position, reference, enabled, role, name, content FROM appearance_default_recipe WHERE id IS NULL;
--> statement-breakpoint
DROP TABLE appearance_default_recipe;
--> statement-breakpoint
UPDATE prompt_preset SET revision = revision + 1 WHERE is_default = 1;
