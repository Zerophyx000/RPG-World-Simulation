// Step 10: what an object physically IS — read from its type (content/object-types.json, loaded every boot) with a few
// per-object values in o.data (durability, burning, burnt, broken, barricade, filled). Old objects simply get the type's
// defaults when read, so a live world needs no migration.
//
//   phys(world, o) → { durability, maxDurability, breakable, heavy, pushable, throwable, flammable, lockable, container,
//                      light, fireSource, water, seat, bed, smother, cord, key, accelerant, spills, burning, burnt, broken, size }
//   damageObject(world, o, amount, { actorId, cause })  → { durability, broke, changed } (durability 0..100; states follow)
//   keyFits(world, key, lock)                           → content/locks.json, data.keyId, or the same owner
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

const LIT = new Set(['lit', 'hot', 'burning', 'smouldering']);
let LOCKS = null;
function locks() {
  if (LOCKS) return LOCKS;
  try { LOCKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'locks.json'), 'utf8')); } catch { LOCKS = {}; }
  return LOCKS;
}

export function phys(world, o) {
  const t = world.objects.type(o) ?? {};
  const tags = new Set(t.tags ?? []);
  const max = Number(t.durability ?? (tags.has('valuable') ? 60 : 40));
  const d = o.data ?? {};
  return {
    size: t.size ?? 1,
    durability: d.durability != null ? Number(d.durability) : max,
    maxDurability: max,
    breakable: Boolean(t.breakable || t.states?.includes('broken')),
    heavy: Boolean(t.heavy || tags.has('heavy') || (t.size ?? 1) >= 2),
    pushable: Boolean(t.pushable || (t.portable && (t.size ?? 1) >= 2)),
    throwable: Boolean(t.throwable),
    flammable: Boolean(t.flammable),
    lockable: Boolean(t.lockable),
    container: Boolean(t.container || tags.has('container')),
    light: Boolean(t.light || tags.has('light')),
    fireSource: Boolean(t.fireSource),
    water: tags.has('water'),
    seat: Boolean(t.seat),
    bed: Boolean(t.bed),
    smother: Boolean(t.smother),
    cord: tags.has('cord'),
    key: Boolean(t.key || t.id === 'key'),
    accelerant: Boolean(t.accelerant),
    spills: Boolean(t.spills || t.id === 'lantern' || t.id === 'candle'),
    burning: Boolean(d.burning),
    burnt: Boolean(d.burnt),
    broken: o.state === 'broken' || Boolean(d.broken),
    lit: LIT.has(o.state) || Boolean(d.burning),
  };
}

/** Is this object a flame you could light something from (a lit candle, lantern, torch, hearth, forge, a burning thing)? */
export function isFlame(world, o) {
  const p = phys(world, o);
  return p.burning || ((p.light || p.fireSource) && LIT.has(o.state));
}

/** Blows, fire, break attempts. Thresholds switch states without the keeper: below 50% damaged, at 0 broken. */
export function damageObject(world, o, amount, { actorId = 'code', cause = 'a blow' } = {}) {
  const p = phys(world, o);
  const before = p.durability;
  const dur = Math.max(0, Math.round((before - Math.max(0, amount)) * 10) / 10);
  const t = world.objects.type(o) ?? {};
  const patch = { data: { ...o.data, durability: dur, ...(dur < p.maxDurability * 0.5 ? { damaged: true } : {}) } };
  let broke = false;
  if (dur <= 0 && !p.broken && (p.breakable || before > 0)) {
    broke = true;
    if (t.states?.includes('broken') && (t.transitions?.[o.state] ?? []).includes('broken')) patch.state = 'broken';
    else {
      patch.data.broken = true;
      patch.surfaceText = `${(world.objects.surfaceText(o) ?? t.name ?? 'something').replace(/^(a|an|the) /i, 'a broken ')}`.slice(0, 160);
      if (!/broken/.test(patch.surfaceText)) patch.surfaceText = `the broken remains of ${t.name ?? 'something'}`;
    }
  }
  world.objects.change(o.id, patch, { actorId, action: broke ? 'break' : 'damage', notify: false });
  if (broke) world.logEvent('object_broken', { actorId: world.citizens.has(actorId) ? actorId : null, location: o.roomId, objectId: o.id, cause });
  return { durability: dur, broke, changed: dur !== before };
}

export function keyFits(world, key, lock) {
  if (!key || !lock || !phys(world, key).key) return false;
  if (lock.data?.keyId) return lock.data.keyId === key.id;
  const L = locks();
  if (Array.isArray(L[key.id]) && L[key.id].includes(lock.id)) return true;
  const listed = Object.entries(L).some(([k, ids]) => k !== '_doc' && Array.isArray(ids) && ids.includes(lock.id));
  if (listed) return false;
  return Boolean(key.ownerId && key.ownerId === lock.ownerId);
}

/** How strongly a door holds against force (barred and locked doors are tougher). */
export function doorStrength(world, door) {
  const p = phys(world, door);
  return p.durability + (door.state === 'barred' ? 40 : door.state === 'locked' ? 20 : 0);
}

/** Heavy things pushed against this door (step 10 §4.3), in the room they block from. */
export function barricadeOf(world, door) {
  return world.objects.inRoom(door.roomId).filter((x) => x.data?.barricade === door.id);
}
