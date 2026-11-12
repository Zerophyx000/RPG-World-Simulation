-- Step 5: objects as real state (room state / ground truth) and their history.
-- Object TYPES are content (content/object-types.json, loaded on every boot); instances are state.

CREATE TABLE objects (
  id                TEXT PRIMARY KEY,           -- 'bakery_flour_1'
  type_id           TEXT NOT NULL,
  name              TEXT,                       -- instance name override: "Greta's flour sack"
  room_id           TEXT,                       -- where it is (null if carried)
  holder_id         TEXT,                       -- citizen carrying it (null if in a room)
  placement         TEXT NOT NULL DEFAULT '{}', -- JSON: { relation: 'on'|'in'|'behind'|'under'|'beside'|'floor', of: objectId|null }
  state             TEXT NOT NULL,
  visibility        TEXT NOT NULL DEFAULT 'obvious', -- obvious | noticeable | hidden
  search_difficulty INTEGER NOT NULL DEFAULT 0, -- 0–10; only matters when hidden
  owner_id          TEXT,                       -- optional: whose it is
  surface_text      TEXT,                       -- how it looks at a glance (null = the type template)
  true_text         TEXT,                       -- what it really is / its real condition
  origin            TEXT NOT NULL,              -- content | director | code (never citizen)
  data              TEXT NOT NULL DEFAULT '{}',
  updated_at        REAL
);
CREATE INDEX idx_objects_room ON objects (room_id);
CREATE INDEX idx_objects_holder ON objects (holder_id);

CREATE TABLE object_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  object_id   TEXT NOT NULL,
  game_time   REAL NOT NULL,
  actor_id    TEXT,                 -- citizen id, 'director', 'code', 'keeper'
  action      TEXT NOT NULL,        -- take | put | give | use | state | conceal | reveal | move | seed | create | reset | edit
  before      TEXT NOT NULL,        -- JSON snapshot (room, holder, placement, state, visibility)
  after       TEXT NOT NULL,
  witnesses   TEXT NOT NULL DEFAULT '[]'  -- citizen ids who perceived it
);
CREATE INDEX idx_objhist_object ON object_history (object_id, game_time);
