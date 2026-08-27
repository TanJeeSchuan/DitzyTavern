ALTER TABLE `active_generation` ADD `prior_variant_id` integer REFERENCES message_variant(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `conversation_generation_settings` ADD `sibling_generation_limit` integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE `conversation_generation_settings` ADD `continuation_prefill_suffix` text DEFAULT '' NOT NULL;
