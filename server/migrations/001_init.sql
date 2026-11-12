-- Initial schema. Do not edit after it has run on a real world: add 002_*.sql instead.
--
-- Pattern used throughout: a few real columns for things we query/filter on,
-- plus a `data` JSON column for everything else. New fields can then be added
-- in code without a migration, and old rows just get defaults when read.

-- Key/value store for global world state (clock, settings, counters).
CREATE TABLE world_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL            -- JSON
);

-- Citizens (LLM-driven), shadow NPCs and the player's avatar all live here.
CREATE TABLE citizens (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'citizen',   -- citizen | shadow | avatar
  alive       INTEGER NOT NULL DEFAULT 1,
  location    TEXT,
  born_at     REAL,                              -- game minutes
  died_at     REAL,
  data        TEXT NOT NULL DEFAULT '{}'         -- JSON: personality, stats, needs, emotions...
);

-- Append-only world log: everything that happens. Source for timelines, memories, replays.
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_time   REAL NOT NULL,
  real_time   TEXT NOT NULL,
  type        TEXT NOT NULL,
  actor_id    TEXT,
  location    TEXT,
  data        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_events_time  ON events (game_time);
CREATE INDEX idx_events_actor ON events (actor_id, game_time);

-- Every LLM call, including the model's thinking. This is what the inspector shows.
CREATE TABLE llm_calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  real_time    TEXT NOT NULL,
  game_time    REAL,
  citizen_id   TEXT,
  purpose      TEXT NOT NULL,
  model        TEXT,
  request      TEXT NOT NULL,      -- JSON (messages, tools)
  reasoning    TEXT,               -- the model's thinking
  content      TEXT,               -- the final answer
  tool_calls   TEXT,               -- JSON
  status       TEXT NOT NULL,      -- ok | error | aborted
  error        TEXT,
  duration_ms  INTEGER,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER
);
CREATE INDEX idx_llm_citizen ON llm_calls (citizen_id, id);
