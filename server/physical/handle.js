// Step 10 §4.1–§4.3: one tool for physical acts on objects, handle(object, action, with?, target?). Code offers only the
// actions an object's physical properties allow (props.js); `use(object, intent)` stays for free-form intents (the keeper).
//
//   throw    held, throwable → at a person (resolved like act_on throw_at), at an object, or across the room
//   push     heavy furniture → another spot; against a door it BARRICADES it (data.barricade = door id): nobody gets
//            in from the other side until it is moved; from outside, forcing the door is a force contest (helpers add up)
//   break    durability contest (doors: barred +40, locked +20); a broken bottle becomes sharp
//   open / close / lock / unlock (the matching key in hand) / bar / unbar
//   put_in / take_out   containers hide what's inside while closed
//   sit_on / lie_on     seats and beds
//   light / douse       candles, lanterns, torches, hearths (lighting needs a flame here or in hand)
//   fill / pour         buckets and jugs: fill at the well (or a water barrel); pour on a fire, a person or the floor
//   ignite / smother    a held flame to something flammable (arson when it isn't yours); a cloth or blanket on a small fire
import { citizensIn } from '../world/rooms.js';
import { ref } from '../memory/index.js';
import { pronouns } from '../world/citizens.js';
import { hasWater } from '../body/treat.js';
import { combatProfile, weaponProfile } from './profile.js';
import { phys, isFlame, damageObject, keyFits, doorStrength, barricadeOf } from './props.js';

export const HANDLE_ACTIONS = ['throw', 'push', 'break', 'open', 'close', 'lock', 'unlock', 'bar', 'unbar', 'put_in', 'take_out', 'sit_on', 'lie_on', 'light', 'douse', 'fill', 'pour', 'ignite', 'smother'];
const MINUTES = { throw: 0.15, push: 1, break: 1, open: 0.2, close: 0.2, lock: 0.3, unlock: 0.3, bar: 0.3, unbar: 0.3, put_in: 0.3, take_out: 0.3, sit_on: 15, lie_on: 30, light: 0.5, douse: 0.2, fill: 2, pour: 0.3, ignite: 0.5, smother: 0.5 };
const rnd = (world, a, b) => a + (world.physical?.rng ?? Math.random)() * (b - a);
const roll = (world) => (world.physical?.rng ?? Math.random)();
const hasState = (world, o, s) => (world.objects.type(o)?.states ?? []).includes(s);
const canGo = (world, o, s) => hasState(world, o, s) && (world.objects.type(o)?.transitions?.[o.state] ?? []).includes(s);
const UNLIT = (world, o) => ['unlit', 'cold', 'smouldering'].find((s) => canGo(world, o, s)) ?? null;
const LIT = (world, o) => ['lit', 'hot'].find((s) => canGo(world, o, s)) ?? null;
const isDoor = (world, o) => world.objects.type(o)?.id === 'door';

/** Which handle actions this object offers to this citizen right now. */
export function actionsFor(world, c, o, { held, flameHere, waterHere }) {
  const p = phys(world, o);
  const mine = o.holderId === c.id;
  const out = [];
  if (p.burnt) return out;
  if (mine && (p.throwable || p.size <= 1)) out.push('throw');
  if (!mine && p.pushable && !o.holderId) out.push('push');
  if (p.breakable && !p.broken && p.durability > 0) out.push('break');
  if (canGo(world, o, 'open') && o.state !== 'locked' && o.state !== 'barred') out.push('open');
  if (canGo(world, o, 'closed') && o.state === 'open') out.push('close');
  if (p.lockable && held.some((k) => keyFits(world, k, o))) {
    if (canGo(world, o, 'locked') && o.state !== 'locked') out.push('lock');
    if (o.state === 'locked') out.push('unlock');
  }
  if (canGo(world, o, 'barred') && o.state !== 'barred' && o.roomId === c.location) out.push('bar');
  if (o.state === 'barred' && o.roomId === c.location) out.push('unbar');
  if (p.container && !mine && !world.objects.isClosed(o) && held.some((x) => x.id !== o.id)) out.push('put_in');
  if (p.container && !world.objects.isClosed(o) && world.objects.around(o.id, 'in').length) out.push('take_out');
  if (p.seat && !mine) out.push('sit_on');
  if (p.bed && !mine) out.push('lie_on');
  if ((p.light || p.fireSource) && LIT(world, o) && !p.lit && (flameHere || held.some((x) => x.id !== o.id && isFlame(world, x)))) out.push('light');
  if ((p.light || p.fireSource) && p.lit && UNLIT(world, o)) out.push('douse');
  if (p.water && mine && o.state !== 'full' && canGo(world, o, 'full') && waterHere) out.push('fill');
  if (p.water && mine && ['full', 'half'].includes(o.state) && canGo(world, o, 'empty')) out.push('pour');
  if (p.flammable && !p.burning && held.some((x) => x.id !== o.id && isFlame(world, x))) out.push('ignite');
  if (p.burning && held.some((x) => phys(world, x).smother)) out.push('smother');
  return out;
}

export function handleTool(world, c, fn, INNER) {
  if (!c.location || ['sleeping', 'collapsed', 'unconscious'].includes(c.activity.type)) return null;
  if (c.phys?.restraint && ['held', 'pinned', 'tied'].includes(c.phys.restraint.kind)) return null;
  const { here, carried } = world.objects.actionable(c);
  const held = carried.filter((o) => o.placement?.relation !== 'worn');
  const flameHere = here.some((o) => isFlame(world, o));
  const waterHere = hasWater(world, c) && !held.every((o) => phys(world, o).water);
  const roomWater = (world.rooms.get(c.location) && (world.physical?.waterRooms ?? ['well']).includes(c.location)) || here.some((o) => phys(world, o).water && ['full', 'half'].includes(o.state) && !o.holderId);
  const offered = new Map();
  for (const o of [...held, ...here]) {
    if (o.typeId === 'corpse') continue;
    const acts = actionsFor(world, c, o, { held, flameHere, waterHere: roomWater || waterHere });
    if (acts.length) offered.set(world.objects.alias(o), acts);
  }
  if (!offered.size) return null;
  const all = HANDLE_ACTIONS.filter((a) => [...offered.values()].some((l) => l.includes(a)));
  const present = citizensIn(world.citizens, c.location, { exceptId: c.id }).filter((o) => o.alive);
  const people = [...world.memory.labelsFor(c, present).keys()];
  const doors = here.filter((o) => isDoor(world, o)).map((o) => world.objects.alias(o));
  const targets = [...people, ...here.map((o) => world.objects.alias(o)), 'floor', 'away'];
  const list = [...offered.entries()].slice(0, 14).map(([h, a]) => `[${h}]: ${a.join(', ')}`).join('; ');
  return fn('handle', `Do something physical with a thing: throw it, push it (against a door to barricade it), break it, open or close it, lock or unlock it (with its key), bar it, put something in or take something out, sit or lie on it, light it or put it out, fill or pour it, set fire to it, smother a fire with a cloth. What you can do now: ${list}.`, {
    object: { type: 'string', enum: [...offered.keys()], description: 'Which thing, by its [handle].' },
    action: { type: 'string', enum: all, description: 'What you do with it.' },
    with: { type: 'string', enum: held.map((o) => world.objects.alias(o)), description: 'Optional: what you use (a key, a flame, a cloth, something to break it with, the thing to put in).' },
    target: { type: 'string', enum: [...new Set(targets)], description: `Optional: at whom or what (throw, pour), where to (push${doors.length ? ': a door to barricade it' : ''}, or "away"), into what (put_in).` },
    inner_thought: INNER,
  }, ['object', 'action']);
}

// ---------- doing it ----------
export function handle(world, c, call, h) {
  const a = call.arguments ?? {};
  const o = world.objects.resolve(a.object);
  const action = String(a.action ?? '');
  if (!o || (o.holderId !== c.id && o.roomId !== c.location)) return h.stale(world, c, call, 'That is not within reach any more.');
  const held = world.objects.carriedBy(c.id);
  const room = world.rooms.get(c.location);
  const flameHere = world.objects.inRoom(c.location).some((x) => isFlame(world, x));
  const waterHere = hasWater(world, c) || (world.physical?.waterRooms ?? ['well']).includes(c.location);
  const allowed = actionsFor(world, c, o, { held, flameHere, waterHere });
  if (!allowed.includes(action)) return h.stale(world, c, call, why(world, c, o, action));
  const withObj = a.with ? world.objects.resolve(a.with) : null;
  if (withObj && withObj.holderId !== c.id) return h.stale(world, c, call, "You don't have that in your hands any more.");
  const here = citizensIn(world.citizens, c.location, { exceptId: c.id }).filter((x) => x.alive);
  const person = a.target ? h.findPerson(world, c, here, a.target) : null;
  const targetObj = a.target && !person ? world.objects.resolve(a.target) : null;
  const name = world.objects.surfaceText(o);
  const tell = (text, importance = 4, data = {}) => world.perceive(here.map((x) => x.id), { kind: 'action', text: `${ref(c)} ${text}`, importance, sourceId: c.id, roomId: c.location, data: { objectId: o.id, handle: action, ...data } });
  const me = (text, importance = 4, data = {}) => world.perceive([c.id], { kind: 'action', text, importance, sourceId: c.id, roomId: c.location, data: { objectId: o.id, handle: action, ...data } });
  let minutes = MINUTES[action] ?? 0.5;
  let doing = `${action.replace('_', ' ')} ${name}`;
  h.logAction(world, c, call, { objectId: o.id, handle: action, targetId: person?.id ?? targetObj?.id ?? null });

  switch (action) {
    case 'throw': {
      if (person) return world.physical.actOn(world, c, { ...call, name: 'act_on', arguments: { person: a.target, action: 'throw_at', with: a.object, intent: c.intents?.[person.id]?.intent, inner_thought: a.inner_thought } }, h, { logged: true });
      const spot = targetObj ? world.maps.objectSpot(targetObj) : (world.maps.spots(c.location).map((s) => s.id).filter((s) => s !== c.spot)[0] ?? c.spot);
      world.objects.change(o.id, { roomId: c.location, placement: { relation: 'floor', of: null }, data: { ...o.data, spot } }, { actorId: c.id, action: 'move', notify: false });
      if (targetObj) {
        const w = weaponProfile(world, o);
        damageObject(world, targetObj, (w.damage[0]?.base ?? 4) * combatProfile(world, c).force * 0.6, { actorId: c.id, cause: 'something thrown' });
      }
      if (phys(world, o).breakable) damageObject(world, o, 10, { actorId: c.id, cause: 'thrown' });
      if (phys(world, o).spills && phys(world, o).lit) world.physical.fire.knockedOver(o, c);
      tell(`throws ${name}${targetObj ? ` at ${world.objects.surfaceText(targetObj)}` : ' across the room'}.`, 6);
      break;
    }
    case 'push': {
      const door = targetObj && isDoor(world, targetObj) && targetObj.roomId === c.location ? targetObj : null;
      const force = combatProfile(world, c).force;
      const heavy = phys(world, o).heavy;
      minutes = heavy && force < 0.7 ? 2 : 1;
      if (door) {
        const spot = world.maps.objectSpot(door) ?? world.maps.doorSpot?.(c.location) ?? c.spot;
        world.objects.change(o.id, { data: { ...o.data, barricade: door.id, spot } }, { actorId: c.id, action: 'move', notify: false });
        doing = `pushing ${name} against the door`;
        tell(`pushes ${name} against ${world.objects.surfaceText(door)}.`, 6, { barricade: door.id });
        world.logEvent('barricade', { actorId: c.id, location: c.location, objectId: o.id, doorId: door.id });
      } else {
        const spots = world.maps.spots(c.location).map((s) => s.id).filter((s) => s !== world.maps.objectSpot(o));
        const to = targetObj ? world.maps.objectSpot(targetObj) : spots[Math.floor(roll(world) * spots.length)] ?? null;
        const was = o.data?.barricade;
        world.objects.change(o.id, { data: { ...o.data, barricade: null, ...(to ? { spot: to } : {}) } }, { actorId: c.id, action: 'move', notify: false });
        doing = `pushing ${name} aside`;
        tell(`pushes ${name} ${was ? 'away from the door' : 'aside'}.`, was ? 6 : 4);
        if (was) world.logEvent('barricade_removed', { actorId: c.id, location: c.location, objectId: o.id, doorId: was });
      }
      break;
    }
    case 'break': {
      const w = withObj ? weaponProfile(world, withObj) : null;
      const force = combatProfile(world, c).force;
      const base = w ? Math.max(...w.damage.map((d) => d.base)) : 6;
      const strength = isDoor(world, o) ? doorStrength(world, o) : phys(world, o).durability;
      const share = isDoor(world, o) ? phys(world, o).durability / Math.max(1, strength) : 1;
      const amount = base * force * 1.6 * share * rnd(world, 0.7, 1.3);
      const r = damageObject(world, o, amount, { actorId: c.id, cause: 'broken' });
      if (withObj) damageObject(world, withObj, 2, { actorId: c.id, cause: 'used to break something' });
      tell(r.broke ? `smashes ${name}.` : `hammers at ${name}${r.durability < phys(world, o).maxDurability * 0.5 ? '; it is starting to give' : ''}.`, r.broke ? 7 : 5, { broke: r.broke });
      if (r.broke && isDoor(world, o)) {
        for (const b of barricadeOf(world, o)) world.objects.change(b.id, { data: { ...b.data, barricade: null } }, { actorId: 'code', action: 'move', notify: false });
        const other = world.maps.doorTarget?.(o) ?? null;
        if (other) world.perceive(citizensIn(world.citizens, other).map((x) => x.id), { kind: 'action', text: 'With a crash, the door gives way.', importance: 8, roomId: other, data: { door: o.id } });
        const homeOf = world.rooms.get(o.roomId)?.owner;
        if (homeOf && homeOf !== c.id) world.physical.consequences.crime(c, world.citizens.get(homeOf) ?? null, 'breaking_in', 2, { objectId: o.id });
      }
      doing = `breaking ${name}`;
      break;
    }
    case 'open': case 'close': case 'bar': case 'unbar': case 'lock': case 'unlock': {
      const to = { open: 'open', close: 'closed', bar: 'barred', unbar: 'closed', lock: 'locked', unlock: 'closed' }[action];
      if (action === 'open' && barricadeOf(world, o).length) return h.stale(world, c, call, `${barricadeOf(world, o).map((b) => world.objects.surfaceText(b)).join(' and ')} ${barricadeOf(world, o).length > 1 ? 'are' : 'is'} pushed against it; move ${barricadeOf(world, o).length > 1 ? 'them' : 'it'} first.`);
      world.objects.change(o.id, { state: to }, { actorId: c.id, action: 'state', notify: false });
      tell(`${{ open: 'opens', close: 'closes', bar: 'bars', unbar: 'unbars', lock: 'locks', unlock: 'unlocks' }[action]} ${name}.`, action === 'bar' || action === 'lock' ? 5 : 3);
      break;
    }
    case 'put_in': {
      const thing = withObj && withObj.id !== o.id ? withObj : held.find((x) => x.id !== o.id);
      if (!thing) return h.stale(world, c, call, 'You have nothing to put in it.');
      world.objects.change(thing.id, { roomId: c.location, placement: { relation: 'in', of: o.id } }, { actorId: c.id, action: 'put', notify: false });
      tell(`puts something into ${name}.`, 3);
      break;
    }
    case 'take_out': {
      const inside = world.objects.around(o.id, 'in');
      const thing = (targetObj && inside.includes(targetObj) ? targetObj : null) ?? inside[0];
      if (!thing) return h.stale(world, c, call, 'There is nothing inside.');
      if ((world.objects.freeSlots?.(c.id) ?? 1) < (world.objects.type(thing)?.size ?? 1)) return h.stale(world, c, call, 'Your hands are full.');
      world.objects.change(thing.id, { holderId: c.id }, { actorId: c.id, action: 'take', notify: false });
      me(`You take ${world.objects.surfaceText(thing)} out of ${name}.`, 3);
      tell(`takes something out of ${name}.`, 3);
      break;
    }
    case 'sit_on': case 'lie_on': {
      doing = action === 'sit_on' ? `sitting on ${name}` : `lying on ${name}`;
      tell(`${action === 'sit_on' ? 'sits down on' : 'lies down on'} ${name}.`, 2);
      break;
    }
    case 'light': {
      const to = LIT(world, o);
      world.objects.change(o.id, { state: to }, { actorId: c.id, action: 'state', notify: false });
      tell(`lights ${name}.`, 3);
      break;
    }
    case 'douse': {
      world.objects.change(o.id, { state: UNLIT(world, o) }, { actorId: c.id, action: 'state', notify: false });
      tell(`puts out ${name}.`, 3);
      break;
    }
    case 'fill': {
      world.objects.change(o.id, { state: 'full' }, { actorId: c.id, action: 'state', notify: false });
      tell(`fills ${name} with water.`, 2);
      break;
    }
    case 'pour': {
      world.objects.change(o.id, { state: 'empty' }, { actorId: c.id, action: 'state', notify: false });
      if (person) {
        world.perceive([person.id], { kind: 'action', text: `${ref(c)} empties ${name} over you. Cold water soaks you to the skin.`, importance: 8, sourceId: c.id, roomId: c.location, data: { wet: true, interrupt: true, wake: true } });
        world.emotions.bump(person, { type: 'anger', target: c.id, delta: 1.5, cause: `${ref(c)} soaked me with cold water`, source: 'violence', raw: true });
        person.phys = { ...(person.phys ?? {}), wetUntil: world.now + 120 };
        if (person.activity.type === 'sleeping' || person.activity.type === 'collapsed') world.body?.addCondition?.(person, { type: 'chill', partId: 'torso', severity: 1, cause: 'doused with cold water', sourceId: c.id });
        tell(`empties ${name} over ${ref(person)}.`, 6);
      } else {
        const burningTarget = targetObj?.data?.burning ? targetObj : world.physical.fire.burning(c.location).sort((x, y) => (world.maps.objectSpot(x) === c.spot ? -1 : 0) - (world.maps.objectSpot(y) === c.spot ? -1 : 0))[0];
        if (burningTarget) {
          const r = world.rooms.get(c.location)?.onFire ? world.physical.fire.pourRoom(c.location, c) : world.physical.fire.pour(burningTarget, c);
          tell(`throws ${name} of water on the fire${r === 'out' ? '; it goes out' : r === 'less' ? '; the flames hiss and shrink' : ''}.`, 6, { water: true });
        } else {
          tell(`pours ${name} out on the floor.`, 2);
          world.decals?.add({ kind: 'puddle', roomId: c.location, spot: c.spot, intensity: 0.6, source: `pour-${o.id}-${Math.round(world.now)}` });
        }
      }
      break;
    }
    case 'ignite': {
      const lit = world.physical.fire.ignite(o, { by: c, cause: 'set alight' });
      if (!lit) return h.stale(world, c, call, `${name} won't catch.`);
      const owner = o.ownerId && o.ownerId !== c.id ? world.citizens.get(o.ownerId) : null;
      const homeOwner = world.rooms.get(c.location)?.owner && world.rooms.get(c.location).owner !== c.id ? world.citizens.get(world.rooms.get(c.location).owner) : null;
      const inside = here.filter((x) => x.alive);
      if (owner || homeOwner || inside.length) {
        world.physical.consequences.crime(c, owner ?? homeOwner ?? inside[0] ?? null, 'arson', inside.some((x) => ['sleeping', 'collapsed'].includes(x.activity.type)) ? 5 : 4, { objectId: o.id, peopleInside: inside.map((x) => x.id) });
        c.deeds = [...(c.deeds ?? []), { id: `dd-arson-${o.id}`, at: world.now, lastAt: world.now, victimId: (owner ?? homeOwner ?? inside[0])?.id ?? c.id, altId: null, acts: {}, with: [], effects: ['arson'], parts: [], intent: 'hurt', serious: true, until: world.now + 3 * 1440, place: c.location, arson: o.id }];
        world.memory.pushOnMind(c, { text: `I set fire to ${name}.`, importance: 9, pinnedUntil: world.now + 3 * 1440 });
      }
      tell(`holds a flame to ${name}.`, 8, { fire: o.id });
      break;
    }
    case 'smother': {
      const cloth = withObj && phys(world, withObj).smother ? withObj : held.find((x) => phys(world, x).smother);
      const r = world.physical.fire.smother(o, c);
      if (r !== 'out') {
        tell(`beats at the flames on ${name} with ${cloth ? world.objects.surfaceText(cloth) : 'a cloth'}, but the fire is too big.`, 7);
        if (cloth && roll(world) < 0.3) { world.objects.change(cloth.id, { roomId: c.location, placement: { relation: 'floor', of: null } }, { actorId: c.id, action: 'move', notify: false }); world.physical.fire.ignite(world.objects.get(cloth.id), { by: c, cause: 'caught while smothering', quiet: true }); }
      } else tell(`smothers the flames on ${name} with ${cloth ? world.objects.surfaceText(cloth) : 'a cloth'}.`, 6);
      break;
    }
    default: return h.stale(world, c, call, 'You hesitate.');
  }
  world.setActivity(c, { type: 'doing', until: world.now + minutes, detail: { kind: 'handle', handle: action, objectId: o.id, description: doing, minutes } });
  h.remember(world, c, `You ${action === 'push' ? 'pushed' : action.replace('_', ' ')} ${name}.`);
  return { ok: true };
}

function why(world, c, o, action) {
  const p = phys(world, o);
  const name = world.objects.surfaceText(o);
  switch (action) {
    case 'lock': case 'unlock': return `You have no key that fits ${name}.`;
    case 'light': return 'You have no flame to light it from.';
    case 'ignite': return 'You would need a flame in your hand.';
    case 'fill': return 'There is no water here to fill it with.';
    case 'smother': return 'You have nothing to smother the flames with.';
    case 'open': return o.state === 'locked' ? `${name} is locked.` : o.state === 'barred' ? `${name} is barred.` : `${name} won't open.`;
    case 'break': return p.broken ? `${name} is already broken.` : `${name} won't break.`;
    case 'push': return `${name} won't budge.`;
    default: return `You can't do that with ${name}.`;
  }
}

/** Forcing a barricaded / locked / barred door from the other side: everyone pushing there adds their force. */
export function forceDoor(world, c, door) {
  const inside = door.roomId;
  const barricade = barricadeOf(world, door);
  const pushers = citizensIn(world.citizens, c.location).filter((x) => x.alive && x.id !== c.id && x.activity.type === 'doing' && x.activity.detail?.forcing === door.id);
  const force = [c, ...pushers].reduce((s, x) => s + combatProfile(world, x).force, 0) * rnd(world, 0.75, 1.25);
  const weight = barricade.reduce((s, b) => s + (phys(world, b).heavy ? 1.2 : 0.6), 0) + (door.state === 'barred' ? 1.5 : door.state === 'locked' ? 1.2 : 0);
  const won = force > weight;
  if (won) {
    for (const b of barricade) world.objects.change(b.id, { data: { ...b.data, barricade: null } }, { actorId: c.id, action: 'move', notify: false });
    if (door.state === 'barred' || door.state === 'locked') damageObject(world, door, 999, { actorId: c.id, cause: 'forced' });
  } else if (door.state === 'barred' || door.state === 'locked') damageObject(world, door, force * 8, { actorId: c.id, cause: 'forced' });
  world.perceive(citizensIn(world.citizens, inside).map((x) => x.id), { kind: 'action', text: won ? 'The door bursts inward; whatever held it scrapes aside.' : 'Someone is throwing their weight against the door from outside.', importance: won ? 9 : 8, roomId: inside, data: { door: door.id, interrupt: true, wake: true } });
  return { won, force: Math.round(force * 100) / 100, weight };
}

export { pronouns };
