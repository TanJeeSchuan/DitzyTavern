-- Every Conversation owns a generation-settings row. Older databases were
-- allowed to omit it, so backfill them before reads become side-effect free.
INSERT INTO `conversation_generation_settings` (`chat_id`)
SELECT `chat`.`id`
FROM `chat`
WHERE NOT EXISTS (
	SELECT 1
	FROM `conversation_generation_settings`
	WHERE `conversation_generation_settings`.`chat_id` = `chat`.`id`
);
