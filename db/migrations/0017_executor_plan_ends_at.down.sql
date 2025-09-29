DROP INDEX IF EXISTS executor_plans_ends_idx;

ALTER TABLE executor_plans
  DROP COLUMN IF EXISTS ends_at;
