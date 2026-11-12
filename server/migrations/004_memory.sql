-- Step 4: model routing info on LLM calls, memories, directed relationships, nightly consolidations.

ALTER TABLE llm_calls ADD COLUMN profile TEXT;
ALTER TABLE llm_calls ADD COLUMN tier TEXT;
CREATE INDEX IF NOT EXISTS idx_llm_time ON llm_calls (real_time);

-- Subjective memories, first person, from the citizen's perspective.
CREATE TABLE memories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id    TEXT NOT NULL,
  game_time     REAL NOT NULL,              -- when it happened (or was learned)
  kind          TEXT NOT NULL,              -- episodic | reflection | secondhand | consolidated | seed
  text          TEXT NOT NULL,
  importance    REAL NOT NULL,              -- 1–10
  strength      REAL NOT NULL DEFAULT 1.0,  -- 0–1, decays
  about         TEXT NOT NULL DEFAULT '[]', -- JSON array of citizen ids
  place_id      TEXT,
  source        TEXT NOT NULL DEFAULT '{}', -- JSON: { eventIds, conversationId, toldBy, gated }
  status        TEXT NOT NULL DEFAULT 'active', -- active | merged | forgotten
  merged_into   INTEGER,
  is_gist       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_mem_citizen ON memories (citizen_id, status, game_time);

-- Directed and subjective: (citizen_id → other_id) is how citizen_id sees other_id. No row = a stranger.
CREATE TABLE relationships (
  citizen_id      TEXT NOT NULL,
  other_id        TEXT NOT NULL,
  affinity        REAL NOT NULL DEFAULT 0,   -- -5..5
  trust           REAL NOT NULL DEFAULT 0,   -- -5..5
  familiarity     REAL NOT NULL DEFAULT 0,   -- 0..10
  name_known      INTEGER NOT NULL DEFAULT 0,
  name_confidence REAL NOT NULL DEFAULT 0,   -- 0..1
  last_seen_at    REAL,
  last_seen_place TEXT,
  summary         TEXT,                      -- 1–2 sentences, their words
  updated_at      REAL,
  PRIMARY KEY (citizen_id, other_id)
);

-- What each night's sleep consolidation did (core memory diff, merges, fades, gists, summaries).
CREATE TABLE consolidations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id  TEXT NOT NULL,
  game_time   REAL NOT NULL,
  data        TEXT NOT NULL
);
CREATE INDEX idx_consol_citizen ON consolidations (citizen_id, id);
