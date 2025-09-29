ALTER TABLE executor_plans
  DROP CONSTRAINT IF EXISTS executor_plans_plan_choice_check;

ALTER TABLE executor_plans
  ADD CONSTRAINT executor_plans_plan_choice_check
    CHECK (plan_choice IN ('trial','7','15','30'));
