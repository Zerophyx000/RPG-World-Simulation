-- Step 9: worn paths. One row per map region: a byte per tile (0..255), deflated. A visual record only.
CREATE TABLE wear_maps (
  map_id     TEXT PRIMARY KEY,
  w          INTEGER NOT NULL,
  h          INTEGER NOT NULL,
  data       BLOB NOT NULL,      -- deflated Uint8Array, row-major w*h
  updated_at REAL NOT NULL       -- game minutes
);
