// Step 8: maps and spots. content/maps/<region>.json says how the rooms look (footprints, doors, paths) and names a few
// SPOTS per room ("by the oven", "at the counter"). Spots are the light position system of the simulation: a citizen is at
// a spot, walking between spots takes a moment (code only: the LLM never chooses spots or tiles), and distance between
// spots decides who hears what. Travel times between ROOMS stay authoritative (the room exits); maps only draw them.
import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_DIR } from './scenarios.js';
import { mapRooms, validateMaps } from '../../public/art/mapdata.js';

export const NEAR_MINUTES = 0.3;
export const ACROSS_MINUTES = 0.8;

export function loadMapFiles() {
  const dir = path.join(CONTENT_DIR, 'maps');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (err) {
      throw new Error(`content/maps/${f} is not valid JSON: ${err.message}`);
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
    this.maps = loadMapFiles();
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

  /** What the renderer needs: the map files and the spot data. */
  view() {
    return { maps: this.maps };
  }
}
