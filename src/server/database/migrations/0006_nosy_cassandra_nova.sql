-- The authored instruction block's own metadata and text. Null on every
-- referenced occurrence: the preset stores references, never rendered
-- Participant or history content.
ALTER TABLE `prompt_preset_block` ADD `name` text;--> statement-breakpoint
ALTER TABLE `prompt_preset_block` ADD `content` text;