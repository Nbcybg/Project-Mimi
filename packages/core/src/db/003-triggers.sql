-- Schema v3: what the scheduler needs to survive restarts.

ALTER TABLE triggers ADD COLUMN title TEXT NOT NULL DEFAULT '';
-- When the trigger fires next (UTC). NULL once it is done. The scheduler only compares
-- this column with the clock, so a restart picks up exactly where it stopped.
ALTER TABLE triggers ADD COLUMN next_fire_at TEXT;
ALTER TABLE triggers ADD COLUMN last_fired_at TEXT;
-- Outcome of the last firing: the agent's answer for agent tasks, or an error.
ALTER TABLE triggers ADD COLUMN last_result TEXT;
CREATE INDEX idx_triggers_next ON triggers (status, next_fire_at);
