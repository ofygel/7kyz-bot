ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS bound_chat_id BIGINT,
  ADD COLUMN IF NOT EXISTS type TEXT CHECK (type IN ('orders','drivers','moderators'));

COMMENT ON COLUMN channels.bound_chat_id IS 'id чата, к которому привязан бот';
