UPDATE message_variant_data SET value = json_set(value, '$.references', '') WHERE namespace = 'painting';
--> statement-breakpoint
UPDATE conversation_data SET value = json_set(value, '$.references', '') WHERE namespace = 'painting' AND key LIKE 'gallery:%' AND json_extract(value, '$.brief') IS NOT NULL;
