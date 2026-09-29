ALTER TABLE `conversation_memory_settings` ADD `label_merges` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
UPDATE memory_collection SET source_snapshot_json = json_set(
	source_snapshot_json,
	'$.source.speaker', (SELECT author_name FROM messages WHERE id = memory_collection.message_id),
	'$.context', json((SELECT json_group_array(json_set(entry.value, '$.speaker',
		(SELECT author_name FROM messages WHERE id = json_extract(entry.value, '$.messageId'))
	)) FROM json_each(memory_collection.source_snapshot_json, '$.context') AS entry))
);
