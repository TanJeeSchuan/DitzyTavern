ALTER TABLE `conversation_memory_settings` ADD `label_merges` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
DELETE FROM `memory_collection`;