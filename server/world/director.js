// Director events: located, distance-based, lasting, and composable with EFFECTS.
//
// directorEvent(world, {
//   roomId,                      // where it happens (optional if every effect targets citizens directly)
//   radius, importance,          // who perceives it and how urgently (distance = room hops)
//   texts: { here, near, far },  // what people perceive at distance 0 / 1 / 2..radius  (all optional)
//   roomEffect: { text, durationGameMinutes },   // lasting description added to the room
//   effects: [ { type, target, notify?, importance?, ...params } ],
//   icon, label,
// })
//
// EFFECT TYPES (params) — what the event DOES, beyond being perceived:
//   damage {amount}         heal {amount}           needs {hunger?, fatigue?, hp?, mode: 'add'|'set'}
//   move {to}               sleep {hours?}          wake                    collapse            revive
//   knowPlace {place, services?}                    forgetPlace {place}
//   mark {text, minutes?}   unmark {text?}          (visible change to how someone looks)
//   goal {text, mode: 'add'|'remove'}               trait {trait, value? | delta?}
//   persona {field, text, mode: 'set'|'append'}     (appearance, personality, backstory, speechStyle, occupation)
//   roomService {room?, service: 'food'|'bed', enabled, minutes?, reason?}
//   blockExit {room?, to, minutes?, both?, reason?} unblockExit {room?, to}
//   whisper {text}
//
// OBJECT CHANGES (step 5): objectChanges: [{ objectId | type | types, state?, visibility?, surfaceText? }]
//   applied through objects.change() with actorId 'director'. A type selector matches objects of that
//   type in the event room. state '@broken' = the type's broken state (broken / smashed / torn / ...).
//
// TARGET: 'here' | 'near' | 'far' | 'reached' (everyone who perceived the event) | 'everyone'
//         | a citizen id | an array of citizen ids.        (room-level effects ignore it)
// NOTIFY: text the affected citizen perceives (second person). `false` = silent. Omitted = a sensible
//         default for effects people would notice, but only if the event text didn't already reach them.
import { roomDistances, activeEffects, citizensIn } from './rooms.js';
import { clampImportance, IMPORTANCE } from './perception.js';
import { learnPlace, forgetPlace } from './places.js';
import { serviceNames } from './rooms.js';
import { relocate, startSleep, wake, collapse, revive } from './actions.js';
import { BROKEN_STATES } from './objects.js';

const TRAITS = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'];
const PERSONA_FIELDS = ['appearance', 'personality', 'backstory', 'speechStyle', 'occupation'];

export const EFFECT_TYPES = {
  damage: { label: 'Damage', notify: 'Pain shoots through you.', importance: 7 },
  heal: { label: 'Heal', notify: 'You feel some of your strength come back.', importance: 4 },
  needs: { label: 'Change needs', notify: null },
  move: { label: 'Move to room', notify: null },
  sleep: { label: 'Put to sleep', notify: null },
  wake: { label: 'Wake up', notify: null },
  collapse: { label: 'Knock out', notify: null },
  revive: { label: 'Revive', notify: null },
  knowPlace: { label: 'Teach a place', notify: 'It comes back to you: {place}.', importance: 4 },
  forgetPlace: { label: 'Forget a place', notify: null },
  mark: { label: 'Change appearance (temporary)', notify: null },
  unmark: { label: 'Remove appearance change', notify: null },
  goal: { label: 'Add/remove goal', notify: null },
  trait: { label: 'Change trait', notify: null },
  persona: { label: 'Change persona', notify: null },
  roomService: { label: 'Room service on/off', notify: null, room: true },
  blockExit: { label: 'Block a path', notify: null, room: true },
  unblockExit: { label: 'Unblock a path', notify: null, room: true },
  whisper: { label: 'Private message', notify: null, importance: 7 },
};

export function directorEvent(world, input) {
  const { roomId = null } = input;
  const everywhere = roomId === '*';
  const room = roomId && !everywhere ? world.rooms.get(roomId) : null;
  if (roomId && !everywhere && !room) throw httpError(400, `unknown room "${roomId}"`);
  const effects = Array.isArray(input.effects) ? [...input.effects] : [];
  if (Number(input.damage?.hp) > 0) effects.push({ type: 'damage', target: 'here', amount: Number(input.damage.hp) }); // legacy
  for (const e of effects) validateEffect(world, e, room);

  const sub = (t) => String(t ?? '').trim().replace(/\{room\}/g, room?.name ?? 'somewhere');
  const texts = { here: sub(input.texts?.here ?? input.text), near: sub(input.texts?.near), far: sub(input.texts?.far) };
  if (!texts.here && !effects.length && !input.roomEffect?.text && !input.objectChanges?.length) throw httpError(400, 'an event needs a "here" text, a room effect or at least one effect');
  const imp = input.importance == null || input.importance === '' ? IMPORTANCE.director : clampImportance(input.importance);
  const radius = everywhere ? 0 : Math.max(0, Math.min(10, Math.round(Number(input.radius) || 0)));
  const generic = room ? `You hear a commotion from the direction of ${room.name}.` : texts.here;
  const textFor = { here: texts.here, near: texts.near || texts.far || generic, far: texts.far || texts.near || generic };
  const impFor = { here: imp, near: clampImportance(imp - 2), far: Math.max(3, clampImportance(imp - 4)) };

  // Who is where relative to the event (movers count as outside: never closer than 1).
  const dist = room ? roomDistances(world.rooms, room.id) : null;
  const zones = { here: [], near: [], far: [] };
  for (const c of world.citizens.values()) {
    if (!c.alive) continue;
    let d;
    if (everywhere) d = 0;
    else if (!dist) continue;
    else if (c.location) d = dist.get(c.location);
    else {
      const ds = [c.activity.detail?.from, c.activity.detail?.to].map((r) => dist.get(r)).filter((x) => x != null);
      d = ds.length ? Math.max(1, Math.min(...ds)) : undefined;
    }
    if (d == null || d > radius) continue;
    zones[d === 0 ? 'here' : d === 1 ? 'near' : 'far'].push(c);
  }
  const hasText = Boolean(texts.here);
  const reached = hasText ? [...zones.here, ...zones.near, ...zones.far] : [];

  const roomEffect = input.roomEffect?.text && room ? {
    text: sub(input.roomEffect.text),
    durationGameMinutes: Math.max(1, Math.round(Number(input.roomEffect.durationGameMinutes) || 720)),
  } : null;

  const ev = world.logEvent('director', {
    action: hasText || roomEffect ? 'event' : 'effects',
    location: room?.id ?? null, roomId, radius, importance: imp, texts, icon: input.icon ?? null, label: input.label ?? null,
    roomEffect, effects: effects.map(summarizeEffect),
    delivered: reached.map((c) => ({ id: c.id, level: zones.here.includes(c) ? 'here' : zones.near.includes(c) ? 'near' : 'far' })),
  });

  if (hasText) {
    for (const level of ['here', 'near', 'far']) {
      for (const c of zones[level]) {
        world.perceive([c.id], {
          kind: 'director', text: textFor[level], importance: impFor[level], roomId: room?.id ?? null,
          data: { eventId: ev.id, level, interrupt: level === 'here' && impFor.here >= 8 },
        });
      }
    }
  }
  if (roomEffect) {
    room.effects = activeEffects(room, world.now);
    room.effects.push({ id: `fx${ev.id}`, text: roomEffect.text, until: world.now + roomEffect.durationGameMinutes, sourceEventId: ev.id });
    world.hooks.onRoomEffect?.(room, room.effects.at(-1), { eventId: ev.id }); // step 9: lasting marks (decals)
    world.saveRoom(room);
  }

  const ctx = { world, room, zones, reached: new Set(reached.map((c) => c.id)), eventId: ev.id };
  const applied = effects.map((e) => applyEffect(ctx, e));
  // step 9.5 (B3.3): an event that does damage puts the village on edge (+1 dread)
  const damaging = effects.some((e) => ['damage', 'injure', 'injury', 'kill'].includes(e.type))
    || /explo|blast|fire|burn|collaps|smash|blood|shatter|crash/i.test(`${roomEffect?.text ?? ''} ${texts.here ?? ''}`);
  if (damaging && room && world.deaths) world.deaths.raiseDread(world.maps.mapOf(room.id) ?? 'village', 1, `an incident at ${room.name}`);
  const objectChanges = applyObjectChanges(world, room, input.objectChanges, ev.id);
  return {
    eventId: ev.id,
    objectChanges,
    delivered: reached.map((c) => ({ id: c.id, level: zones.here.includes(c) ? 'here' : zones.near.includes(c) ? 'near' : 'far' })),
    effects: applied,
  };
}

// ---------- object changes ----------
function applyObjectChanges(world, room, list, eventId) {
  if (!Array.isArray(list) || !list.length) return [];
  const O = world.objects;
  const out = [];
  for (const ch of list) {
    if (!ch || typeof ch !== 'object') continue;
    let targets = [];
    if (ch.objectId) targets = [O.get(ch.objectId)].filter(Boolean);
    else if (room) {
      const types = new Set([ch.type, ...(Array.isArray(ch.types) ? ch.types : [])].filter(Boolean));
      targets = O.inRoom(room.id).filter((o) => types.has(o.typeId));
    }
    for (const o of targets) {
      const type = O.type(o);
      const patch = {};
      if (ch.state) {
        const st = ch.state === '@broken' ? type.states.find((s) => BROKEN_STATES.has(s)) : ch.state;
        if (st && type.states.includes(st) && st !== o.state) {
          patch.state = st;
          patch.surfaceText = ch.surfaceText ?? null; // a custom look would hide the new state
        }
      } else if (ch.surfaceText !== undefined) patch.surfaceText = ch.surfaceText;
      if (ch.visibility) patch.visibility = ch.visibility;
      if (!Object.keys(patch).length) continue;
      try {
        O.change(o.id, patch, { actorId: 'director', action: patch.state ? 'state' : 'edit', notify: false, roomId: o.roomId, extra: { sourceEventId: eventId } });
        out.push({ objectId: o.id, ...patch });
      } catch (err) {
        out.push({ objectId: o.id, error: err.message });
      }
    }
  }
  return out;
}

// ---------- targets ----------
function resolveTargets(ctx, target) {
  const { world, zones } = ctx;
  const alive = (c) => c && c.alive;
  if (Array.isArray(target)) return target.map((id) => world.citizens.get(id)).filter(alive);
  switch (target ?? 'here') {
    case 'here': return zones.here;
    case 'near': return zones.near;
    case 'far': return zones.far;
    case 'reached': return [...zones.here, ...zones.near, ...zones.far];
    case 'everyone': return [...world.citizens.values()].filter(alive);
    default: return [world.citizens.get(target)].filter(alive);
  }
}

function validateEffect(world, e, room) {
  if (!e || typeof e !== 'object') throw httpError(400, 'each effect must be an object');
  const def = EFFECT_TYPES[e.type];
  if (!def) throw httpError(400, `unknown effect type "${e.type}" (have: ${Object.keys(EFFECT_TYPES).join(', ')})`);
  const needRoom = (id) => {
    if (!world.rooms.has(id)) throw httpError(400, `${e.type}: unknown room "${id}"`);
  };
  if (def.room) needRoom(e.room ?? room?.id);
  if (e.type === 'move') needRoom(e.to);
  if (e.type === 'knowPlace' || e.type === 'forgetPlace') needRoom(e.place);
  if (e.type === 'blockExit' || e.type === 'unblockExit') {
    const r = world.rooms.get(e.room ?? room?.id);
    if (!r.exits.some((x) => x.to === e.to)) throw httpError(400, `${e.type}: ${r.id} has no exit to "${e.to}"`);
  }
  if (e.type === 'trait' && !TRAITS.includes(e.trait)) throw httpError(400, `trait must be one of ${TRAITS.join(', ')}`);
  if (e.type === 'persona' && !PERSONA_FIELDS.includes(e.field)) throw httpError(400, `persona.field must be one of ${PERSONA_FIELDS.join(', ')}`);
  if (['mark', 'goal', 'whisper', 'persona'].includes(e.type) && !String(e.text ?? '').trim()) throw httpError(400, `${e.type}: text is required`);
  if (e.type === 'roomService' && !['food', 'bed'].includes(e.service)) throw httpError(400, 'roomService.service must be food or bed');
  const target = e.target;
  if (!def.room && typeof target === 'string' && !['here', 'near', 'far', 'reached', 'everyone'].includes(target) && !world.citizens.has(target)) {
    throw httpError(400, `${e.type}: unknown target "${target}"`);
  }
}

function summarizeEffect(e) {
  const { notify, ...rest } = e;
  return { ...rest, ...(notify === false ? { silent: true } : notify ? { notify } : {}) };
}

// ---------- applying ----------
function applyEffect(ctx, e) {
  const { world, room } = ctx;
  const def = EFFECT_TYPES[e.type];
  const now = world.now;
  const minutes = Number(e.minutes) > 0 ? Number(e.minutes) : null;

  // Room-level effects (no citizen target)
  if (def.room) {
    const r = world.rooms.get(e.room ?? room?.id);
    if (e.type === 'roomService') {
      r.serviceOverrides ??= {};
      if (e.enabled === false) r.serviceOverrides[e.service] = { enabled: false, until: minutes ? now + minutes : null, reason: e.reason ?? null };
      else delete r.serviceOverrides[e.service];
    } else if (e.type === 'blockExit') {
      const until = minutes ? now + minutes : null;
      const add = (from, to) => {
        from.blockedExits = (from.blockedExits ?? []).filter((b) => b.to !== to);
        from.blockedExits.push({ to, until, reason: e.reason ?? null });
      };
      add(r, e.to);
      const back = world.rooms.get(e.to);
      if (e.both !== false && back?.exits.some((x) => x.to === r.id)) {
        add(back, r.id);
        world.saveRoom(back);
      }
    } else if (e.type === 'unblockExit') {
      r.blockedExits = (r.blockedExits ?? []).filter((b) => b.to !== e.to);
      const back = world.rooms.get(e.to);
      if (back) {
        back.blockedExits = (back.blockedExits ?? []).filter((b) => b.to !== r.id);
        world.saveRoom(back);
      }
    }
    world.saveRoom(r);
    world.logEvent('director_effect', { location: r.id, type: e.type, ...summarizeEffect(e), sourceEventId: ctx.eventId });
    return { type: e.type, room: r.id };
  }

  const targets = resolveTargets(ctx, e.target);
  for (const c of targets) {
    const changed = applyToCitizen(world, c, e, now, minutes);
    // Notify: explicit text, or a default for noticeable effects when the event text didn't reach them.
    if (e.notify !== false && changed) {
      const tmpl = e.notify ?? (ctx.reached.has(c.id) ? null : def.notify);
      const text = tmpl && String(tmpl).replace(/\{place\}/g, world.rooms.get(e.place)?.name ?? '').replace(/\{room\}/g, room?.name ?? '');
      if (text) {
        const imp = clampImportance(e.importance ?? def.importance ?? 6);
        world.perceive([c.id], { kind: 'director', text, importance: imp, roomId: c.location, data: { eventId: ctx.eventId, effect: e.type, interrupt: imp >= 8 } });
      }
    }
  }
  if (targets.length) {
    world.logEvent('director_effect', {
      location: room?.id ?? null, type: e.type, targets: targets.map((c) => c.id), ...summarizeEffect(e), sourceEventId: ctx.eventId,
    });
  }
  return { type: e.type, targets: targets.map((c) => c.id) };
}

/** Returns true if the citizen was actually affected. */
function applyToCitizen(world, c, e, now, minutes) {
  const n = c.needs;
  switch (e.type) {
    case 'damage': {
      // step 7B: damage is a real hit on a body part, resolved by the damage API (a profile list, or one blunt hit)
      const amount = Math.max(0, Number(e.amount) || 0);
      const cause = e.cause ?? 'a director event';
      const hits = Array.isArray(e.profile) && e.profile.length ? e.profile : amount > 0 ? [{ damageType: e.damageType ?? 'blunt', part: e.part ?? 'random', amount }] : [];
      for (const h of hits) world.body.applyProfileEntry(c, h, cause, null);
      world.logEvent('damage', { actorId: c.id, location: c.location, amount, vitality: Math.round(c.body?.vitality ?? 0), blood: Math.round(c.body?.blood ?? 100) });
      break;
    }
    case 'heal':
      // step 7B: external healing (director): reduces severities; vitality comes back with it
      world.body.heal(c.id, { all: true, amount: Math.max(0, Number(e.amount) || 0) / 4, source: 'director' });
      if (c.body) c.body.vitality = Math.min(100, c.body.vitality + Math.max(0, Number(e.amount) || 0));
      world.body.afterChange(c);
      break;
    case 'needs': {
      for (const k of ['hunger', 'fatigue', 'hp']) {
        if (e[k] == null || e[k] === '') continue;
        const v = Number(e[k]);
        if (!Number.isFinite(v)) continue;
        if (k === 'hp') { // step 7B: "hp" is vitality
          if (c.body) c.body.vitality = Math.min(100, Math.max(0, e.mode === 'add' ? c.body.vitality + v : v));
          continue;
        }
        n[k] = Math.min(100, Math.max(0, e.mode === 'add' ? n[k] + v : v));
      }
      break; // levels update on the next tick and announce themselves normally
    }
    case 'move':
      return relocate(world, c, e.to, { text: e.notify || null });
    case 'sleep':
      if (c.activity.type === 'sleeping' || c.activity.type === 'collapsed') return false;
      world.cancelThink(c);
      startSleep(world, c, { quality: 'rough', untilRested: !e.hours, hours: Number(e.hours) || null, forced: true });
      return false; // asleep: a notification would only end up in the dream buffer
    case 'wake':
      if (c.activity.type !== 'sleeping') return false;
      wake(world, c, { reason: 'director' });
      return false;
    case 'collapse':
      if (c.activity.type === 'collapsed') return false;
      collapse(world, c, { reason: 'director' });
      return false;
    case 'revive':
      revive(world, c, { by: 'director', text: e.notify || null }); // tells the citizen itself
      return false;
    case 'knowPlace': {
      const r = world.rooms.get(e.place);
      const services = Array.isArray(e.services) ? e.services : serviceNames(r, now);
      if (!learnPlace(c, r.id, services, 'director', now)) return false;
      break;
    }
    case 'forgetPlace':
      if (!forgetPlace(c, e.place)) return false;
      break;
    case 'mark':
      c.marks = (c.marks ?? []).filter((m) => m.until == null || m.until > now);
      c.marks.push({ id: `mk${Date.now().toString(36)}`, text: String(e.text).trim(), until: minutes ? now + minutes : null });
      break;
    case 'unmark':
      c.marks = e.text ? (c.marks ?? []).filter((m) => !m.text.includes(e.text)) : [];
      break;
    case 'goal': {
      const text = String(e.text).trim();
      if (e.mode === 'remove') c.persona.goals = c.persona.goals.filter((g) => !g.toLowerCase().includes(text.toLowerCase()));
      else if (!c.persona.goals.includes(text)) c.persona.goals.push(text);
      break;
    }
    case 'trait': {
      const cur = Number(c.persona.traits[e.trait] ?? 0.5);
      const v = e.value != null && e.value !== '' ? Number(e.value) : cur + Number(e.delta || 0);
      c.persona.traits[e.trait] = Math.min(1, Math.max(0, Math.round(v * 100) / 100));
      break;
    }
    case 'persona': {
      const text = String(e.text).trim();
      c.persona[e.field] = e.mode === 'append' && c.persona[e.field] ? `${c.persona[e.field]} ${text}` : text;
      break;
    }
    case 'whisper':
      world.perceive([c.id], {
        kind: 'director', text: String(e.text).trim(), importance: clampImportance(e.importance ?? 7), roomId: c.location,
        data: { effect: 'whisper', interrupt: (e.importance ?? 7) >= 8 },
      });
      return false; // already perceived
    default:
      return false;
  }
  world.saveCitizen(c);
  return true;
}

/** Expire temporary marks / service overrides / blocked exits (called from the World tick). */
export function expireDirectorState(world, now) {
  for (const c of world.citizens.values()) {
    if (c.marks?.some((m) => m.until != null && m.until <= now)) {
      c.marks = c.marks.filter((m) => m.until == null || m.until > now);
      world.saveCitizen(c);
    }
  }
  for (const r of world.rooms.values()) {
    let dirty = false;
    for (const [k, o] of Object.entries(r.serviceOverrides ?? {})) {
      if (o?.until != null && o.until <= now) {
        delete r.serviceOverrides[k];
        dirty = true;
      }
    }
    const before = r.blockedExits?.length ?? 0;
    r.blockedExits = (r.blockedExits ?? []).filter((b) => b.until == null || b.until > now);
    if (dirty || r.blockedExits.length !== before) world.saveRoom(r);
  }
}

/** Who is in a room, for UI previews. */
export function peopleIn(world, roomId) {
  return citizensIn(world.citizens, roomId).map((c) => c.id);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
