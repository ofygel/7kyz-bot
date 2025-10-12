-- migrate:down transaction:false
DROP INDEX CONCURRENTLY IF EXISTS orders_active_by_executor_idx;

-- Removing enum values is unsafe; down migration intentionally leaves the type as-is.
