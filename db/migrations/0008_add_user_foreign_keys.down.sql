ALTER TABLE user_recent_locations
  DROP CONSTRAINT IF EXISTS user_recent_locations_user_fk;

ALTER TABLE ui_events
  DROP CONSTRAINT IF EXISTS ui_events_user_fk;

ALTER TABLE user_experiments
  DROP CONSTRAINT IF EXISTS user_experiments_user_fk;

ALTER TABLE recent_actions
  DROP CONSTRAINT IF EXISTS recent_actions_user_fk;
