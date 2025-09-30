ALTER TABLE executor_plans
  DROP COLUMN IF EXISTS card_message_id,
  DROP COLUMN IF EXISTS card_chat_id;
