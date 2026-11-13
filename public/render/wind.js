// Step 9: wind. STUB: the task "ambient-life" implements it (a slowly changing value per region, stronger in rain).
/** → { x: -1..1 (direction and strength along x), strength: 0..1 } */
export function windAt(_mapId, _ms, _gameMinutes, _raining = false) {
  return { x: 0, strength: 0 };
}

/** Pixel offset for the crown of a tree / top of a bush / tall grass at a tile (0 = still). */
export function swayFor(_kind, _tx, _ty, _ms, _wind) {
  return 0;
}
