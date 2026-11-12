-- Step 2.5: observer reports (out-of-world summaries for the UI only; never shown to citizens).
-- Each row holds the FULL merged report, so the UI time slider can just load rows.
CREATE TABLE observer_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  game_time     REAL NOT NULL,
  real_time     TEXT NOT NULL,
  last_event_id INTEGER NOT NULL,   -- events covered up to here
  data          TEXT NOT NULL       -- full merged report JSON: { headline, relationships, threads }
);
