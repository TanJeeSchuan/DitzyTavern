ALTER TABLE `prompt_preset_block` ADD `role` text;--> statement-breakpoint
-- The outgoing role each Definition reference assembles with. These are the
-- roles the established assembly already used, so existing recipes keep
-- producing the requests they produced before the column existed. History
-- rows stay null: their entries carry the roles of their own Messages.
UPDATE `prompt_preset_block` SET `role` = CASE `reference`
	WHEN 'model-system-instruction' THEN 'system'
	WHEN 'human-identity' THEN 'user'
	WHEN 'model-identity' THEN 'assistant'
	WHEN 'model-scenario' THEN 'system'
	WHEN 'model-example-dialogue' THEN 'user'
	WHEN 'model-post-history-instruction' THEN 'system'
END
WHERE `reference` <> 'history';
