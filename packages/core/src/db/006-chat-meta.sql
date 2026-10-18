-- Schema v6: messages can answer another message (reply) or carry content that came
-- from somewhere else (forward).

ALTER TABLE messages ADD COLUMN reply_to INTEGER;
ALTER TABLE messages ADD COLUMN forward_from TEXT;
ALTER TABLE messages ADD COLUMN forward_chat TEXT;
