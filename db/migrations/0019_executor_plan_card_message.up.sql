ALTER TABLE executor_plans
  ADD COLUMN IF NOT EXISTS card_message_id INTEGER,
  ADD COLUMN IF NOT EXISTS card_chat_id BIGINT;
