// Step 8: maps and spots. content/maps/<region>.json says how the rooms look (footprints, doors, paths) and names a few
// SPOTS per room ("by the oven", "at the counter"). Spots are the light position system of the simulation: a citizen is at
// a spot, walking between spots takes a moment (code only: the LLM never chooses spots or tiles), and distance between
// spots decides who hears what. Travel times between ROOMS stay authoritative (the room exits); maps only draw them.
import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_DIR, scenarioContent } from './scenarios.js';
import { mapRooms, validateMaps, buildGrid, findPath, anchorTile } from '../../public/art/mapdata.js';

export const NEAR_MINUTES = 0.3;
export const ACROSS_MINUTES = 0.8;

/** The map files: content/maps/, or the scenario's own maps/ folder (step 12). */
export function loadMapFiles(scenarioId = null) {
  const dir = scenarioContent(scenarioId, 'maps');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (err) {
      throw new Error(`content/${path.relative(CONTENT_DIR, path.join(dir, f)).split(path.sep).join('/')} is not valid JSON: ${err.message}`);
    }
  });
}

export class Maps {
  constructor(world) {
    this.world = world;
    this.maps = [];
    this.byRoom = new Map(); // roomId -> { map, room, spots: Map, dist: Map }
  }

  /** Load the maps and check them against the room graph. Throws (loudly) if they don't fit. */
  load() {
    this.maps = loadMapFiles(this.world.scenario);
    this.byRoom.clear();
    const problems = validateMaps(this.maps, this.world.rooms);
    if (problems.length) throw new Error(`The maps don't match the rooms:\n - ${problems.join('\n - ')}`);
    for (const map of this.maps) {
      for (const room of mapRooms(map)) {
        const spots = new Map((room.spots ?? []).map((s) => [s.id, s]));
        // graph distance between spots (BFS over the adjacency lists)
        const adj = new Map([...spots.keys()].map((k) => [k, new Set()]));
        for (const [a, b] of room.adjacency ?? []) { adj.get(a)?.add(b); adj.get(b)?.add(a); }
        const dist = new Map();
        for (const start of spots.keys()) {
          const d = new Map([[start, 0]]); const q = [start];
          while (q.length) { const x = q.shift(); for (const n of adj.get(x)) if (!d.has(n)) { d.set(n, d.get(x) + 1); q.push(n); } }
          dist.set(start, d);
        }
        const objectSpot = new Map();
        for (const s of spots.values()) for (const id of s.objects ?? []) objectSpot.set(id, s.id);
        this.byRoom.set(room.roomId, { map, room, spots, dist, objectSpot });
      }
    }
    return this;
  }

  has(roomId) {
    return this.byRoom.has(roomId);
  }

  spots(roomId) {
    return [...(this.byRoom.get(roomId)?.spots.values() ?? [])];
  }

  spot(roomId, spotId) {
    return this.byRoom.get(roomId)?.spots.get(spotId) ?? null;
  }

  label(roomId, spotId) {
    return this.spot(roomId, spotId)?.label ?? null;
  }

  defaultSpot(roomId) {
    const r = this.byRoom.get(roomId);
    if (!r) return null;
    return [...r.spots.values()].find((s) => s.default)?.id ?? [...r.spots.keys()][0] ?? null;
  }

  /** Where someone appears who comes in from `fromRoomId` (the door they came through). */
  entrySpot(roomId, fromRoomId = null) {
    const r = this.byRoom.get(roomId);
    if (!r) return null;
    return (fromRoomId && r.room.entries?.[fromRoomId]) || this.doorSpot(roomId) || this.defaultSpot(roomId);
  }

  /**
   * step 9.5: a door barred shut on the way between two rooms: the door object mounted in the wall at the
   * map door that leads from one to the other. → { door, insideRoom } or null.
   */
  barredBetween(fromRoom, toRoom) {
    for (const [inside, other] of [[toRoom, fromRoom], [fromRoom, toRoom]]) {
      const r = this.byRoom.get(inside)?.room;
      if (!r) continue;
      for (const d of r.doors ?? []) {
        const to = Array.isArray(d.to) ? d.to : [d.to];
        if (!to.includes(other)) continue;
        for (const f of r.furniture ?? []) {
          if (!f.wall || f.wall[0] !== d.tile[0] || f.wall[1] !== d.tile[1]) continue;
          const o = this.world.objects.get(f.object);
          if (o && o.state === 'barred' && o.roomId === inside) return { door: o, insideRoom: inside };
        }
      }
    }
    return null;
  }

  /** step 10: the door object between two rooms (whatever its state), with the room it belongs to (its inside). */
  doorBetween(fromRoom, toRoom) {
    for (const [inside, other] of [[toRoom, fromRoom], [fromRoom, toRoom]]) {
      const r = this.byRoom.get(inside)?.room;
      if (!r) continue;
      for (const d of r.doors ?? []) {
        const to = Array.isArray(d.to) ? d.to : [d.to];
        if (!to.includes(other)) continue;
        for (const f of r.furniture ?? []) {
          if (!f.wall || f.wall[0] !== d.tile[0] || f.wall[1] !== d.tile[1]) continue;
          const o = this.world.objects.get(f.object);
          if (o && o.roomId === inside) return { door: o, insideRoom: inside, otherRoom: other };
        }
      }
    }
    return null;
  }

  /** step 10: the room on the other side of a door object. */
  doorTarget(door) {
    const r = this.byRoom.get(door?.roomId)?.room;
    if (!r) return null;
    for (const d of r.doors ?? []) {
      if (!(r.furniture ?? []).some((f) => f.object === door.id && f.wall && f.wall[0] === d.tile[0] && f.wall[1] === d.tile[1])) continue;
      const to = Array.isArray(d.to) ? d.to : [d.to];
      return to.find((x) => x !== door.roomId) ?? null;
    }
    return null;
  }

  doorSpot(roomId) {
    const r = this.byRoom.get(roomId);
    return [...(r?.spots.values() ?? [])].find((s) => /^(door|doorway)$/.test(s.id))?.id ?? null;
  }

  /** The spot where a service (food, bed) is had, if the room names one. */
  serviceSpot(roomId, service) {
    return this.spots(roomId).find((s) => s.service === service)?.id ?? null;
  }

  /** 0 = same spot, 1 = near (adjacent), 2 = across. Unknown spots count as across. */
  distance(roomId, a, b) {
    if (!a || !b) return 2;
    if (a === b) return 0;
    const d = this.byRoom.get(roomId)?.dist.get(a)?.get(b);
    return d == null ? 2 : d <= 1 ? 1 : 2;
  }

  distanceClass(roomId, a, b) {
    return ['same', 'near', 'across'][this.distance(roomId, a, b)];
  }

  /** Game minutes to walk between two spots at the given `moving` capacity (0..1). */
  walkMinutes(roomId, a, b, moving = 1) {
    const d = this.distance(roomId, a, b);
    if (d === 0) return 0;
    return (d === 1 ? NEAR_MINUTES : ACROSS_MINUTES) / Math.max(0.05, Math.min(1, moving));
  }

  /** The spot of an object: its anchor's spot, a spot that lists it, or the room's default. Carried things are with their holder. */
  objectSpot(o, depth = 0) {
    if (!o || depth > 6) return null;
    if (o.holderId) return this.world.citizens.get(o.holderId)?.spot ?? null;
    const r = this.byRoom.get(o.roomId);
    if (!r) return null;
    if (r.objectSpot.has(o.id)) return r.objectSpot.get(o.id);
    if (o.data?.spot && r.spots.has(o.data.spot) && !o.placement?.of) return o.data.spot; // step 9.5: a body lies where they fell
    if (o.placement?.of) {
      const anchor = this.world.objects.get(o.placement.of);
      if (anchor) return this.objectSpot(anchor, depth + 1);
    }
    return this.defaultSpot(o.roomId);
  }

  /** Where to put someone who has no spot yet (old worlds, new citizens, director moves): the room's default spot. */
  startSpot(roomId) {
    return this.defaultSpot(roomId) ?? this.doorSpot(roomId);
  }

  /** step 9: the map (id) a room is drawn on, or null. */
  mapOf(roomId) {
    return this.byRoom.get(roomId)?.map.id ?? null;
  }

  /** step 9: the walk grid of a map with hand-placed furniture blocking (cached). */
  grid(mapId) {
    this.grids ??= new Map();
    if (this.grids.has(mapId)) return this.grids.get(mapId);
    const map = this.maps.find((m) => m.id === mapId);
    if (!map) return null;
    const g = buildGrid(map);
    for (const room of mapRooms(map)) {
      for (const f of room.furniture ?? []) {
        if (!f.at) continue;
        const [x0, y0, w = 1, h = 1] = f.at;
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (g.walk[y]) g.walk[y][x] = false;
      }
    }
    this.grids.set(mapId, g);
    return g;
  }

  /** step 9: the tile a spot is walked to (its first tile; the map's default for unknown spots). */
  spotTile(roomId, spotId) {
    const s = this.spot(roomId, spotId) ?? this.spot(roomId, this.defaultSpot(roomId));
    return s?.tiles?.[0] ?? null;
  }

  /**
   * step 9: the tiles walked on a trip (spot to spot in a room, or room to room through the doors), computed with the
   * same A* as the client. [[x, y], ...] or null when there is no map or no path. Start and end tiles may be blocked.
   */
  tilePath(fromRoom, fromSpot, toRoom, toSpot) {
    const mapId = this.mapOf(toRoom) ?? this.mapOf(fromRoom);
    if (!mapId || (fromRoom && this.mapOf(fromRoom) !== mapId)) return null;
    const grid = this.grid(mapId);
    const a = fromRoom ? this.spotTile(fromRoom, fromSpot) : null;
    const b = this.spotTile(toRoom, toSpot);
    if (!a || !b || !grid) return null;
    const legs = [a];
    if (fromRoom && fromRoom !== toRoom) {
      const ra = this.byRoom.get(fromRoom)?.room; const rb = this.byRoom.get(toRoom)?.room;
      const outA = ra && anchorTile(ra, toRoom); const inB = rb && anchorTile(rb, fromRoom);
      if (outA) legs.push(outA);
      if (inB) legs.push(inB);
    }
    legs.push(b);
    const out = [];
    for (let i = 1; i < legs.length; i++) {
      const p = walkPath(grid, legs[i - 1], legs[i]);
      if (!p) return null;
      out.push(...(out.length ? p.slice(1) : p));
    }
    return out;
  }

  /** What the renderer needs: the map files and the spot data. */
  view() {
    return { maps: this.maps };
  }
}

/** content/art: the palette and every object drawing recipe (for the renderer in the browser; read from disk each time, small). */
export function artContent() {
  const dir = path.join(CONTENT_DIR, 'art');
  const palette = JSON.parse(fs.readFileSync(path.join(dir, 'palette.json'), 'utf8'));
  const odir = path.join(dir, 'objects');
  const recipes = fs.existsSync(odir)
    ? fs.readdirSync(odir).filter((f) => f.endsWith('.json')).sort().flatMap((f) => JSON.parse(fs.readFileSync(path.join(odir, f), 'utf8')))
    : [];
  const readOpt = (f) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null);
  return { palette, recipes, clutter: readOpt('clutter.json'), activityPoses: readOpt('activity-poses.json'), itemMotions: readOpt('item-motions.json') }; // step 9; step 10: item motions
}

/** A* that lets the start and end tiles be blocked (a bed, a chair). */
function walkPath(grid, a, b) {
  const sa = grid.walk[a[1]]?.[a[0]]; const sb = grid.walk[b[1]]?.[b[0]];
  if (grid.walk[a[1]]) grid.walk[a[1]][a[0]] = true;
  if (grid.walk[b[1]]) grid.walk[b[1]][b[0]] = true;
  const p = findPath(grid, a, b);
  if (grid.walk[a[1]]) grid.walk[a[1]][a[0]] = sa;
  if (grid.walk[b[1]]) grid.walk[b[1]][b[0]] = sb;
  return p;
}
