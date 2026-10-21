INSERT INTO `library_data` (`namespace`, `key`, `value`)
SELECT 'box:memory', 'settings', json_object(
	'extractionProfileId', extraction_profile_id, 'extractionModel', extraction_model,
	'contextLimit', context_limit, 'outputReserve', output_reserve, 'safetyAllowance', safety_allowance,
	'retainProbabilityMinimum', retain_probability_minimum, 'recallRelevanceMinimum', recall_relevance_minimum,
	'embeddingProfileId', embedding_profile_id, 'embeddingModel', embedding_model)
FROM `memory_settings` WHERE id = 1
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO `library_data` (`namespace`, `key`, `value`)
SELECT 'box-decision', 'memory', json_object(
	'decisionProfileId', decision_profile_id, 'decisionModel', decision_model, 'decisionStateTokenLimit', decision_state_token_limit)
FROM `memory_settings` WHERE id = 1
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO `conversation_data` (`conversation_id`, `namespace`, `key`, `value`)
SELECT conversation_id, 'box:memory', 'settings', json_object('allowance', allowance, 'note', memory_note)
FROM `conversation_memory_settings` WHERE true
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO `conversation_data` (`conversation_id`, `namespace`, `key`, `value`)
SELECT conversation_id, 'box:memory', 'labels', json_object('identities', json(identities), 'merges', json(label_merges))
FROM `conversation_memory_settings` WHERE true
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO `conversation_data` (`conversation_id`, `namespace`, `key`, `value`)
SELECT id, 'box:author-note', 'enabled', 'true' FROM `conversation` WHERE true
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO `conversation_data` (`conversation_id`, `namespace`, `key`, `value`)
SELECT id, 'box:author-note', 'instance', lower(hex(randomblob(16))) FROM `conversation` WHERE true
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO `conversation_data` (`conversation_id`, `namespace`, `key`, `value`)
SELECT id, 'box:memory', 'enabled', CASE WHEN coalesce((SELECT enabled FROM memory_settings WHERE id = 1), 1) THEN 'true' ELSE 'false' END
FROM `conversation` WHERE true
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO `conversation_data` (`conversation_id`, `namespace`, `key`, `value`)
SELECT id, 'box:memory', 'instance', lower(hex(randomblob(16))) FROM `conversation` WHERE true
ON CONFLICT DO NOTHING;--> statement-breakpoint
DROP TABLE `conversation_memory_settings`;--> statement-breakpoint
DROP TABLE `memory_settings`;--> statement-breakpoint
ALTER TABLE `conversation_data` ADD `revision` integer DEFAULT 0 NOT NULL;
