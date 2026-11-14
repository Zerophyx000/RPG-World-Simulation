-- Step 11: ambitions, schemes and deception. Code always knows the truth (lies.truth); listeners only what they were told.
CREATE TABLE IF NOT EXISTS ambitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  target_ids TEXT NOT NULL DEFAULT '[]',
  intensity REAL NOT NULL DEFAULT 5,
  secrecy TEXT NOT NULL DEFAULT 'private',
  status TEXT NOT NULL DEFAULT 'active',
  origin TEXT NOT NULL DEFAULT 'persona',
  created_at REAL,
  updated_at REAL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_ambitions_citizen ON ambitions (citizen_id, status);

CREATE TABLE IF NOT EXISTS schemes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  ambition_id INTEGER,
  goal TEXT NOT NULL,
  target_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'planning',
  steps TEXT NOT NULL DEFAULT '[]',
  accomplices TEXT NOT NULL DEFAULT '[]',
  exposed_to TEXT NOT NULL DEFAULT '[]',
  created_at REAL,
  updated_at REAL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_schemes_owner ON schemes (owner_id, status);

CREATE TABLE IF NOT EXISTS lies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  liar_id TEXT NOT NULL,
  game_time REAL NOT NULL,
  said TEXT NOT NULL,
  truth TEXT NOT NULL,
  why TEXT,
  kind TEXT NOT NULL DEFAULT 'other',
  check_who TEXT,
  check_where TEXT,
  check_from REAL,
  check_to REAL,
  about_ids TEXT NOT NULL DEFAULT '[]',
  scheme_id INTEGER,
  heard_by TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'standing',
  event_id INTEGER,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_lies_liar ON lies (liar_id, status);
