-- Run ONCE to add the upcoming-shows list (safe to re-run):
--   npx wrangler d1 execute show-pos-db --remote --file=migrations/004_upcoming_shows.sql
-- Shows planned ahead of time. Starting one moves it into `shows`.
CREATE TABLE IF NOT EXISTS upcoming_shows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  show_date TEXT NOT NULL,             -- YYYY-MM-DD
  start_time TEXT NOT NULL DEFAULT '', -- HH:MM (24h), optional
  end_time TEXT NOT NULL DEFAULT ''    -- HH:MM (24h), optional
);
