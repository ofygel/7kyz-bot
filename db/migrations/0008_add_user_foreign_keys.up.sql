-- Enforce referential integrity for user-scoped auxiliary tables

ALTER TABLE recent_actions
  ADD CONSTRAINT recent_actions_user_fk
  FOREIGN KEY (user_id)
  REFERENCES users(tg_id)
  ON DELETE CASCADE;

ALTER TABLE user_experiments
  ADD CONSTRAINT user_experiments_user_fk
  FOREIGN KEY (user_id)
  REFERENCES users(tg_id)
  ON DELETE CASCADE;

ALTER TABLE ui_events
  ADD CONSTRAINT ui_events_user_fk
  FOREIGN KEY (user_id)
  REFERENCES users(tg_id)
  ON DELETE CASCADE;

ALTER TABLE user_recent_locations
  ADD CONSTRAINT user_recent_locations_user_fk
  FOREIGN KEY (user_id)
  REFERENCES users(tg_id)
  ON DELETE CASCADE;
