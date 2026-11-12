-- Step 2: rooms + index for "who is where".
-- Room details (description, exits, tags, affordances) live in the `data` JSON column.
CREATE TABLE rooms (
  id    TEXT PRIMARY KEY,          -- 'tavern', 'square', ...
  name  TEXT NOT NULL,
  data  TEXT NOT NULL DEFAULT '{}' -- JSON: { description, exits: [{to, travelMinutes}], tags, affordances }
);
CREATE INDEX IF NOT EXISTS idx_citizens_location ON citizens (location);
