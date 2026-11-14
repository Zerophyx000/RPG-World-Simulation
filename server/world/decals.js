// Step 9: lasting marks on the map (decals). Soot, scorch and rubble after blasts and fires, puddles after rain,
// bloodstains where someone bled. Each mark has a position (world px), a kind, an intensity and a creation time, is
// persisted (table decals) and fades by game time: soot 3 days, scorch 5, rubble 4, puddles a few hours (they shrink
// while they dry), blood 6 days on wood, stone and cobbles but 2 on grass and dirt. A visual record only.
import { TILE } from '../../public/art/mapdata.js';
import { hash32 } from '../../public/art/rand.js';

const DAY = 1440;
const LIFE = { soot: 3 * DAY, scorch: 5 * DAY, rubble: 4 * DAY, puddle: 4 * 60 };
const RADIUS = { soot: 14, scorch: 10, rubble: 12, puddle: 14, blood: 10 };
const SURFACE = { wood_floor: 'wood', stone_floor: 'stone', cobble: 'cobble', grass: 'grass', dirt: 'dirt', dirt_path: 'dirt' };
const MAX = 400;

export class Decals {
  constructor(world) {
    this.world = world;
    this.marks = [];
    this.lastSweep = null;
    this.seq = 0;
  }

  load() {
    try {
      this.marks = this.world.db.prepare('SELECT * FROM decals ORDER BY created_at').all()
        .map((r) => ({ id: r.id, mapId: r.map_id, roomId: r.room_id, kind: r.kind, x: r.x, y: r.y, r: r.r, intensity: r.intensity, surface: r.surface, source: r.source, createdAt: r.created_at }));
    } catch { this.marks = []; }
  }

  #lifetime(m) {
    if (m.kind === 'blood') return ['wood', 'stone', 'cobble'].includes(m.surface) ? 6 * DAY : 2 * DAY;
    return LIFE[m.kind] ?? 3 * DAY;
  }

  #current(m, now) {
    return Math.max(0, m.intensity * (1 - (now - m.createdAt) / this.#lifetime(m)));
  }

  /** Add a mark: { kind, roomId, spot?, x?, y?, r?, intensity = 1, source? } → the decal, or null without a map. */
  add({ kind, roomId, spot = null, x = null, y = null, r = null, intensity = 1, source = null }) {
    const maps = this.world.maps;
    const mapId = maps.mapOf(roomId);
    if (!mapId || !RADIUS[kind]) return null;
    const id = `d${Math.round(this.world.now)}-${(++this.seq).toString(36)}-${hash32(`${source}|${kind}|${this.seq}`).toString(36).slice(0, 4)}`;
    if (x == null || y == null) {
      const rect = maps.byRoom.get(roomId)?.room.rect;
      const t = (spot && maps.spotTile(roomId, spot)) || (rect ? [Math.floor(rect.x + rect.w / 2), Math.floor(rect.y + rect.h / 2)] : [0, 0]);
      // a seeded jitter inside the room, so several marks don't stack
      const h = hash32(id);
      let tx = t[0] + ((h % 5) - 2); let ty = t[1] + (((h >>> 4) % 5) - 2);
      if (rect) {
        const inset = maps.byRoom.get(roomId).room.kind === 'building' ? 1 : 0;
        tx = Math.max(rect.x + inset, Math.min(rect.x + rect.w - 1 - inset, tx)); ty = Math.max(rect.y + inset, Math.min(rect.y + rect.h - 1 - inset, ty));
      }
      x = tx * TILE + TILE / 2 + ((h >>> 8) % 13) - 6; y = ty * TILE + TILE / 2 + ((h >>> 12) % 9) - 4;
    }
    const grid = maps.grid(mapId);
    const ground = grid?.ground[Math.floor(y / TILE)]?.[Math.floor(x / TILE)];
    const m = { id, mapId, roomId, kind, x, y, r: r ?? RADIUS[kind], intensity: Math.max(0, Math.min(1, intensity)), surface: SURFACE[ground] ?? 'dirt', source, createdAt: this.world.now };
    this.marks.push(m);
    try {
      this.world.db.prepare('INSERT INTO decals (id, map_id, room_id, kind, x, y, r, intensity, surface, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(m.id, m.mapId, m.roomId, m.kind, m.x, m.y, m.r, m.intensity, m.surface, m.source, m.createdAt);
    } catch { /* the table is missing in an old test db: keep it in memory */ }
    while (this.marks.length > MAX) this.#remove(this.marks[0].id);
    return m;
  }

  #remove(id) {
    this.marks = this.marks.filter((m) => m.id !== id);
    try { this.world.db.prepare('DELETE FROM decals WHERE id = ?').run(id); } catch { /* ignore */ }
  }

  /** A lasting room effect was added (a director event): leave the marks its text describes. */
  onRoomEffect(room, effect) {
    const text = String(effect?.text ?? '');
    const src = effect?.id ?? null;
    const n = (a, b) => a + (hash32(`${src}|${a}|${b}`) % (b - a + 1));
    const many = (kind, count) => { for (let i = 0; i < count; i++) this.add({ kind, roomId: room.id, intensity: 0.8 + (i % 3) * 0.1, source: src }); };
    if (/explo|blast|blew/i.test(text)) { many('soot', n(3, 6)); many('scorch', n(1, 2)); many('rubble', n(2, 4)); }
    else if (/fire|burn|flames|ablaze/i.test(text)) { many('soot', n(2, 3)); many('scorch', 1); }
    else if (/smoke/i.test(text)) many('soot', n(1, 2));
    if (/rain|storm|downpour|puddle/i.test(text)) {
      const outdoor = (r) => (r.tags ?? []).includes('outdoor');
      const rooms = outdoor(room) ? [room] : [...this.world.rooms.values()].filter(outdoor);
      for (const r of rooms) for (let i = 0; i < n(1, 3); i++) this.add({ kind: 'puddle', roomId: r.id, source: src });
    }
    if (/blood/i.test(text)) this.add({ kind: 'blood', roomId: room.id, source: src });
  }

  /** Every clock tick: once a game hour, forget marks that have faded away. */
  tick(now) {
    this.lastSweep ??= now;
    if (now - this.lastSweep < 60) return;
    this.lastSweep = now;
    for (const m of [...this.marks]) if (this.#current(m, now) <= 0.01) this.#remove(m.id);
  }

  /** GET /api/decals → the marks still visible, with their intensity faded and drying puddles shrunk. */
  list() {
    const now = this.world.now;
    const out = [];
    for (const m of this.marks) {
      const intensity = this.#current(m, now);
      if (intensity <= 0.03) continue;
      out.push({ id: m.id, mapId: m.mapId, roomId: m.roomId, kind: m.kind, x: Math.round(m.x), y: Math.round(m.y), r: Math.round((m.kind === 'puddle' ? m.r * (0.3 + 0.7 * intensity) : m.r) * 10) / 10, intensity: Math.round(intensity * 100) / 100, createdAt: m.createdAt, surface: m.surface, source: m.source });
    }
    return out;
  }
}
