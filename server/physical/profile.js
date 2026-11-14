// Step 10: the two abstractions every physical act resolves through. Later steps (stats, proficiencies, essences, real
// gear) fill them in WITHOUT changing the callers — see server/physical/README.md for every factor, its source now and
// where future systems hook in.
//
//   combatProfile(world, c, ctx) → { force, precision, evasion, toughness, grip, speed, reach, composure }   (≈ 0..2, 1 = an
//                                   ordinary healthy adult; reach: 'same' | 'near')
//   weaponProfile(world, o)       → { damage: [{ type, base }], reach, hands, weight, speed, quality, durability, abilities,
//                                     improvised, label }   (bare hands when o is null)
//   isDark(world, roomId)         → no light at night (precision and perception suffer)
import { deriveLook } from '../../public/art/character.js';
import { timeOfDay } from '../world/time.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = (v) => Math.round(v * 100) / 100;

// provisional practice (persona.practiced, or the occupation) until the RPG step has proficiencies
const FIGHT_PRACTICE = ['brawling', 'soldier', 'smith', 'guard', 'danger', 'hunter'];
const BUILD_FORCE = { broad: 1.25, average: 1, short: 0.95, slim: 0.85 };
const BUILD_TOUGH = { broad: 1.2, average: 1, short: 1, slim: 0.9 };

export const BARE_HANDS = Object.freeze({
  id: 'bare_hands', label: 'bare hands', damage: [{ type: 'blunt', base: 4 }], reach: 'same', hands: 1, weight: 0, speed: 1.1,
  quality: 0.5, durability: null, abilities: [], improvised: false,
});

/** How practiced at a fight: 1 (no), 1.2 (some), from persona.practiced and the occupation. */
export function fightPractice(c) {
  const list = (c.persona?.practiced ?? []).map(String);
  if (list.some((p) => FIGHT_PRACTICE.includes(p))) return 1.25;
  if (/smith|soldier|guard|hunter|butcher|wrestler|sailor/i.test(c.persona?.occupation ?? '')) return 1.15;
  return 1;
}

export function buildOf(c) {
  try { return c.persona?.build ?? deriveLook(c).build ?? 'average'; } catch { return 'average'; }
}

const strongest = (world, c, type, targetId = null) => {
  let best = 0;
  for (const e of world.emotions?.of(c) ?? []) {
    if (e.type !== type) continue;
    const v = e.intensity * (targetId && e.target && e.target !== targetId ? 0.5 : 1);
    if (v > best) best = v;
  }
  return best / 10;
};

/**
 * @param {object} ctx { opponentId?, weapon? (a weaponProfile), dark? }
 */
export function combatProfile(world, c, ctx = {}) {
  const cap = c.body?.capacities ?? {};
  const get = (k) => (cap[k] == null ? 1 : cap[k]);
  const mL = get('manipulationLeft');
  const mR = get('manipulationRight');
  const manip = Math.max(mL, mR) * 0.7 + Math.min(mL, mR) * 0.3;
  const moving = get('moving');
  const sight = get('sight');
  const cons = get('consciousness');
  const pain = c.body?.pain ?? 0;
  const fat = clamp((c.needs?.fatigue ?? 0) / 100, 0, 1);
  const anger = strongest(world, c, 'anger', ctx.opponentId);
  const fear = strongest(world, c, 'fear', ctx.opponentId);
  const now = world.now;
  const ph = c.phys ?? {};
  const dazed = (ph.dazedUntil ?? -Infinity) > now;
  const winded = (ph.windedUntil ?? -Infinity) > now;
  const concussed = (c.body?.status ?? []).includes('concussed');
  const practice = fightPractice(c);
  const build = buildOf(c);
  const painF = 1 - 0.04 * Math.max(0, pain - 2);
  const dark = ctx.dark ?? isDark(world, c.location);

  const force = (BUILD_FORCE[build] ?? 1) * (0.5 + 0.5 * manip) * (0.6 + 0.4 * moving) * (1 + 0.3 * anger) * (1 - 0.4 * fat) * painF * practice * (winded ? 0.7 : 1);
  const precision = (0.4 + 0.6 * sight) * (0.5 + 0.5 * manip) * practice * (concussed ? 0.8 : 1) * (1 - 0.25 * fear) * (anger > 0.5 ? 0.9 : 1)
    * (dazed ? 0.7 : 1) * (dark ? 0.6 : 1) * (ctx.weapon?.improvised ? 0.95 : 1);
  const evasion = (0.3 + 0.7 * moving) * (0.5 + 0.5 * sight) * clamp(cons, 0, 1) * (1 + 0.2 * fear) * (1 - 0.3 * fat) * Math.min(practice, 1.15)
    * (dazed ? 0.7 : 1) * (winded ? 0.8 : 1) * (dark ? 0.85 : 1);
  const toughness = (BUILD_TOUGH[build] ?? 1) * (0.5 + 0.5 * clamp((c.body?.vitality ?? 100) / 100, 0, 1)) * (0.5 + 0.5 * clamp((c.body?.blood ?? 100) / 100, 0, 1));
  const grip = Math.sqrt(BUILD_FORCE[build] ?? 1) * (0.3 + 0.7 * manip) * (1 - 0.3 * fat) * painF;
  const speed = moving * (1 - 0.3 * fat) * painF * (winded ? 0.7 : 1);
  const composure = (world.emotions?.composure(c) ?? 0.5) * Math.min(practice, 1.1) * (1 - 0.3 * fear);
  return {
    force: r2(Math.max(0.05, force)), precision: r2(Math.max(0.05, precision)), evasion: r2(Math.max(0, evasion)), toughness: r2(toughness),
    grip: r2(Math.max(0.05, grip)), speed: r2(speed), reach: ctx.weapon?.reach ?? 'same', composure: r2(composure),
  };
}

// ---------- weapons ----------
const IMPROVISED = [
  // tags → profile; the first match wins
  { tags: ['sharp', 'pointed'], damage: [{ type: 'pierce', base: 11 }, { type: 'cut', base: 8 }], reach: 'same', speed: 1 },
  { tags: ['pointed'], damage: [{ type: 'pierce', base: 12 }], reach: 'near', speed: 0.8 },
  { tags: ['sharp'], damage: [{ type: 'cut', base: 10 }, { type: 'pierce', base: 7 }], reach: 'same', speed: 1 },
  { tags: ['blade'], damage: [{ type: 'cut', base: 10 }, { type: 'pierce', base: 7 }], reach: 'same', speed: 1 },
  { tags: ['heavy', 'blunt'], damage: [{ type: 'blunt', base: 16 }], reach: 'same', speed: 0.8 },
  { tags: ['blunt'], damage: [{ type: 'blunt', base: 9 }], reach: 'same', speed: 0.9 },
];

/** The weapon profile of an object (a real one from its type's `weapon`, else improvised from its tags), or bare hands. */
export function weaponProfile(world, o) {
  if (!o) return BARE_HANDS;
  const type = world.objects.type(o) ?? {};
  const tags = new Set([...(type.tags ?? []), ...(type.states && o.state && type.stateTags?.[o.state] ? type.stateTags[o.state] : [])]);
  const label = world.objects.surfaceText?.(o) ?? type.name ?? 'a thing';
  const durability = o.data?.durability ?? type.durability ?? null;
  if (type.weapon) {
    const w = type.weapon;
    return {
      id: o.id, label, damage: (w.damage ?? [{ type: 'blunt', base: 8 }]).map((d) => ({ ...d })), reach: w.reach ?? 'same', hands: w.hands ?? 1,
      weight: w.weight ?? 1, speed: w.speed ?? 1, quality: o.data?.quality ?? w.quality ?? 0.5, durability, abilities: [...(w.abilities ?? [])], improvised: false,
    };
  }
  const match = IMPROVISED.find((p) => p.tags.every((t) => tags.has(t)));
  if (!match) {
    // anything solid will do in a pinch: a light blow, by size
    const heavy = (type.size ?? 1) >= 2 || tags.has('heavy');
    return { id: o.id, label, damage: [{ type: 'blunt', base: heavy ? 10 : 5 }], reach: 'same', hands: heavy ? 2 : 1, weight: heavy ? 3 : 1, speed: heavy ? 0.7 : 1, quality: 0.4, durability, abilities: [], improvised: true };
  }
  return {
    id: o.id, label, damage: match.damage.map((d) => ({ ...d })), reach: match.reach, hands: tags.has('heavy') ? 2 : 1, weight: tags.has('heavy') ? 3 : 1,
    speed: match.speed, quality: o.data?.quality ?? type.quality ?? 0.5, durability, abilities: [], improvised: true,
  };
}

// ---------- light ----------
const LIGHT_STATES = new Set(['lit', 'burning', 'hot']); // embers (smouldering) give no real light
/** Night (or a windowless dark) with no lit light here or carried by anyone here. Outdoors the moon gives a little. */
export function isDark(world, roomId) {
  if (!roomId) return false;
  const room = world.rooms.get(roomId);
  if (!room) return false;
  const tod = timeOfDay(world.now);
  const night = /night|midnight|small hours/i.test(tod);
  if (!night) return false;
  if ((room.tags ?? []).includes('outdoor')) return false; // moon and stars: dim, not dark
  for (const o of world.objects.inRoom(roomId)) if (LIGHT_STATES.has(o.state) && isLightSource(world, o)) return false;
  for (const x of world.citizens.values()) {
    if (x.location !== roomId || !x.alive) continue;
    for (const o of world.objects.carriedBy?.(x.id) ?? []) if (LIGHT_STATES.has(o.state) && isLightSource(world, o)) return false;
  }
  return true;
}

export function isLightSource(world, o) {
  const t = world.objects.type(o) ?? {};
  return Boolean(t.light || ['hearth', 'forge', 'oven', 'candle', 'lantern', 'torch'].includes(t.id) || (t.tags ?? []).includes('light') || o.state === 'burning');
}
