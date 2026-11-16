-- Step 9: lasting marks on the map (soot, scorch, rubble, puddles, blood). Fade by game time; a visual record only.
CREATE TABLE decals (
  id         TEXT PRIMARY KEY,
  map_id     TEXT,
  room_id    TEXT,
  kind       TEXT NOT NULL,      -- soot | scorch | rubble | puddle | blood
  x          REAL NOT NULL,      -- world px (centre)
  y          REAL NOT NULL,
  r          REAL NOT NULL,      -- px
  intensity  REAL NOT NULL,      -- 0..1 at creation
  surface    TEXT,               -- wood | stone | cobble | grass | dirt
  source     TEXT,               -- the room effect or bloodstain id that made it
  created_at REAL NOT NULL       -- game minutes
);
CREATE INDEX decals_created ON decals (created_at);
