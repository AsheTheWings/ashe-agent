-- A turn starts from an input of user messages, developer components, or
-- both: `cause` says what started it, and `user_message_ids` lists, as a
-- JSON array, the ids of the user messages its starting input holds.
ALTER TABLE turns DROP COLUMN input_id;
ALTER TABLE turns DROP COLUMN input_text;
ALTER TABLE turns ADD COLUMN cause TEXT NOT NULL DEFAULT 'user'
  CHECK (cause IN ('user', 'continuation', 'notification'));
ALTER TABLE turns ADD COLUMN user_message_ids TEXT NOT NULL DEFAULT '[]';
