// Step 9: lasting marks (decals). STUB: the task "server-decals" implements it.
// Soot, scorch and rubble from blasts and fires, puddles from rain, bloodstains: position, kind, intensity, creation time,
// persisted, fading by game time (blood lasts longer on wood and stone). Visual record only.
export class Decals {
  constructor(world) {
    this.world = world;
  }

  load() {}

  /** A lasting room effect was added (director event). */
  onRoomEffect(_room, _effect, _info) {}

  /** Add a mark directly: { kind, roomId, spot?, x?, y?, r?, intensity?, source? } → the decal or null. */
  add(_mark) {
    return null;
  }

  tick(_now) {}

  /** GET /api/decals → [{ id, mapId, roomId, kind, x, y, r, intensity, createdAt, surface }] (faded marks left out) */
  list() {
    return [];
  }
}
