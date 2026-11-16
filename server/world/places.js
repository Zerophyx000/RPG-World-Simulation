// Knowledge of places: which rooms a citizen knows, and which services they know about there.
// First, simple version of the knowledge system (STEP 8 generalizes it to beliefs and lore).
//
// c.knownPlaces = { roomId: { services: ['food', 'bed'], source: 'visited' | 'home' | 'local' | 'told:<id>' | 'director', learnedAt } }
// `services` are the services the citizen KNOWS about, which may be fewer than the room has.
import { serviceNames, openExits, exitTo, activeEffects } from './rooms.js';
import { clockTime, relativeTime } from './time.js';

// step 7A (review): the game minutes when a room effect began = its source director event's game_time
// (room effects carry no start time of their own; primary-key lookup, at most a couple per prompt).
function effectStart(db, effect) {
  const id = Number(effect.sourceEventId);
  if (!Number.isFinite(id) || id <= 0) return -Infinity; // not from a director event: older than any look
  const row = db?.prepare('SELECT game_time FROM events WHERE id = ?').get(id);
  return row?.game_time ?? -Infinity;
}

export const SERVICE_WORDS = { food: 'food', bed: 'a bed for the night', burial: 'a place to bury the dead' };

/** Starting knowledge for a new citizen: "all" (a local) or a list of room ids (visited). */
export function initialKnownPlaces(rooms, spec, { location, home, now }) {
  const out = {};
  const add = (id, source) => {
    const room = rooms.get(id);
    if (room) out[id] = { services: serviceNames(room, now), source, learnedAt: now };
  };
  if (spec === 'all') for (const id of rooms.keys()) add(id, 'local');
  else if (Array.isArray(spec)) for (const id of spec) add(id, 'visited');
  if (location && !out[location]) add(location, 'visited');
  if (home) add(home, 'home');
  return out;
}

/**
 * Add or merge a place. Merging only ever ADDS services; a better source (visited/home)
 * replaces a weaker one (told). Returns true if anything changed.
 */
export function learnPlace(c, roomId, services, source, now) {
  c.knownPlaces ??= {};
  const known = c.knownPlaces[roomId];
  if (!known) {
    c.knownPlaces[roomId] = { services: [...new Set(services)], source, learnedAt: now };
    return true;
  }
  const before = known.services.length;
  known.services = [...new Set([...known.services, ...services])];
  const firstHand = (s) => s === 'visited' || s === 'home' || s === 'local';
  const sourceChanged = !firstHand(known.source) && firstHand(source);
  if (sourceChanged) known.source = source;
  return known.services.length !== before || sourceChanged;
}

export function forgetPlace(c, roomId) {
  if (!c.knownPlaces?.[roomId]) return false;
  delete c.knownPlaces[roomId];
  return true;
}

export function knows(c, roomId) {
  return Boolean(c.knownPlaces?.[roomId]);
}

/** How an exit or place looks to this citizen: its name if known, otherwise its appearance. */
export function placeLabel(c, room) {
  if (!room) return 'somewhere';
  if (knows(c, room.id)) return room.name;
  const look = room.appearance || firstSentence(room.description) || 'a building you don\'t know';
  return lowerFirst(look.replace(/[.!]+$/, ''));
}

export function servicesText(services) {
  const words = services.map((s) => SERVICE_WORDS[s] ?? s);
  if (!words.length) return '';
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** Known places that offer a service (as far as the citizen knows). */
export function knownWith(c, service) {
  return Object.entries(c.knownPlaces ?? {}).filter(([, k]) => k.services.includes(service)).map(([id]) => id);
}

/**
 * Shortest route (fewest hops, BFS) over open exits. Returns the list of room ids
 * AFTER `fromId` up to and including `toId`, or null if there is no way.
 */
export function findPath(rooms, fromId, toId, now) {
  if (fromId === toId) return [];
  const prev = new Map([[fromId, null]]);
  const queue = [fromId];
  while (queue.length) {
    const id = queue.shift();
    for (const e of openExits(rooms.get(id), now)) {
      if (!rooms.has(e.to) || prev.has(e.to)) continue;
      prev.set(e.to, id);
      if (e.to === toId) {
        const path = [toId];
        let p = id;
        while (p !== fromId) {
          path.unshift(p);
          p = prev.get(p);
        }
        return path;
      }
      queue.push(e.to);
    }
  }
  return null;
}

// ---------- step 7A: places as this citizen last saw them ----------

// Mirrors objects.BROKEN_STATES; kept local because objects.js ↔ places.js would be a cycle.
const BROKEN_STATE = /^(broken|smashed|torn|wrecked|shattered|cut)$/;
// Object states worth a word in a place line ("bed made", "hearth cold"); the rest is clutter.
const STATE_WORD = new Set(['made', 'unmade', 'lit', 'cold', 'hot', 'locked', 'overturned']);

/** Walking minutes from `fromId` to `toId` over open exits (0 = here), or null if there is no open way. */
export function travelMinutes(rooms, fromId, toId, now) {
  if (!rooms.has(toId)) return null;
  if (fromId === toId) return 0;
  const path = findPath(rooms, fromId, toId, now);
  if (!path) return null;
  let mins = 0;
  let cur = fromId;
  for (const id of path) {
    mins += exitTo(rooms.get(cur), id, now)?.travelMinutes ?? 1;
    cur = id;
  }
  return mins;
}

/** When the citizen last looked at this room, in words: "a few minutes ago", "yesterday evening". */
export function lastSeenPhrase(now, seenAt) {
  if (seenAt == null) return null;
  const ago = Math.max(0, Math.round(now - seenAt));
  if (ago <= 90) return relativeTime(ago);
  if (Math.floor(now / 1440) === Math.floor(seenAt / 1440)) return `${clockTime(seenAt)} today`;
  if (ago < 1440 * 2) return (seenAt % 1440) < 12 * 60 ? 'yesterday morning' : 'yesterday evening';
  return relativeTime(ago);
}

/**
 * The state of a room as THIS citizen knows it: room effects they know about (damage and the like),
 * plus a couple of notable objects from what they have seen (own things, the bed of a place that
 * offers one, anything broken). Returns { seenAt, parts, bed }:
 *   seenAt  game minutes when they last looked at the room (snapshot, else when they learned of it)
 *   parts   short phrases for the prompt ("Smoke still hangs in the air; …", "bed made")
 *   bed     'broken' | 'usable' | null — what they know about a bed there
 */
export function knownRoomState(world, c, roomId) {
  const k = c.knownPlaces?.[roomId];
  if (!k) return { seenAt: null, parts: [], bed: null };
  const room = world.rooms.get(roomId);
  // Only an actual look counts (a place they merely know of has no "last seen").
  const seenAt = c.roomSnapshots?.[roomId]?.at ?? null;
  // step 7A (review): no knowledge leaks. A lasting effect is only shown where they could have seen it
  // happen: they are in the room now, or their last look at it came after the effect started.
  // (Room effects carry no start time; their source director event's game_time is when it began.)
  const effects = room ? activeEffects(room, world.now) : [];
  const parts = effects
    .filter((e) => roomId === c.location || (seenAt != null && seenAt >= effectStart(world.db, e)))
    .map((e) => e.text);
  const O = world.objects;
  const notable = [];
  for (const [id, known] of Object.entries(c.knownObjects ?? {})) {
    if (known.holderId || known.roomId !== roomId) continue;
    const o = O.get(id);
    if (!o) continue;
    const broken = BROKEN_STATE.test(known.state);
    const name = (O.type(o)?.name ?? '').toLowerCase();
    const relevant = broken || o.ownerId === c.id
      || (name === 'bed' && (k.services.includes('bed') || c.home === roomId))
      || (name === 'oven' && k.services.includes('food'));
    if (!relevant) continue;
    notable.push({ o, known, state: known.state, rank: broken ? 0 : o.ownerId === c.id ? 1 : 2 });
  }
  notable.sort((a, b) => a.rank - b.rank || (b.known.lastSeenAt ?? 0) - (a.known.lastSeenAt ?? 0));
  // What they know about a bed there, from the beds they have actually seen.
  const beds = notable.filter(({ o }) => (O.type(o)?.name ?? '').toLowerCase() === 'bed');
  const bed = beds.some(({ state }) => BROKEN_STATE.test(state)) ? 'broken' : beds.length ? 'usable' : null;
  const words = notable.filter(({ state }) => BROKEN_STATE.test(state) || STATE_WORD.has(state))
    .slice(0, Math.max(0, 2 - parts.length));
  for (const { o, state } of words) parts.push(`${o.data?.short ?? O.type(o)?.name ?? 'thing'} ${state}`);
  return { seenAt, parts, bed };
}

/** A one-line description of how to get somewhere from `fromId`, for tell_about_place. */
export function routeHint(rooms, fromId, toId, now) {
  const path = findPath(rooms, fromId, toId, now);
  if (!path) return '';
  if (path.length === 0) return 'It\'s right here.';
  if (path.length === 1) return 'It\'s right next to here.';
  const via = path.slice(0, -1).map((id) => rooms.get(id)?.name).filter(Boolean);
  return `You get there by way of ${via.join(', then ')}.`;
}

function firstSentence(s) {
  return String(s ?? '').split(/(?<=[.!?])\s/)[0];
}

function lowerFirst(s) {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}
