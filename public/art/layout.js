// Step 8: where things ARE on the map. Pure functions over the map files and the world data, used by the renderer
// (browser and Node screenshots alike). The simulation only knows rooms and spots; this module turns them into pixels:
//   - fixed furniture (listed in a spot's `objects`, not portable) takes tiles at the back of its spot and BLOCKS them:
//     nobody stands on them and walks route around them; loose things lie on the spot's free tiles; things "on"
//     something sit on top of it; things "in" a container are not drawn
//   - doors and shutters are set into the wall: the room's door tile for its door, the back wall for the others
//   - a person at a spot stands on one of the spot's free tiles (stable per person, two people never share a tile)
//   - the simulation's position is a TARGET; a mover walks the drawn person there tile by tile (A* around walls and
//     furniture) at a walking pace, catching up when the target runs ahead, so nobody slides through things or jumps
// Nothing here changes the world, and nothing here is ever shown to a citizen.
import { TILE, buildGrid, findPath, mapRooms, anchorTile, spotCenter, inRect } from './mapdata.js';
import { hash32 } from './rand.js';

const centreOfRect = (r) => [r.x + r.w / 2, r.y + r.h / 2];
const WALL_TYPES = new Set(['door', 'shutters']);
export const WALK_SPEED = 64;      // px per real second at a normal walk (two tiles a second)
const SNAP_TILES = 30;             // further than this behind: jump (director moves, region changes, reloads)

export function createLayout(maps) {
  const grids = new Map();
  const rooms = new Map(); // roomId -> { map, grid, room, spots: Map }
  for (const map of maps) {
    const grid = buildGrid(map);
    grids.set(map.id, grid);
    for (const room of mapRooms(map)) rooms.set(room.roomId, { map, grid, room, spots: new Map((room.spots ?? []).map((s) => [s.id, s])) });
  }
  const pathCache = new Map();
  const blocked = new Map();       // roomId -> Set "x,y" (tiles under furniture)
  let blockRev = 0;
  const walkCache = new Map();     // mapId -> { rev, walk }

  const geom = (roomId) => rooms.get(roomId) ?? null;
  const isBlocked = (roomId, x, y) => blocked.get(roomId)?.has(`${x},${y}`) ?? false;

  /** Pixel position (feet) of a tile centre-bottom. */
  const tilePx = (tx, ty) => [tx * TILE + TILE / 2, ty * TILE + TILE - 4];
  const tileOf = (x, y) => [Math.floor(x / TILE), Math.floor(y / TILE)];

  /** The tiles people can stand on at a spot: its tiles minus furniture; if furniture fills it, the row in front. */
  function standable(roomId, spot) {
    const g = geom(roomId);
    const free = spot.tiles.filter(([x, y]) => !isBlocked(roomId, x, y));
    if (free.length) return free;
    const r = g.room.rect;
    const front = spot.tiles.map(([x, y]) => [x, y + 1]).filter(([x, y]) => inRect(r, x, y) && g.grid.walk[y]?.[x] && !isBlocked(roomId, x, y));
    return front.length ? front : spot.tiles;
  }

  /** The tile a person stands on at a spot: stable by key, spread over the spot's free tiles. */
  function standTile(roomId, spotId, key, taken = null) {
    const g = geom(roomId);
    if (!g) return null;
    const spot = g.spots.get(spotId) ?? [...g.spots.values()].find((s) => s.default) ?? [...g.spots.values()][0];
    if (!spot) return centreOfRect(g.room.rect).map(Math.floor);
    const tiles = standable(roomId, spot);
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
    return { x: x + ((h % 7) - 3), y: y - ((h >>> 4) % 4), tile: t };
  }

  /** The walk grid of a map with furniture tiles blocked (cached until the furniture changes). */
  function walkGrid(mapId) {
    const grid = grids.get(mapId);
    if (!grid) return null;
    const c = walkCache.get(mapId);
    if (c && c.rev === blockRev) return c.grid;
    const walk = grid.walk.map((row) => row.slice());
    for (const [roomId, set] of blocked) {
      if (geom(roomId)?.map.id !== mapId) continue;
      for (const k of set) { const [x, y] = k.split(',').map(Number); if (walk[y]) walk[y][x] = false; }
    }
    const g = { ...grid, walk };
    walkCache.set(mapId, { rev: blockRev, grid: g });
    return g;
  }

  /** Tile path between two tiles of a map, around walls and furniture (cached). Start and end may be blocked. */
  function route(mapId, a, b) {
    const k = `${mapId}|${blockRev}|${a}|${b}`;
    if (pathCache.has(k)) return pathCache.get(k);
    const grid = walkGrid(mapId);
    let p = null;
    if (grid) {
      const sa = grid.walk[a[1]]?.[a[0]]; const sb = grid.walk[b[1]]?.[b[0]];
      if (grid.walk[a[1]]) grid.walk[a[1]][a[0]] = true;
      if (grid.walk[b[1]]) grid.walk[b[1]][b[0]] = true;
      p = findPath(grid, a, b);
      if (grid.walk[a[1]]) grid.walk[a[1]][a[0]] = sa;
      if (grid.walk[b[1]]) grid.walk[b[1]][b[0]] = sb;
      if (!p) p = findPath(grids.get(mapId), a, b); // furniture closed the way: walk as if it weren't there
    }
    if (pathCache.size > 4000) pathCache.clear();
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
   * Where the simulation says a citizen is: { x, y, dir, moving, roomId, tile, mapId }. This is the TARGET of the mover.
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
        const end = standTile(d.to, gt.room.entries?.[d.from] ?? null, key);
        const pts = [...polyline(mapId, start, outA), ...polyline(mapId, outA, inA).slice(1), ...polyline(mapId, inA, end).slice(1)];
        const span = Math.max(0.2, (a.until ?? now) - (d.legStart ?? a.since ?? now));
        const f = (now - (d.legStart ?? a.since ?? now)) / span;
        const at = along(pts, f);
        return { x: at.x, y: at.y, dir: at.moved ? at.dir : prevDir, moving: true, roomId: f < 0.5 ? d.from : d.to, tile: null, mapId };
      }
    }
    const roomId = c.location;
    const g = geom(roomId);
    if (!g) return null;
    if (a.type === 'doing' && d.kind === 'walk' && d.fromSpot && d.toSpot) {
      // a walk inside the room: the target is where they are going; the mover provides the walking
      const p = standPx(roomId, d.toSpot, key, taken);
      return { x: p.x, y: p.y, dir: prevDir, moving: true, roomId, tile: p.tile, mapId: g.map.id };
    }
    const p = standPx(roomId, c.spot, key, taken);
    return p ? { x: p.x, y: p.y, dir: prevDir, moving: false, roomId, tile: p.tile, mapId: g.map.id } : null;
  }

  /**
   * A mover: the drawn position of one person, walking tile by tile toward the target the simulation gives.
   * mv = {} the first time (it snaps); returns mv with { x, y, dir, moving, dist (pixels walked, drives the walk cycle) }.
   */
  function stepMover(mv, target, dt, speedFactor = 1) {
    const tt = tileOf(target.x, target.y);
    const key = `${target.mapId}|${tt}|${target.moving ? 'm' : `${Math.round(target.x)},${Math.round(target.y)}`}`;
    const fresh = mv.x == null || mv.mapId !== target.mapId || Math.hypot(target.x - mv.x, target.y - mv.y) > SNAP_TILES * TILE;
    if (fresh) {
      Object.assign(mv, { x: target.x, y: target.y, path: [], goal: key, mapId: target.mapId, dir: target.dir ?? 'down', moving: false, dist: mv.dist ?? 0 });
      return mv;
    }
    if (mv.goal !== key) {
      mv.goal = key;
      const cur = tileOf(mv.x, mv.y);
      const p = route(target.mapId, cur, tt);
      const pts = (p ?? [cur, tt]).slice(1).map(([x, y]) => tilePx(x, y));
      // step onto the centre of the current tile first, so the walk runs along tile lines (not along a standing offset)
      const [cx0, cy0] = tilePx(cur[0], cur[1]);
      if (pts.length && (Math.abs(mv.x - cx0) > 0.5 || Math.abs(mv.y - cy0) > 0.5)) pts.unshift([cx0, cy0]);
      if (!target.moving) { if (pts.length) pts[pts.length - 1] = [target.x, target.y]; else pts.push([target.x, target.y]); }
      mv.path = pts;
    }
    let remaining = 0; let px = mv.x; let py = mv.y;
    for (const [x, y] of mv.path) { remaining += Math.abs(x - px) + Math.abs(y - py); px = x; py = y; }
    const speed = Math.max(WALK_SPEED * speedFactor, remaining / 1.5); // catch up in about 1.5 s when the target ran ahead
    let budget = speed * dt; let moved = 0;
    while (budget > 0.0001 && mv.path.length) {
      const [x, y] = mv.path[0];
      // tile-based: first along x or y, never diagonally through a corner (only the last, exact step may be diagonal)
      const dx = x - mv.x; const dy = y - mv.y;
      const axisX = Math.abs(dx) > 0.01 && (Math.abs(dy) < 0.01 || mv.path.length > 1 || Math.abs(dx) >= Math.abs(dy));
      const d = axisX ? Math.abs(dx) : Math.abs(dy);
      if (d < 0.01) { mv.x = x; mv.y = y; mv.path.shift(); continue; }
      const step = Math.min(d, budget);
      if (axisX) { mv.x += Math.sign(dx) * step; mv.dir = dx > 0 ? 'right' : 'left'; } else { mv.y += Math.sign(dy) * step; mv.dir = dy > 0 ? 'down' : 'up'; }
      budget -= step; moved += step;
      if (Math.abs(x - mv.x) < 0.01 && Math.abs(y - mv.y) < 0.01) mv.path.shift();
    }
    mv.moving = moved > 0.01;
    mv.dist = (mv.dist ?? 0) + moved;
    return mv;
  }

  /**
   * Positions of the objects of one room: Map id -> { x, y, fixed, wall, spot, onTop }.
   * `list` = object views in the room (holderId null), `spriteSize(o)` = { w, h } of the sprite (the layout asks for
   * sizes so furniture takes the tiles it needs). Also records which tiles the furniture blocks.
   */
  function placeObjects(roomId, list, spriteSize) {
    const g = geom(roomId);
    const out = new Map();
    if (!g) return out;
    const used = new Set();
    const block = new Set();
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
    const r = g.room.rect;
    let doorUsed = false; const wallX = new Set();
    const furn = new Map((g.room.furniture ?? []).map((f) => [f.object, f]));
    for (const o of sorted) {
      if (o.holderId || o.placement?.relation === 'in' || o.placement?.relation === 'worn') continue;
      const spot = g.spots.get(spotFor(o));
      // hand-placed in the map file: exactly there
      const f = furn.get(o.id);
      if (f?.wall) {
        if (o.typeId === 'door') doorUsed = true;
        wallX.add(f.wall[0]);
        const sideWall = f.wall[0] === r.x || f.wall[0] === r.x + r.w - 1;
        out.set(o.id, { x: f.wall[0] * TILE + TILE / 2, y: (f.wall[1] + 1) * TILE - 1, fixed: true, wall: sideWall ? 'side' : true, spot: spot?.id ?? null, onTop: false });
        continue;
      }
      if (f?.at) {
        const [fx, fy, fw = 1, fh = 1] = f.at;
        const tiles = [];
        for (let y = fy; y < fy + fh; y++) for (let x = fx; x < fx + fw; x++) { tiles.push([x, y]); used.add(`${x},${y}`); if (!o.portable) block.add(`${x},${y}`); }
        out.set(o.id, { x: (fx + fw / 2) * TILE, y: (fy + fh) * TILE - 3, fixed: true, solid: !o.portable, spot: spot?.id ?? null, onTop: false, tiles });
        continue;
      }
      if (!spot) continue;
      // doors and shutters sit in the wall
      if (WALL_TYPES.has(o.typeId) && g.room.kind === 'building') {
        const door = (g.room.doors ?? [])[0];
        if (o.typeId === 'door' && /^(door|doorway)$/.test(spot.id) && door && !doorUsed) {
          doorUsed = true;
          const sideWall = door.tile[0] === r.x || door.tile[0] === r.x + r.w - 1;
          out.set(o.id, { x: door.tile[0] * TILE + TILE / 2, y: (door.tile[1] + 1) * TILE - 1, fixed: true, wall: sideWall ? 'side' : true, spot: spot.id, onTop: false });
          continue;
        }
        let tx = Math.round(spotCenter(spot)[0]);
        while (wallX.has(tx) && tx < r.x + r.w - 2) tx++;
        tx = Math.max(r.x + 1, Math.min(r.x + r.w - 2, tx));
        wallX.add(tx);
        out.set(o.id, { x: tx * TILE + TILE / 2, y: (r.y + 1) * TILE - 1, fixed: true, wall: true, spot: spot.id, onTop: false });
        continue;
      }
      if (['on', 'beside'].includes(o.placement?.relation) && o.placement?.of && byId.has(o.placement.of)) { surface.push(o); continue; }
      const size = spriteSize(o) ?? { w: 24, h: 24 };
      const wTiles = Math.max(1, Math.ceil((size.w - 4) / TILE));
      const tiles = [...spot.tiles].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      const fixed = spotOf.has(o.id);
      const solid = fixed && !o.portable; // furniture: blocks its tiles
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
      for (let i = 0; i < run; i++) { used.add(`${pick[0] + i},${pick[1]}`); if (solid) block.add(`${pick[0] + i},${pick[1]}`); }
      const [px, py] = tilePx(pick[0], pick[1]);
      const jx = fixed ? 0 : (hash32(`ox${o.id}`) % 13) - 6;
      out.set(o.id, { x: px + (fixed ? ((run - 1) * TILE) / 2 : jx), y: py + (fixed ? 0 : ((hash32(`oy${o.id}`) % 7) - 3)), onTop: false, fixed, solid, spot: spot.id, tiles: Array.from({ length: run }, (_, i) => [pick[0] + i, pick[1]]) });
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
      // on top: side by side across the surface; beside: a little row next to it, every other one a step forward
      out.set(o.id, { x: base.x + (on ? ((n % 3) - 1) * 9 : (sz.w / 2 + 6 + Math.floor(n / 2) * 13)), y: base.y - (on ? Math.round(sz.h * 0.45) : 0) + (on ? 0 : (n % 2) * 10), onTop: on, fixed: false, spot: base.spot, baseId: o.placement.of });
    }
    const before = blocked.get(roomId);
    if (!before || before.size !== block.size || [...block].some((k) => !before.has(k))) { blocked.set(roomId, block); blockRev++; }
    return out;
  }

  return { grids, rooms, geom, standTile, standPx, tilePx, tileOf, route, polyline, along, citizenPlace, stepMover, placeObjects, inRect, isBlocked, blocked };
}

export { spotCenter };
