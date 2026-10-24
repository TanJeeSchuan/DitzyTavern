INSERT INTO `message_variant_data` (`message_variant_id`, `namespace`, `key`, `value`)
SELECT collection.variant_id, 'box:memory', 'record:' || instance.value,
	CASE
		WHEN collection.ownership = 'writer' THEN json_object('writer', json_object('claims', json(collection.claims_json)), 'source', collection.source_hash)
		WHEN collection.status = 'complete' THEN json_object('automatic', json_object('claims', json(collection.claims_json)), 'source', collection.source_hash)
		ELSE json_object('error', json_object('source', collection.source_hash, 'message', coalesce(collection.error, 'Memory extraction failed.')))
	END
FROM `memory_collection` collection
JOIN `conversation_data` instance ON instance.conversation_id = collection.conversation_id AND instance.namespace = 'box:memory' AND instance.key = 'instance'
WHERE collection.ownership = 'writer' OR collection.status IN ('complete', 'failed')
ON CONFLICT DO NOTHING;--> statement-breakpoint
DROP TABLE `memory_collection`;--> statement-breakpoint
DROP TABLE `memory_catchup_run`;--> statement-breakpoint
DELETE FROM `message_variant_data` WHERE `namespace` = 'generation-memory' AND `key` = 'activation';--> statement-breakpoint
UPDATE `active_generation` SET `memory_activation_json` = 'null';--> statement-breakpoint
UPDATE `generation_replay` SET `memory_activation_json` = 'null';
