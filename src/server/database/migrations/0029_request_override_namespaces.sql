UPDATE `conversation_generation_settings`
SET `request_overrides_json` = json_insert(`request_overrides_json`,
	'$."chat-completions"', json('{}'),
	'$.responses', json('{}'),
	'$."anthropic-messages"', json('{}'));
