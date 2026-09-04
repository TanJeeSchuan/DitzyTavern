-- Custom SQL migration file, put your code below! --
-- The Prompt Plan's selected history and its authorship roles were two lists
-- aligned by index. They are now one ordered list of Prompt context entries,
-- each carrying its own role, so the column stores the whole writing context
-- rather than only the roles beside it.
ALTER TABLE `active_generation` RENAME COLUMN `history_roles_json` TO `prompt_context_json`;
--> statement-breakpoint
ALTER TABLE `generation_replay` RENAME COLUMN `history_roles_json` TO `prompt_context_json`;
