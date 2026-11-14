// Step 9: the wear map (worn paths). Per map region a counter per tile, raised along every finished trip's tile path
// (computed on the server with the same A* the client uses: world.maps.tilePath), decaying about 3% per game day and
// persisted hourly (deflated bytes in wear_maps). The renderer turns it into trampled grass and dirt: real desire paths
// appear where people actually walk. A visual record only: never perceived, never in a prompt.
import { deflateSync, inflateSync } from 'node:zlib';

const STEP = 6;              // wear added per crossing
const DECAY_PER_DAY = 0.97;
const DECAY_EVERY = 10;      // game minutes
const SAVE_EVERY = 60;       // game minutes

export class Wear {
  constructor(world) {
    this.world = world;
    this.maps = new Map(); // mapId -> { w, h, data: Float32Array }
    this.lastDecay = null;
    this.lastSave = null;
    this.dirty = false;
  }

  #mapFor(mapId) {
    let m = this.maps.get(mapId);
    if (m) return m;
    const file = this.world.maps.maps.find((x) => x.id === mapId);
    if (!file) return null;
    const [w, h] = file.size;
    m = { w, h, data: new Float32Array(w * h) };
    this.maps.set(mapId, m);
    return m;
  }

  /** Load persisted wear (boot). A map whose size changed starts fresh. */
  load() {
    this.maps.clear();
    let rows = [];
    try { rows = this.world.db.prepare('SELECT map_id, w, h, data FROM wear_maps').all(); } catch { return; }
    for (const r of rows) {
      const m = this.#mapFor(r.map_id);
      if (!m || m.w !== r.w || m.h !== r.h) continue;
      try {
        const bytes = inflateSync(Buffer.from(r.data));
        for (let i = 0; i < Math.min(bytes.length, m.data.length); i++) m.data[i] = bytes[i];
      } catch { /* a broken row: start fresh */ }
    }
  }

  /** A finished trip: raise the wear along its tile path (teleports leave no trace). */
  onTrip(_citizen, trip) {
    if (!trip?.path?.length || trip.kind === 'teleport') return;
    const mapId = this.world.maps.mapOf(trip.toRoom) ?? this.world.maps.mapOf(trip.fromRoom);
    const m = mapId && this.#mapFor(mapId);
    if (!m) return;
    for (const [x, y] of trip.path) {
      if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
      const i = y * m.w + x;
      m.data[i] = Math.min(255, m.data[i] + STEP);
    }
    this.dirty = true;
  }

  /** Every clock tick (game minutes): decay a little every 10 game minutes, save every game hour. */
  tick(now) {
    this.lastDecay ??= now;
    this.lastSave ??= now;
    const since = now - this.lastDecay;
    if (since >= DECAY_EVERY) {
      const f = Math.pow(DECAY_PER_DAY, since / 1440);
      for (const m of this.maps.values()) for (let i = 0; i < m.data.length; i++) { const v = m.data[i] * f; m.data[i] = v < 0.5 ? 0 : v; }
      this.lastDecay = now;
      this.dirty = true;
    }
    if (now - this.lastSave >= SAVE_EVERY) { this.save(now); this.lastSave = now; }
  }

  save(now = this.world.now) {
    if (!this.dirty) return;
    const stmt = this.world.db.prepare('INSERT INTO wear_maps (map_id, w, h, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(map_id) DO UPDATE SET w = excluded.w, h = excluded.h, data = excluded.data, updated_at = excluded.updated_at');
    for (const [mapId, m] of this.maps) {
      const bytes = Uint8Array.from(m.data, (v) => Math.round(v));
      stmt.run(mapId, m.w, m.h, deflateSync(bytes), now);
    }
    this.dirty = false;
  }

  /** GET /api/wear → { maps: [{ mapId, w, h, wear: number[] (row-major, 0..255) }] } */
  view() {
    return { maps: [...this.maps].map(([mapId, m]) => ({ mapId, w: m.w, h: m.h, wear: Array.from(m.data, (v) => Math.round(v)) })) };
  }
}
