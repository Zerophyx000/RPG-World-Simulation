// Rooms: load/save, exits, services, who is where.
// A room in memory:
//   { id, name, description, appearance, exits: [{to, travelMinutes}], tags, affordances,
//     services: { food?: {minutes, hungerRelief, description}, bed?: {quality, description} },
//     x, y (optional map position for the UI),
//     effects: [{ id, text, until, sourceEventId }],                 // lasting director effects (runtime state)
//     serviceOverrides: { food?: { enabled: false, until, reason } }, // e.g. "the kitchen burned" (runtime state)
//     blockedExits: [{ to, until, reason }],                          // e.g. rubble on the path (runtime state)
//     origin: 'content' | 'runtime' }
//
// Rooms are CONTENT: on every boot the ones from content/rooms.json are upserted by id (scenarios.js),
// keeping only the runtime-state fields above. Rooms created at runtime (origin 'runtime') are never touched.

export const RUNTIME_ROOM_FIELDS = ['effects', 'serviceOverrides', 'blockedExits'];
const SERVICE_KINDS = ['food', 'bed', 'burial']; // step 9.5: the chapel yard's burial ground

export function normalizeRoom(row) {
  const data = typeof row.data === 'string' ? safeJson(row.data) : (row.data ?? {});
  const src = { ...data, ...row }; // seed entries have everything at top level
  return {
    ...data,
    id: String(src.id),
    name: String(src.name ?? src.id),
    description: String(src.description ?? ''),
    appearance: String(src.appearance ?? ''),
    exits: Array.isArray(src.exits)
      ? src.exits.map((e) => ({ to: String(e.to), travelMinutes: clampInt(e.travelMinutes, 1, 240, 1) }))
      : [],
    tags: Array.isArray(src.tags) ? src.tags.map(String) : [],
    affordances: Array.isArray(src.affordances) ? src.affordances.map(String) : [],
    services: normalizeServices(src.services),
    // step 5: how much stuff a citizen's prompt lists here (sparse 5 / normal 8 / rich 12) and what kind of place it is
    detail: ['sparse', 'normal', 'rich'].includes(src.detail) ? src.detail : 'normal',
    kind: String(src.kind ?? (src.tags?.includes?.('home') ? 'home' : 'place')),
    // step 5.5: how dangerous the place feels (0–10, village rooms 0–1) and whose home it is
    danger: Math.min(10, Math.max(0, Number(src.danger) || 0)),
    owner: src.owner ? String(src.owner) : null,
    x: Number.isFinite(Number(src.x)) && src.x !== null ? Number(src.x) : null,
    y: Number.isFinite(Number(src.y)) && src.y !== null ? Number(src.y) : null,
    effects: Array.isArray(src.effects) ? src.effects.filter((e) => e && e.text) : [],
    serviceOverrides: src.serviceOverrides && typeof src.serviceOverrides === 'object' ? src.serviceOverrides : {},
    blockedExits: Array.isArray(src.blockedExits) ? src.blockedExits : [],
    origin: src.origin ?? 'content',
  };
}

function normalizeServices(s) {
  const out = {};
  if (!s || typeof s !== 'object') return out;
  if (s.food) {
    out.food = {
      minutes: clampInt(s.food.minutes, 1, 240, 30),
      hungerRelief: clampInt(s.food.hungerRelief, 1, 100, 60),
      description: String(s.food.description ?? 'something to eat'),
      // step 9.5 (B6.1): who runs it and how much is left
      ...(s.food.operator ? { operator: String(s.food.operator) } : {}),
      ...(s.food.stock && typeof s.food.stock === 'object' ? { stock: { ...s.food.stock } } : {}),
    };
  }
  if (s.bed) out.bed = { quality: s.bed.quality === 'rough' ? 'rough' : 'good', description: String(s.bed.description ?? 'a bed') };
  // step 9.5: other services (burial…) keep their description
  for (const [k, v] of Object.entries(s)) {
    if (k === 'food' || k === 'bed' || !v || typeof v !== 'object') continue;
    out[k] = { description: String(v.description ?? k), ...(v.operator ? { operator: String(v.operator) } : {}), ...(v.stock && typeof v.stock === 'object' ? { stock: { ...v.stock } } : {}) };
  }
  return out;
}

export function saveRoom(db, room) {
  const { id, name, ...data } = room;
  db.prepare('UPDATE rooms SET name = ?, data = ? WHERE id = ?').run(name, JSON.stringify(data), id);
}

export function loadRooms(db) {
  const map = new Map();
  for (const row of db.prepare('SELECT id, name, data FROM rooms').all()) {
    const room = normalizeRoom(row);
    map.set(room.id, room);
  }
  return map;
}

export function insertRoom(db, room) {
  const { id, name, ...data } = normalizeRoom(room);
  db.prepare('INSERT INTO rooms (id, name, data) VALUES (?, ?, ?)').run(id, name, JSON.stringify(data));
}

// Active effects, i.e. not yet expired.
export function activeEffects(room, now) {
  return (room?.effects ?? []).filter((e) => e.until == null || e.until > now);
}

/** Services currently usable (director overrides can switch one off for a while). */
export function activeServices(room, now) {
  const out = {};
  for (const k of SERVICE_KINDS) {
    const svc = room?.services?.[k];
    if (!svc) continue;
    const o = room.serviceOverrides?.[k];
    if (o && o.enabled === false && (o.until == null || o.until > now)) continue;
    out[k] = svc;
  }
  return out;
}

export function serviceNames(room, now) {
  return Object.keys(activeServices(room, now));
}

/** Exits that are not blocked right now. */
export function openExits(room, now) {
  const blocked = new Set((room?.blockedExits ?? []).filter((b) => b.until == null || b.until > now).map((b) => b.to));
  return (room?.exits ?? []).filter((e) => !blocked.has(e.to));
}

export function blockedExit(room, to, now) {
  return (room?.blockedExits ?? []).find((b) => b.to === to && (b.until == null || b.until > now)) ?? null;
}

export function exitTo(room, toId, now = null) {
  const list = now == null ? room?.exits ?? [] : openExits(room, now);
  return list.find((e) => e.to === toId) ?? null;
}

/**
 * Room hops from `fromId` to every reachable room (BFS). Exits are treated as
 * two-way for distance: sound and smoke don't care which way the path was seeded.
 */
export function roomDistances(rooms, fromId) {
  const adj = new Map([...rooms.keys()].map((id) => [id, new Set()]));
  for (const r of rooms.values()) {
    for (const e of r.exits) {
      if (!rooms.has(e.to)) continue;
      adj.get(r.id).add(e.to);
      adj.get(e.to).add(r.id);
    }
  }
  const dist = new Map([[fromId, 0]]);
  const queue = [fromId];
  while (queue.length) {
    const id = queue.shift();
    for (const n of adj.get(id) ?? []) {
      if (!dist.has(n)) {
        dist.set(n, dist.get(id) + 1);
        queue.push(n);
      }
    }
  }
  return dist;
}

// Citizens currently in a room (moving citizens have location = null and are in no room).
export function citizensIn(citizens, roomId, { exceptId = null } = {}) {
  const out = [];
  for (const c of citizens.values()) {
    if (c.alive && c.location === roomId && c.id !== exceptId) out.push(c);
  }
  return out;
}

// Room ids referenced by exits that don't exist. Used to sanity-check content.
export function danglingExits(rooms) {
  const bad = [];
  for (const r of rooms.values()) for (const e of r.exits) if (!rooms.has(e.to)) bad.push(`${r.id} -> ${e.to}`);
  return bad;
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
