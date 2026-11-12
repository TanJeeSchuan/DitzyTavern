UPDATE message_variant_data SET value = json_set(value, '$.ask', '') WHERE namespace = 'painting';
