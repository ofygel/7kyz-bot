-- Legacy migration kept for existing databases.
-- The base schema (0001) now creates this index for new installations,
-- but running this migration remains safe thanks to IF NOT EXISTS and
-- ensures the index is added without locking on production data.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_scope_state_idx ON sessions (scope, scope_id);
