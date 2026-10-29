ALTER TABLE `messages` ADD `author_role` text;
--> statement-breakpoint
UPDATE messages SET author_role = CASE
  WHEN author_participant_id = context_model_participant_id THEN 'model'
  WHEN author_participant_id = context_human_participant_id THEN 'human'
  WHEN author_participant_id = (SELECT participant_id FROM conversation_control WHERE conversation_id = messages.conversation_id AND seat = 'model') THEN 'model'
  WHEN author_participant_id = (SELECT participant_id FROM conversation_control WHERE conversation_id = messages.conversation_id AND seat = 'human') THEN 'human'
END;
