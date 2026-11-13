-- Step 6: emotion history for the UI, and the emotional colour of memories.

CREATE TABLE emotion_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id  TEXT NOT NULL,
  game_time   REAL NOT NULL,
  kind        TEXT NOT NULL,     -- sample | bump | decay_out | mood
  data        TEXT NOT NULL      -- JSON: entries snapshot + mood, or the single change (type, target, delta, source, cause, rule)
);
CREATE INDEX idx_emolog ON emotion_log (citizen_id, game_time);

-- The dominant emotion a memory was laid down with, and its sign (-1..1).
ALTER TABLE memories ADD COLUMN emotion TEXT;
ALTER TABLE memories ADD COLUMN valence REAL;
