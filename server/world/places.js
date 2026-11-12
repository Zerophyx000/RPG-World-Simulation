// Knowledge of places: which rooms a citizen knows, and which services they know about there.
// First, simple version of the knowledge system (STEP 8 generalizes it to beliefs and lore).
//
// c.knownPlaces = { roomId: { services: ['food', 'bed'], source: 'visited' | 'home' | 'local' | 'told:<id>' | 'director', learnedAt } }
// `services` are the services the citizen KNOWS about, which may be fewer than the room has.
import { serviceNames, openExits } from './rooms.js';

export const SERVICE_WORDS = { food: 'food', bed: 'a bed for the night' };

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
