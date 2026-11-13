// Step 9: the wear map (worn paths). STUB: the task "server-wear" implements it.
// Per map region a counter per tile, incremented along every finished trip's server-computed tile path, decaying a few
// percent per game day, persisted hourly. Visual record only: never perceived by citizens, never in a prompt.
export class Wear {
  constructor(world) {
    this.world = world;
  }

  /** Load persisted wear (boot). */
  load() {}

  /** A finished trip: trip = { kind: 'room'|'spot'|'teleport', fromRoom, fromSpot, toRoom, toSpot, path: [[x, y], ...]|null } */
  onTrip(_citizen, _trip) {}

  /** Called every clock tick with game minutes; decays and persists on its own schedule. */
  tick(_now) {}

  /** GET /api/wear → { maps: [{ mapId, w, h, wear: number[] (row-major, 0..255) }] } */
  view() {
    return { maps: [] };
  }
}
