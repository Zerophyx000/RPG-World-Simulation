// Step 8: where things ARE on the map. Pure functions over the map files and the world data, used by the renderer
// (browser and Node screenshots alike). The simulation only knows rooms and spots; this module turns them into pixels:
//   - a person at a spot stands on one of the spot's tiles (stable per person, spread so two people don't overlap)
//   - fixed furniture (listed in a spot's `objects`) takes tiles of that spot; loose things lie on the spot's other tiles;
//     things "on" something sit on top of it; things "in" a container are not drawn
//   - walking uses the A* path between two tile positions; the pace follows the game-minute duration of the walk
// Nothing here changes the world, and nothing here is ever shown to a citizen.
import { TILE, buildGrid, findPath, mapRooms, anchorTile, spotCenter, inRect } from './mapdata.js';
import { hash32 } from './rand.js';

const centreOfRect = (r) => [r.x + r.w / 2, r.y + r.h / 2];

export function createLayout(maps) {
  const grids = new Map();
  const rooms = new Map(); // roomId -> { map, grid, room, spots: Map }
  for (const map of maps) {
    const grid = buildGrid(map);
    grids.set(map.id, grid);
    for (const room of mapRooms(map)) rooms.set(room.roomId, { map, grid, room, spots: new Map((room.spots ?? []).map((s) => [s.id, s])) });
  }
  const pathCache = new Map();

  const geom = (roomId) => rooms.get(roomId) ?? null;

  /** Pixel position (feet) of a tile centre-bottom. */
  const tilePx = (tx, ty) => [tx * TILE + TILE / 2, ty * TILE + TILE - 4];

  /** The tile a person stands on at a spot: stable by key, spread over the spot's tiles. */
  function standTile(roomId, spotId, key, taken = null) {
    const g = geom(roomId);
    if (!g) return null;
    const spot = g.spots.get(spotId) ?? [...g.spots.values()].find((s) => s.default) ?? [...g.spots.values()][0];
    if (!spot) return centreOfRect(g.room.rect).map(Math.floor);
    const tiles = spot.tiles;
    const start = hash32(`${key}|${spot.id}`) % tiles.length;
    if (!taken) return tiles[start];
    // two people never share a tile: take the next free one (stable while the others stay put)
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[(start + i) % tiles.length];
      if (!taken.has(`${roomId}|${t[0]},${t[1]}`)) { taken.add(`${roomId}|${t[0]},${t[1]}`); return t; }
    }
    return tiles[start];
  }

  /** Feet position in pixels, plus the owning grid position. */
  function standPx(roomId, spotId, key, taken = null) {
    const t = standTile(roomId, spotId, key, taken);
    if (!t) return null;
    const h = hash32(`jit|${key}`);
    const [x, y] = tilePx(t[0], t[1]);
    return { x: x + ((h % 9) - 4), y: y - ((h >>> 4) % 5), tile: t };
  }

  /** Tile path between two tiles of the room's map (cached). */
  function route(mapId, a, b) {
    const k = `${mapId}|${a}|${b}`;
    if (pathCache.has(k)) return pathCache.get(k);
    const grid = grids.get(mapId);
    const p = grid ? findPath(grid, a, b) : null;
    if (pathCache.size > 2000) pathCache.clear();
    pathCache.set(k, p);
    return p;
  }

  /** A polyline in pixels from one tile to another (straight line when there is no path). */
  function polyline(mapId, a, b) {
    const p = route(mapId, a, b) ?? [a, b];
    return p.map(([x, y]) => tilePx(x, y));
  }

  /** The point at fraction `f` (0..1) along a polyline, and the direction of travel there. */
  function along(points, f) {
    if (points.length < 2) return { x: points[0][0], y: points[0][1], dir: 'down', moved: false };
    const seg = []; let total = 0;
    for (let i = 1; i < points.length; i++) { const d = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]); seg.push(d); total += d; }
    let want = Math.max(0, Math.min(1, f)) * total;
    for (let i = 0; i < seg.length; i++) {
      if (want <= seg[i] || i === seg.length - 1) {
        const t = seg[i] ? want / seg[i] : 0;
        const [ax, ay] = points[i]; const [bx, by] = points[i + 1];
        const dx = bx - ax; const dy = by - ay;
        return { x: ax + dx * t, y: ay + dy * t, dir: Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'), moved: true };
      }
      want -= seg[i];
    }
    return { x: points.at(-1)[0], y: points.at(-1)[1], dir: 'down', moved: false };
  }

  /**
   * Where a citizen is drawn: { x, y, dir, moving, roomId, tile }.
   * `now` = game minutes (interpolated by the client). activity as in the citizen summary.
   */
  function citizenPlace(c, now, prevDir = 'down', taken = null) {
    const key = c.id;
    const a = c.activity ?? {};
    const d = a.detail ?? {};
    if (a.type === 'moving' && d.from && d.to) {
      const gf = geom(d.from); const gt = geom(d.to);
      const mapId = gf?.map.id;
      if (gf && gt && gt.map.id === mapId) {
        const start = d.fromSpot ? standTile(d.from, d.fromSpot, key) : (anchorTile(gf.room, d.to) ?? standTile(d.from, null, key));
        const outA = anchorTile(gf.room, d.to) ?? start;
        const inA = anchorTile(gt.room, d.from) ?? standTile(d.to, null, key);
        const end = standTile(d.to, gt.map ? (gt.room.entries?.[d.from] ?? null) : null, key);
        const pts = [...polyline(mapId, start, outA), ...polyline(mapId, outA, inA).slice(1), ...polyline(mapId, inA, end).slice(1)];
        const span = Math.max(0.2, (a.until ?? now) - (d.legStart ?? a.since ?? now));
        const f = (now - (d.legStart ?? a.since ?? now)) / span;
        const at = along(pts, f);
        return { x: at.x, y: at.y, dir: at.moved ? at.dir : prevDir, moving: true, roomId: f < 0.5 ? d.from : d.to, tile: null };
      }
    }
    const roomId = c.location;
    if (!geom(roomId)) return null;
    if (a.type === 'doing' && d.kind === 'walk' && d.fromSpot && d.toSpot) {
      const g = geom(roomId);
      const from = standTile(roomId, d.fromSpot, key); const to = standTile(roomId, d.toSpot, key);
      const span = Math.max(0.1, d.minutes ?? ((a.until ?? now) - (a.since ?? now)));
      const f = (now - (a.since ?? now)) / span;
      const at = along(polyline(g.map.id, from, to), f);
      return { x: at.x, y: at.y, dir: at.moved ? at.dir : prevDir, moving: true, roomId, tile: null };
    }
    const p = standPx(roomId, c.spot, key, taken);
    return p ? { x: p.x, y: p.y, dir: prevDir, moving: false, roomId, tile: p.tile } : null;
  }

  /**
   * Positions of the objects of one room: Map id -> { x, y, z (draw order), onTop }.
   * `list` = object views in the room (holderId null), `sprites(o)` = { w, h } of the sprite (the layout asks for sizes
   * so fixed furniture takes the tiles it needs).
   */
  function placeObjects(roomId, list, spriteSize) {
    const g = geom(roomId);
    const out = new Map();
    if (!g) return out;
    const used = new Set();
    const spotOf = new Map(); // object id -> spot id
    for (const s of g.spots.values()) for (const id of s.objects ?? []) spotOf.set(id, s.id);
    const byId = new Map(list.map((o) => [o.id, o]));
    const defaultSpot = [...g.spots.values()].find((s) => s.default)?.id ?? [...g.spots.keys()][0];
    const spotFor = (o, depth = 0) => {
      if (spotOf.has(o.id)) return spotOf.get(o.id);
      const of = o.placement?.of && byId.get(o.placement.of);
      return of && depth < 5 ? spotFor(of, depth + 1) : defaultSpot;
    };
    const sorted = [...list].sort((a, b) => (spotOf.has(b.id) ? 1 : 0) - (spotOf.has(a.id) ? 1 : 0) || a.id.localeCompare(b.id));
    const surface = [];
    for (const o of sorted) {
      if (o.holderId || o.placement?.relation === 'in' || o.placement?.relation === 'worn') continue;
      if (['on', 'beside'].includes(o.placement?.relation) && o.placement?.of && byId.has(o.placement.of)) { surface.push(o); continue; }
      const spot = g.spots.get(spotFor(o));
      if (!spot) continue;
      const size = spriteSize(o) ?? { w: 24, h: 24 };
      const wTiles = Math.max(1, Math.ceil(size.w / TILE));
      const tiles = [...spot.tiles].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      const fixed = spotOf.has(o.id);
      let pick = null;
      if (fixed) {
        // furniture: the first free run of tiles in the spot (back row first)
        pick = tiles.find(([x, y]) => Array.from({ length: wTiles }, (_, i) => i).every((i) => !used.has(`${x + i},${y}`) && tiles.some((t) => t[0] === x + i && t[1] === y)));
      }
      if (!pick) {
        const free = tiles.filter(([x, y]) => !used.has(`${x},${y}`));
        const pool = free.length ? free : tiles;
        pick = pool[hash32(o.id) % pool.length];
      }
      const run = fixed ? wTiles : 1;
      for (let i = 0; i < run; i++) used.add(`${pick[0] + i},${pick[1]}`);
      const [px, py] = tilePx(pick[0], pick[1]);
      const jx = fixed ? 0 : (hash32(`ox${o.id}`) % 13) - 6;
      out.set(o.id, { x: px + (fixed ? ((wTiles - 1) * TILE) / 2 : jx), y: py + (fixed ? 0 : ((hash32(`oy${o.id}`) % 7) - 3)), onTop: false, fixed, spot: spot.id });
    }
    // things on top of / beside others
    for (const o of surface) {
      const base = out.get(o.placement.of);
      if (!base) {
        const spot = g.spots.get(spotFor(o)); if (!spot) continue;
        const t = spot.tiles[hash32(o.id) % spot.tiles.length]; const [px, py] = tilePx(t[0], t[1]);
        out.set(o.id, { x: px, y: py, onTop: false, fixed: false, spot: spot.id });
        continue;
      }
      const on = o.placement.relation === 'on';
      const sz = spriteSize(byId.get(o.placement.of)) ?? { w: 24, h: 24 };
      const n = [...out.values()].filter((v) => v.baseId === o.placement.of).length;
      out.set(o.id, { x: base.x + (on ? ((n % 3) - 1) * 8 : (sz.w / 2 + 8 + n * 6)), y: base.y - (on ? Math.round(sz.h * 0.45) : 0), onTop: on, fixed: false, spot: base.spot, baseId: o.placement.of });
    }
    return out;
  }

  return { grids, rooms, geom, standTile, standPx, tilePx, route, polyline, along, citizenPlace, placeObjects, inRect };
}

export { spotCenter };
