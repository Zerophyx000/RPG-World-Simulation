-- Step 7B: conditions (wounds, fractures, burns, infections, lasting effects) as database entries.
-- All writes go through world.body (change / damage / treat / heal); citizens never write here.
CREATE TABLE conditions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id       TEXT NOT NULL,
  type             TEXT NOT NULL,
  part_id          TEXT,                         -- null for systemic conditions (fever, chill)
  severity         REAL NOT NULL,                -- 1-10, goes down as it heals
  initial_severity REAL NOT NULL,
  bleeding         REAL NOT NULL DEFAULT 0,      -- current rate, % blood per game hour (cached)
  geometry         TEXT NOT NULL DEFAULT '{}',   -- { length_cm, depth, gape, area_cm2, vessel, internal }
  clot             REAL NOT NULL DEFAULT 0,      -- 0-1
  pain             REAL NOT NULL DEFAULT 0,      -- 0-10
  infection        REAL NOT NULL DEFAULT 0,      -- 0-1 progress toward infection
  treatments       TEXT NOT NULL DEFAULT '[]',   -- [{ method, by, quality, at }]
  flags            TEXT NOT NULL DEFAULT '{}',   -- { cleaned, bandaged, splinted, stitched, set, wrapped, tourniquet, cauterized, ... }
  healing          REAL NOT NULL DEFAULT 0,      -- 0-1
  permanent        INTEGER NOT NULL DEFAULT 0,
  curable_by       TEXT NOT NULL DEFAULT '[]',   -- tags of future cures that can remove a permanent condition
  visible          INTEGER NOT NULL DEFAULT 1,
  detect_difficulty INTEGER NOT NULL DEFAULT 0,  -- 0-10, for examine_person
  cause            TEXT NOT NULL,
  source_id        TEXT,
  onset_at         REAL NOT NULL,
  resolved_at      REAL
);
CREATE INDEX idx_cond_citizen ON conditions (citizen_id, resolved_at);
