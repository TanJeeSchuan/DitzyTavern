CREATE TABLE `__new_conversation_generation_settings` (
	`conversation_id` integer PRIMARY KEY NOT NULL,
	`connection_profile_id` integer,
	`settings_json` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_profile_id`) REFERENCES `connection_profile`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_conversation_generation_settings` (conversation_id, connection_profile_id, settings_json)
SELECT conversation_id, connection_profile_id, json_object(
	'modelId', model_id,
	'temperature', temperature,
	'topP', top_p,
	'frequencyPenalty', frequency_penalty,
	'presencePenalty', presence_penalty,
	'contextLimit', context_limit,
	'responseBudget', response_budget,
	'safetyAllowance', safety_allowance,
	'siblingGenerationLimit', sibling_generation_limit,
	'continuationStrategy', continuation_strategy,
	'continuationInstruction', continuation_instruction,
	'continuationPrefillSuffix', continuation_prefill_suffix,
	'repeatedImagePlacement', repeated_image_placement,
	'requestOverrides', json(request_overrides_json)
)
FROM `conversation_generation_settings`;
--> statement-breakpoint
DROP TABLE `conversation_generation_settings`;
--> statement-breakpoint
ALTER TABLE `__new_conversation_generation_settings` RENAME TO `conversation_generation_settings`;
