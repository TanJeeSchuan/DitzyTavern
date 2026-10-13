DROP TABLE `memory_catchup_run`;--> statement-breakpoint
DROP TABLE `memory_collection`;--> statement-breakpoint
DELETE FROM `message_variant_data` WHERE `namespace` = 'generation-memory' AND `key` = 'activation';--> statement-breakpoint
UPDATE `active_generation` SET `memory_activation_json` = 'null';--> statement-breakpoint
UPDATE `generation_replay` SET `memory_activation_json` = 'null';
