UPDATE message_variant_data SET value = json_set(value, '$.references', '') WHERE namespace = 'painting';
--> statement-breakpoint
UPDATE conversation_data SET value = json_set(value, '$.references', '') WHERE namespace = 'painting' AND key LIKE 'gallery:%';
