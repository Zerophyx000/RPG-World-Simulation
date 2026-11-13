// Step 8: map data helpers, pure functions shared by the server (boot checks, spots) and the client (rendering,
// path-finding). A map (content/maps/<region>.json) is how the simulation's rooms LOOK: rooms stay authoritative
// (travel times come from the room exits); the map gives each room a footprint (building) or area (outdoors),
// its doors, its named spots and the tile paths between them.
export const TILE = 32;

const BLOCKING = new Set(['stone_wall', 'timber_wall', 'tree', 'fence', 'bush', 'rock']);

/** "rect:22,14,14,10" or [x, y, w, h] → { x, y, w, h } */
export function parseRect(r) {
  if (Array.isArray(r)) return { x: r[0], y: r[1], w: r[2], h: r[3] };
  const m = /^rect:(\d+),(\d+),(\d+),(\d+)$/.exec(String(r));
  return m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : null;
}

export const inRect = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

/** Build lookup grids for a map: materials per layer, owning room per tile, walkability. */
export function buildGrid(map) {
  const [W, H] = map.size;
  const mat = (ch) => map.legend?.[ch] ?? null;
  const ground = []; const structure = []; const roomAt = []; const walk = [];
  for (let y = 0; y < H; y++) {
    const g = map.layers.ground[y] ?? ''; const s = map.layers.structures?.[y] ?? '';
    ground.push([]); structure.push([]); roomAt.push(new Array(W).fill(null)); walk.push(new Array(W).fill(false));
    for (let x = 0; x < W; x++) {
      ground[y][x] = mat(g[x] ?? '.') ?? 'grass';
      const sc = s[x] ?? '.';
      structure[y][x] = sc === '.' || sc === ' ' ? null : mat(sc);
    }
  }
  const claim = (id, r, kind) => { for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (x >= 0 && y >= 0 && x < W && y < H) roomAt[y][x] = { id, kind }; };
  for (const room of map.rooms ?? []) claim(room.roomId, parseRect(room.footprint), 'building');
  for (const area of map.areas ?? []) claim(area.roomId, parseRect(area.tiles), 'area');
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) walk[y][x] = ground[y][x] !== 'water' && !BLOCKING.has(structure[y][x]);
  return { W, H, ground, structure, roomAt, walk, map };
}

/** A* over walkable tiles (4-neighbour). Returns [[x, y], ...] including both ends, or null. */
export function findPath(grid, from, to) {
  const { W, H, walk } = grid;
  const key = (x, y) => y * W + x;
  const [sx, sy] = from; const [tx, ty] = to;
  if (!walk[sy]?.[sx] || !walk[ty]?.[tx]) return null;
  const open = [[sx, sy]]; const g = new Map([[key(sx, sy), 0]]); const prev = new Map(); const f = new Map([[key(sx, sy), Math.abs(sx - tx) + Math.abs(sy - ty)]]);
  const closed = new Set();
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (f.get(key(...open[i])) < f.get(key(...open[bi]))) bi = i;
    const [cx, cy] = open.splice(bi, 1)[0];
    if (cx === tx && cy === ty) {
      const out = [[cx, cy]];
      let k = key(cx, cy);
      while (prev.has(k)) { const p = prev.get(k); out.unshift(p); k = key(p[0], p[1]); }
      return out;
    }
    closed.add(key(cx, cy));
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx; const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || !walk[ny][nx] || closed.has(key(nx, ny))) continue;
      const ng = g.get(key(cx, cy)) + 1;
      if (ng < (g.get(key(nx, ny)) ?? Infinity)) {
        g.set(key(nx, ny), ng); prev.set(key(nx, ny), [cx, cy]);
        f.set(key(nx, ny), ng + Math.abs(nx - tx) + Math.abs(ny - ty));
        if (!open.some((o) => o[0] === nx && o[1] === ny)) open.push([nx, ny]);
      }
    }
  }
  return null;
}

/** Everything the simulation needs to know about the rooms of a map: [{ roomId, kind, rect, doors, spots, adjacency, entries, roof }] */
export function mapRooms(map) {
  return [
    ...(map.rooms ?? []).map((r) => ({ ...r, kind: 'building', rect: parseRect(r.footprint) })),
    ...(map.areas ?? []).map((a) => ({ ...a, kind: 'area', rect: parseRect(a.tiles), doors: a.doors ?? [] })),
  ];
}

export const spotTiles = (spot) => spot.tiles ?? [];
export const spotCenter = (spot) => {
  const t = spotTiles(spot);
  if (!t.length) return [0, 0];
  return [t.reduce((s, p) => s + p[0], 0) / t.length, t.reduce((s, p) => s + p[1], 0) / t.length];
};

/**
 * Check a set of maps against the simulation's rooms. rooms: Map id -> { exits: [{ to }] }.
 * → list of problems (empty = fine). Fails loudly in the caller.
 */
export function validateMaps(maps, rooms) {
  const problems = [];
  const owner = new Map(); // roomId -> { map, room }
  const grids = new Map();
  for (const map of maps) {
    grids.set(map.id, buildGrid(map));
    for (const room of mapRooms(map)) {
      if (owner.has(room.roomId)) problems.push(`room "${room.roomId}" appears twice (${owner.get(room.roomId).map.id} and ${map.id})`);
      owner.set(room.roomId, { map, room });
    }
  }
  for (const id of rooms.keys()) if (!owner.has(id)) problems.push(`room "${id}" has no footprint or area on any map`);
  for (const [id, { map, room }] of owner) {
    if (!rooms.has(id)) { problems.push(`map "${map.id}" has a footprint or area for unknown room "${id}"`); continue; }
    const grid = grids.get(map.id);
    const r = room.rect;
    if (!r || r.x < 0 || r.y < 0 || r.x + r.w > grid.W || r.y + r.h > grid.H) { problems.push(`room "${id}": footprint is outside the map`); continue; }
    // spots: inside, not overlapping, reachable from the room's entry
    const seen = new Map();
    for (const spot of room.spots ?? []) {
      if (!spot.id || !spotTiles(spot).length) problems.push(`room "${id}": a spot has no id or no tiles`);
      for (const [x, y] of spotTiles(spot)) {
        if (!inRect(r, x, y)) problems.push(`room "${id}": spot "${spot.id}" tile ${x},${y} is outside the room`);
        const k = `${x},${y}`;
        if (seen.has(k)) problems.push(`room "${id}": spots "${seen.get(k)}" and "${spot.id}" overlap at ${k}`);
        seen.set(k, spot.id);
        if (!grid.walk[y]?.[x]) problems.push(`room "${id}": spot "${spot.id}" tile ${x},${y} is not walkable`);
      }
    }
    // furniture (hand-placed): on the room's floor, or set into one of its walls; never under a spot or another piece
    const blockedHere = new Set();
    for (const f of room.furniture ?? []) {
      if (!f.object) { problems.push(`room "${id}": a furniture entry has no object`); continue; }
      if (f.wall) {
        const [x, y] = f.wall;
        const border = room.kind === 'building' && inRect(r, x, y) && (x === r.x || y === r.y || x === r.x + r.w - 1 || y === r.y + r.h - 1);
        if (!border) problems.push(`room "${id}": "${f.object}" is set into ${x},${y}, which is not a wall of the room`);
        continue;
      }
      if (!Array.isArray(f.at) || f.at.length < 2) { problems.push(`room "${id}": "${f.object}" has no "at" or "wall"`); continue; }
      const [fx, fy, fw = 1, fh = 1] = f.at;
      for (let y = fy; y < fy + fh; y++) {
        for (let x = fx; x < fx + fw; x++) {
          const inside = room.kind === 'building' ? x > r.x && y > r.y && x < r.x + r.w - 1 && y < r.y + r.h - 1 : inRect(r, x, y);
          if (!inside) problems.push(`room "${id}": "${f.object}" tile ${x},${y} is not on the room's floor`);
          else if (!grid.walk[y]?.[x]) problems.push(`room "${id}": "${f.object}" tile ${x},${y} is not floor`);
          const k = `${x},${y}`;
          if (seen.has(k)) problems.push(`room "${id}": spot "${seen.get(k)}" stands on "${f.object}" at ${k}`);
          if (blockedHere.has(k)) problems.push(`room "${id}": "${f.object}" overlaps other furniture at ${k}`);
          blockedHere.add(k);
        }
      }
    }
    const furnished = blockedHere.size ? { ...grid, walk: grid.walk.map((row, y) => row.map((w, x) => w && !blockedHere.has(`${x},${y}`))) } : grid;
    const spotIds = new Set((room.spots ?? []).map((s) => s.id));
    for (const [a, b] of room.adjacency ?? []) if (!spotIds.has(a) || !spotIds.has(b)) problems.push(`room "${id}": adjacency ${a}-${b} names an unknown spot`);
    for (const [from, spot] of Object.entries(room.entries ?? {})) if (!spotIds.has(spot)) problems.push(`room "${id}": entry from ${from} names unknown spot "${spot}"`);
    const first = room.spots?.[0];
    if (!first) problems.push(`room "${id}" has no spots`);
    // every exit needs a door (buildings) or a path to the neighbour
    for (const exit of rooms.get(id).exits ?? []) {
      if (!rooms.has(exit.to)) continue;
      const to = owner.get(exit.to);
      if (!to) continue;
      if (room.kind === 'building' && !(room.doors ?? []).some((d) => [].concat(d.to).includes(exit.to))) { problems.push(`room "${id}": exit to "${exit.to}" has no door`); continue; }
      if (to.map.id !== map.id) continue; // another region: an edge exit, checked by the region's own gate
      const a = anchorTile(room, exit.to) ?? centreOf(room); const b = anchorTile(to.room, id) ?? centreOf(to.room);
      if (!findPath(grid, a, b)) problems.push(`room "${id}": no walkable path to "${exit.to}" on the map`);
    }
    if (first) {
      const start = anchorTile(room, [...rooms.get(id).exits ?? []][0]?.to) ?? spotTiles(first)[0];
      for (const spot of room.spots ?? []) if (start && spotTiles(spot)[0] && !findPath(furnished, start, spotTiles(spot)[0])) problems.push(`room "${id}": spot "${spot.id}" is not reachable${blockedHere.size ? ' (with the furniture in the way)' : ''}`);
    }
  }
  return problems;
}

const centreOf = (room) => [Math.floor(room.rect.x + room.rect.w / 2), Math.floor(room.rect.y + room.rect.h / 2)];

/** The tile where a room meets a neighbour: the door toward it, or the spot used as the entry from it. */
export function anchorTile(room, toRoomId) {
  const door = (room.doors ?? []).find((d) => [].concat(d.to).includes(toRoomId));
  if (door) return door.tile;
  const spot = (room.spots ?? []).find((s) => s.id === room.entries?.[toRoomId]);
  return spot ? spotTiles(spot)[0] : null;
}
