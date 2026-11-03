-- The Race's records changed shape when it became a sandboxed Box: each now adds at most one replay entry instead of copying the replay. Its old records, Writer overrides included, are cleared rather than migrated.
DELETE FROM `message_variant_data` WHERE `namespace` = 'box:race' AND `key` LIKE 'record:%';--> statement-breakpoint
UPDATE `active_generation` SET `box_records_json` = json_remove(`box_records_json`, '$.race') WHERE json_type(`box_records_json`, '$.race') IS NOT NULL;
