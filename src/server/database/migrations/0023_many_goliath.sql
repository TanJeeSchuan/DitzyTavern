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
					'model-identity',
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
INSERT INTO `__new_prompt_preset_block`("id", "preset_id", "position", "reference", "enabled", "role", "name", "content") SELECT "id", "preset_id", "position", "reference", "enabled", "role", "name", CASE
	WHEN "reference" = 'box:phone' THEN 'Write each text on its own line as <sms from="{{other}}" to="{{self}}">message</sms>, with the sender in from and the recipient in to. Narrate around a text; never restate it in the prose.'
	WHEN "reference" = 'box:thought' THEN 'When a character thinks something they do not say aloud, write it inside the prose as <thought>the thought</thought>. Never restate a thought in the narration.'
	WHEN "reference" = 'box:mood' THEN 'Scene mood:'
	WHEN "reference" LIKE 'box:%' THEN ''
	ELSE "content"
END FROM `prompt_preset_block`;--> statement-breakpoint
DROP TABLE `prompt_preset_block`;--> statement-breakpoint
ALTER TABLE `__new_prompt_preset_block` RENAME TO `prompt_preset_block`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_preset_block_position_unique` ON `prompt_preset_block` (`preset_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_preset_single_lore_block` ON `prompt_preset_block` (`preset_id`) WHERE "prompt_preset_block"."reference" = 'lore';--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_preset_single_box_block` ON `prompt_preset_block` (`preset_id`,`reference`) WHERE "prompt_preset_block"."reference" LIKE 'box:%';