DELETE FROM `message_variant_data` WHERE `namespace` = 'lore-activation' AND `key` = 'record';--> statement-breakpoint
UPDATE `active_generation` SET `lore_activation_json` = 'null';--> statement-breakpoint
UPDATE `generation_replay` SET `lore_activation_json` = 'null';
