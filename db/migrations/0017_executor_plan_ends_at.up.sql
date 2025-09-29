ALTER TABLE executor_plans
  ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;

UPDATE executor_plans
SET ends_at = start_at
  + CASE plan_choice
      WHEN '7' THEN INTERVAL '7 days'
      WHEN '15' THEN INTERVAL '15 days'
      WHEN '30' THEN INTERVAL '30 days'
      ELSE INTERVAL '0 days'
    END
WHERE ends_at IS NULL;

CREATE INDEX IF NOT EXISTS executor_plans_ends_idx
  ON executor_plans (ends_at);

ALTER TABLE executor_plans
  ALTER COLUMN ends_at SET NOT NULL;
