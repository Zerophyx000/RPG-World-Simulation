-- Step 5.5: trust with reasons, and groups.

-- Every relationship change, with the reason the citizen could name and the evidence behind it.
CREATE TABLE relationship_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id     TEXT NOT NULL,       -- whose view
  other_id       TEXT NOT NULL,
  game_time      REAL NOT NULL,
  source         TEXT NOT NULL,       -- reflection | witness | signal | first_impression | group | director | seed | consolidation
  d_affinity     REAL NOT NULL DEFAULT 0,
  d_trust        REAL NOT NULL DEFAULT 0,
  d_familiarity  REAL NOT NULL DEFAULT 0,
  reason         TEXT NOT NULL,       -- first person, short: "He lied to me about the mine entrance."
  evidence       TEXT NOT NULL DEFAULT '{}', -- JSON: { eventIds, objectIds, conversationId, memoryId, groupId, weight }
  strength       REAL NOT NULL DEFAULT 1.0   -- decays like memories
);
CREATE INDEX idx_relev_pair ON relationship_events (citizen_id, other_id, game_time);

CREATE TABLE groups (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,          -- family | household | village | guild | faction | party | gang
  public       INTEGER NOT NULL DEFAULT 1, -- is membership generally knowable?
  origin       TEXT NOT NULL,          -- content | director | code
  data         TEXT NOT NULL DEFAULT '{}', -- JSON: description, purpose, norms[], founderId, maxSize, wariness
  created_at   REAL,
  dissolved_at REAL
);

CREATE TABLE group_members (
  group_id   TEXT NOT NULL,
  citizen_id TEXT NOT NULL,
  role       TEXT,                  -- 'head', 'member', 'leader', 'sister', ...
  secret     INTEGER NOT NULL DEFAULT 0,  -- membership hidden even if the group is public
  joined_at  REAL,
  left_at    REAL,
  PRIMARY KEY (group_id, citizen_id, joined_at)
);
CREATE INDEX idx_group_members_citizen ON group_members (citizen_id);
