// Step 9.5 (B4): the body over time, and what the living can do for the dead.
//
//   decay      the corpse object's state follows game time since death (still → stiff → smelling → decaying), slowed by
//              washing / laying out (+1 day) and a cold room (no lit hearth, +1 day). A smelling body puts a smell in the
//              room (a room effect, disgust for whoever is there); an unburied decaying body raises the village's dread.
//   tend_body  close_eyes · check_breath (makes the death certain) · cover (a cloth, blanket or one's own garment, laid
//              on the body: placement 'on', owner unchanged) · wash (water here or carried; 30 min) · lay_out (30 min;
//              quicker with two). Each sets a flag on the body that everyone present sees.
//   keep_vigil an ongoing watch over the body, up to 8 game hours, broken by anything of importance >= 7
//   bury       in a room with the `burial` service, with a digging tool here or in hand: 3 game hours alone, 1.5 with
//              help. The body object is removed and a grave object is created by THIS code (origin 'code') — the one
//              other thing code creates besides the body itself.
//   gathering  propose_gathering: a notice to everyone who knows the proposer
//
// Corpse data: { citizenId, diedAt, spot, eyesClosed, covered, coverId, washed, laidOut, vigil: [ids], tendedBy: [] }
import { citizensIn, activeServices } from '../world/rooms.js';
import { ref, plainRef } from '../memory/index.js';
import { pronouns } from '../world/citizens.js';
import { hasWater } from '../body/treat.js';
import { DEATH_WORDS } from './index.js';
import { setState } from '../db.js';

export const TEND_HOW = ['close_eyes', 'check_breath', 'cover', 'wash', 'lay_out'];
const TEND_MINUTES = { close_eyes: 1, check_breath: 2, cover: 2, wash: 30, lay_out: 30 };
const VIGIL_MAX_MINUTES = 8 * 60;
const BURY_MINUTES = 180;
const BURY_HELPED_MINUTES = 90;
const DAY = 1440;
const STAGES = [['still', 0], ['stiff', 6 * 60], ['smelling', DAY], ['decaying', 3 * DAY]];

export const corpseOf = (world, deadId) => world.objects.get(`body_${deadId}`) ?? null;

const isCorpse = (o) => o?.typeId === 'corpse';

// ---------- decay ----------
/** Game minutes since death, slowed by care and a cold room. */
function effectiveAge(world, o) {
  const age = world.now - (o.data?.diedAt ?? world.now);
  let delay = 0;
  if (o.data?.washed || o.data?.laidOut) delay += DAY;
  if (o.roomId && !roomIsWarm(world, o.roomId)) delay += DAY;
  // the first 24 h are not slowed (stiffening happens regardless)
  return age < DAY ? age : Math.max(DAY - 1, age - delay);
}

function roomIsWarm(world, roomId) {
  return world.objects.inRoom(roomId).some((x) => ['hearth', 'forge'].includes(x.typeId) && ['lit', 'burning', 'hot', 'roaring'].includes(x.state));
}

export function stageOf(world, o) {
  const age = effectiveAge(world, o);
  let st = 'still';
  for (const [s, at] of STAGES) if (age >= at) st = s;
  return st;
}

/** Every 10 game minutes (from Deaths.tick): states, smell, dread for the unburied. */
export function decayTick(world, now) {
  for (const o of [...world.objects.byId.values()]) {
    if (!isCorpse(o)) continue;
    const want = stageOf(world, o);
    const order = STAGES.map((s) => s[0]);
    if (order.indexOf(want) > order.indexOf(o.state) && (world.objects.type(o)?.transitions?.[o.state] ?? []).includes(want)) {
      world.objects.change(o.id, { state: want }, { actorId: 'code', action: 'state', notify: false, text: `${world.objects.short(o)} ${want === 'stiff' ? 'has gone stiff and cold' : want === 'smelling' ? 'has begun to smell' : 'is decaying'}` });
    }
    const roomId = o.roomId ?? world.citizens.get(o.holderId)?.location;
    if (!roomId) continue;
    // a sweetish smell: a room effect while the body lies there, disgust for everyone present (halved if covered)
    if (o.state === 'smelling' || o.state === 'decaying') {
      const room = world.rooms.get(roomId);
      if (room) {
        const id = `smell_${o.id}`;
        const text = o.state === 'decaying' ? 'The heavy, sweet stink of death fills the air.' : 'A sweetish smell of death hangs in the air.';
        const fx = room.effects.find((e) => e.id === id);
        if (fx) fx.until = now + 15;
        else room.effects.push({ id, text, until: now + 15, smell: true });
        world.saveRoom(room);
      }
      for (const c of citizensIn(world.citizens, roomId)) {
        if (['sleeping', 'collapsed'].includes(c.activity.type)) continue;
        c.smellAt ??= {};
        if (now - (c.smellAt[o.id] ?? -Infinity) < 60) continue;
        c.smellAt[o.id] = now;
        const d = (o.state === 'decaying' ? 3 : 2) * (o.data?.covered ? 0.5 : 1);
        world.emotions.bump(c, { type: 'disgust', target: null, delta: d, cause: 'the smell of death', source: 'appraisal', rule: 'corpse_smell' });
        c.fearedPlaces ??= {};
        c.fearedPlaces[roomId] ??= { since: now, why: 'the smell of death there' };
      }
    }
    // unburied and decaying: the village grows uneasy (+0.5 a day)
    if (o.state === 'decaying') {
      const last = o.data?.dreadAt ?? o.data?.diedAt ?? now;
      if (now - last >= DAY) {
        const map = world.maps.mapOf(roomId);
        if (map) world.deaths.raiseDread(map, 0.5, `${world.citizens.get(o.data?.citizenId)?.name ?? 'someone'} lies unburied`);
        world.objects.change(o.id, { data: { ...o.data, dreadAt: now } }, { actorId: 'code', action: 'edit', notify: false });
      }
    }
    // the dead citizen is drawn where the body is
    const dead = world.citizens.get(o.data?.citizenId);
    if (dead && !dead.alive && o.roomId && dead.location !== o.roomId) {
      dead.location = o.roomId;
      dead.spot = world.maps.objectSpot(o);
      world.saveCitizen(dead);
    }
  }
}

// ---------- what a viewer sees ----------
/** A body in WHAT'S HERE, as this viewer knows it. */
export function corpseText(world, viewer, o) {
  const id = o.data?.citizenId;
  const who = id ? world.citizens.get(id) : null;
  const rel = who ? world.memory.rel(viewer.id, who.id) : null;
  const named = who && rel?.nameKnown && rel.nameConfidence >= 0.5;
  const knows = who && world.deaths.knows(viewer, who.id);
  const p = who ? pronouns(who) : { subj: 'they', poss: 'their' };
  const care = [];
  if (o.data?.laidOut) care.push('laid out straight');
  if (o.data?.washed) care.push('washed');
  if (o.data?.eyesClosed && !o.data?.covered) care.push(`${p.poss} eyes closed`);
  const careText = care.length ? `, ${care.join(', ')}` : '';
  if (o.data?.covered) {
    if (knows && named) return `${who.name}'s body under a cloth${careText}`;
    if (named) return `someone lying under a cloth, the shape of ${who.name}`;
    return 'someone lying under a cloth, very still';
  }
  if (knows && named) return `${who.name}'s body, lying where ${p.subj} fell${careText}`;
  if (knows) return `a dead stranger${careText}`;
  if (named) return `${who.name}, lying very still on the floor`;
  return 'a stranger lying very still on the floor';
}

// ---------- tools ----------
/** Corpses this citizen can act on (here and seen, or carried). */
export function bodiesFor(world, c) {
  const { here, carried } = world.objects.actionable(c);
  return [...here, ...carried].filter(isCorpse);
}

export function customTools(world, c, fn, INNER) {
  const tools = [];
  const bodies = bodiesFor(world, c);
  const handles = bodies.map((o) => world.objects.alias(o));
  const room = world.rooms.get(c.location);
  if (bodies.length && !['sleeping', 'collapsed'].includes(c.activity.type)) {
    const { here, carried } = world.objects.actionable(c);
    const cloths = [...here, ...carried].filter((o) => (world.objects.type(o)?.tags ?? []).includes('cloth') && !isCorpse(o) && o.placement?.relation !== 'worn');
    const worn = world.objects.wornBy(c.id).filter((g) => (world.objects.type(g)?.tags ?? []).some((t) => ['garment', 'cloak', 'cloth'].includes(t)));
    const coverables = [...cloths, ...worn].map((o) => world.objects.alias(o));
    tools.push(fn('tend_body', `Do what is due to the dead: close the eyes (a moment), check for breath (to be sure), cover the body (with a cloth, a blanket, or something you wear), wash it (needs water, half an hour), or lay it out straight (half an hour, easier with help). Others here will see what you do.${(world.worldText ?? '').includes('chapel') ? '' : ''}`, {
      body: { type: 'string', enum: handles, description: 'Which body, by its [handle].' },
      how: { type: 'string', enum: TEND_HOW, description: 'What you do.' },
      ...(coverables.length ? { with: { type: 'string', enum: coverables, description: 'For cover: what you lay over the body, by its [handle].' } } : {}),
      inner_thought: INNER,
    }, ['body', 'how']));
    tools.push(fn('keep_vigil', 'Stay with the dead and keep watch, so they are not alone (up to a whole night). Anything urgent will still catch your attention.', {
      body: { type: 'string', enum: handles, description: 'Whose body you watch over, by its [handle].' },
      hours: { type: 'integer', minimum: 1, maximum: 8, description: 'Roughly how many hours.' },
      inner_thought: INNER,
    }, ['body']));
    if (activeServices(room, world.now).burial || room?.services?.burial) {
      tools.push(fn('bury', 'Dig a grave here and bury the dead. Needs a spade or other digging tool here or in your hands; about three hours alone, half that if others help dig.', {
        body: { type: 'string', enum: handles, description: 'Whom you bury, by the [handle] of the body.' },
        words: { type: 'string', description: 'Optional. A few words carved or said over the grave.' },
        inner_thought: INNER,
      }, ['body']));
    }
  }
  return tools;
}

export function gatheringTool(world, c, fn, INNER) {
  const places = Object.keys(c.knownPlaces ?? {}).filter((id) => world.rooms.has(id));
  if (!places.length) return null;
  return fn('propose_gathering', 'Call people together: tell everyone who knows you when and where to meet, and why (a burial, a meeting, a celebration). Word spreads to all who know you; each decides for themselves whether to come.', {
    place: { type: 'string', enum: places, description: `Where: ${places.map((id) => `"${id}" = ${world.rooms.get(id).name}`).join('; ')}.` },
    time: { type: 'string', description: 'When, e.g. "noon" or "18:00" or "tomorrow at dawn".' },
    purpose: { type: 'string', description: 'What for, in a few words, e.g. "to lay someone to rest" or "to talk about the thefts".' },
    inner_thought: INNER,
  }, ['place', 'time', 'purpose']);
}

// ---------- tend_body ----------
export function tendBody(world, c, call, { stale, logAction, remember }) {
  const o = world.objects.resolve(call.arguments.body);
  if (!isCorpse(o) || (o.roomId !== c.location && o.holderId !== c.id)) return stale(world, c, call, 'The body you meant is not here.');
  const how = call.arguments.how;
  const dead = world.citizens.get(o.data?.citizenId);
  let cloth = null;
  if (how === 'cover') {
    cloth = call.arguments.with ? world.objects.resolve(call.arguments.with) : null;
    if (!cloth) {
      const { here, carried } = world.objects.actionable(c);
      cloth = [...carried, ...here].find((x) => (world.objects.type(x)?.tags ?? []).includes('cloth') && !isCorpse(x)) ?? null;
    }
    if (!cloth) return stale(world, c, call, 'You have nothing to cover the body with: no cloth or blanket here, and you would have to give up something you wear.');
    if (cloth.holderId && cloth.holderId !== c.id) return stale(world, c, call, 'That is not yours to lay over the body.');
  }
  if (how === 'wash' && !hasWater(world, c)) {
    const well = Object.keys(c.knownPlaces ?? {}).find((id) => (world.rooms.get(id)?.tags ?? []).includes('water') || id === 'well');
    return stale(world, c, call, `There is no water here to wash the body with.${well ? ` You would have to carry some here — there is a bucket at ${world.rooms.get(well)?.name ?? 'the well'}.` : ''}`);
  }
  logAction(world, c, call, { objectId: o.id, deadId: dead?.id ?? null, how });
  const helpers = citizensIn(world.citizens, c.location, { exceptId: c.id }).filter((x) => x.activity.type === 'doing' && x.activity.detail?.kind === 'tend' && x.activity.detail.objectId === o.id && x.activity.detail.how === how);
  const minutes = how === 'lay_out' && helpers.length ? 15 : TEND_MINUTES[how];
  const describe = { close_eyes: 'closing the eyes of the dead', check_breath: 'feeling for breath on the still body', cover: 'covering the body', wash: 'washing the body', lay_out: 'laying out the body' }[how];
  world.setActivity(c, { type: 'doing', until: world.now + minutes, detail: { kind: 'tend', how, objectId: o.id, clothId: cloth?.id ?? null, description: describe, minutes } });
  const others = citizensIn(world.citizens, c.location, { exceptId: c.id });
  world.perceive(others.map((x) => x.id), {
    kind: 'action', text: `${ref(c)} kneels by the body and begins ${describe.replace(/^(\w+)ing/, (m) => m)}.`, importance: 6, sourceId: c.id, roomId: c.location, data: { tend: o.id },
  });
  remember(world, c, `You began ${describe}.`);
  return { ok: true };
}

export function finishTend(world, c, a) {
  const d = a.detail;
  const o = world.objects.get(d.objectId);
  world.setActivity(c, { type: 'idle' });
  if (!isCorpse(o)) return world.perceive([c.id], { kind: 'timer', text: 'The body is gone.', importance: 6, roomId: c.location });
  const dead = world.citizens.get(o.data?.citizenId);
  const p = dead ? pronouns(dead) : { subj: 'they', obj: 'them', poss: 'their' };
  const patch = { ...(o.data ?? {}), tendedBy: [...new Set([...(o.data?.tendedBy ?? []), c.id])] };
  let text = '';
  let seen = '';
  switch (d.how) {
    case 'close_eyes': patch.eyesClosed = true; text = `You close ${p.poss} eyes.`; seen = `${ref(c)} closes the eyes of the dead.`; break;
    case 'check_breath': {
      const cold = world.now - (o.data?.diedAt ?? world.now) > 60;
      text = `${cold ? `${p.subj[0].toUpperCase()}${p.subj.slice(1)} is cold. ` : ''}${p.subj[0].toUpperCase()}${p.subj.slice(1)} isn't breathing. ${dead ? plainRef(dead) : 'This person'} is dead.`;
      seen = `${ref(c)} feels for breath on the still body, and shakes ${pronouns(c).poss} head.`;
      break;
    }
    case 'cover': {
      const cloth = d.clothId ? world.objects.get(d.clothId) : null;
      if (cloth) {
        world.objects.change(cloth.id, { holderId: null, roomId: o.roomId ?? c.location, placement: { relation: 'on', of: o.id } }, { actorId: c.id, action: 'move', notify: false, text: `${world.objects.short(cloth)} is laid over the body` });
        patch.coverId = cloth.id;
      }
      patch.covered = true;
      text = `You cover ${p.obj}${cloth ? ` with ${world.objects.short(cloth)}` : ''}.`;
      seen = `${ref(c)} covers the body.`;
      break;
    }
    case 'wash': {
      patch.washed = true; text = `You wash ${p.obj} gently and carefully.`; seen = `${ref(c)} has washed the body.`;
      // carried water is used up (a bucket from the well goes from full to half, half to empty)
      const water = world.objects.carriedBy(c.id).find((x) => (world.objects.type(x)?.tags ?? []).includes('water') && ['full', 'half'].includes(x.state));
      if (water) {
        const next = water.state === 'full' ? 'half' : 'empty';
        if ((world.objects.type(water)?.transitions?.[water.state] ?? []).includes(next)) world.objects.change(water.id, { state: next }, { actorId: c.id, action: 'state', notify: false });
      }
      break;
    }
    case 'lay_out': patch.laidOut = true; patch.eyesClosed = true; text = `You lay ${p.obj} out straight, hands folded.`; seen = `${ref(c)} has laid out the body.`; break;
    default: break;
  }
  world.objects.change(o.id, { data: patch }, { actorId: c.id, action: 'edit', notify: false });
  // seeing the dead up close makes it certain
  if (dead) world.deaths.learn(c, dead.id, { how: 'found', certainty: 'certain', where: o.roomId ?? c.location });
  world.perceive([c.id], { kind: 'timer', text, importance: 6, roomId: c.location });
  const others = citizensIn(world.citizens, c.location, { exceptId: c.id });
  world.perceive(others.map((x) => x.id), { kind: 'action', text: seen, importance: 5, sourceId: c.id, roomId: c.location });
  world.logEvent('tend_body', { actorId: c.id, location: c.location, objectId: o.id, deadId: dead?.id ?? null, how: d.how });
}

// ---------- keep_vigil ----------
export function keepVigil(world, c, call, { stale, logAction, remember }) {
  const o = world.objects.resolve(call.arguments.body);
  if (!isCorpse(o) || o.roomId !== c.location) return stale(world, c, call, 'The body you meant to watch over is not here.');
  const dead = world.citizens.get(o.data?.citizenId);
  const minutes = Math.min(VIGIL_MAX_MINUTES, Math.max(60, (Number(call.arguments.hours) || 8) * 60));
  logAction(world, c, call, { objectId: o.id, deadId: dead?.id ?? null, minutes });
  world.setActivity(c, { type: 'waiting', until: world.now + minutes, detail: { kind: 'vigil', objectId: o.id, reason: `keeping vigil over ${dead ? plainRef(dead) : 'the dead'}`, minutes } });
  world.objects.change(o.id, { data: { ...o.data, vigil: [...new Set([...(o.data?.vigil ?? []), c.id])] } }, { actorId: c.id, action: 'edit', notify: false });
  if (dead && world.deaths.knows(c, dead.id)) world.emotions.bump(c, { type: 'sadness', target: dead.id, delta: 0.5, cause: `keeping watch over ${ref(dead)}`, source: 'vigil', raw: true, data: { grief: true } });
  const others = citizensIn(world.citizens, c.location, { exceptId: c.id });
  world.perceive(others.map((x) => x.id), { kind: 'action', text: `${ref(c)} keeps vigil over ${dead ? plainRef(dead) : 'the dead'}.`, importance: 5, sourceId: c.id, roomId: c.location, data: { vigil: o.id } });
  // comfort for others here who grieve the same person
  for (const x of others) {
    if (dead && world.deaths.griefFor(x, dead.id) > 0) {
      const mood = world.emotions.mood(x);
      mood.valence = Math.min(5, mood.valence + 0.5);
      world.saveCitizen(x);
    }
  }
  remember(world, c, `You began keeping vigil over ${dead ? plainRef(dead) : 'the dead'}.`);
  world.logEvent('vigil', { actorId: c.id, location: c.location, objectId: o.id, deadId: dead?.id ?? null, minutes });
  return { ok: true };
}

/** A vigil ends (timer, or something urgent): the body's vigil list forgets them. */
export function endVigil(world, c, objectId) {
  const o = world.objects.get(objectId);
  if (!isCorpse(o)) return;
  world.objects.change(o.id, { data: { ...o.data, vigil: (o.data?.vigil ?? []).filter((id) => id !== c.id) } }, { actorId: 'code', action: 'edit', notify: false });
}

// ---------- bury ----------
function diggingTool(world, c) {
  const { here, carried } = world.objects.actionable(c);
  return [...carried, ...here].find((o) => (world.objects.type(o)?.tags ?? []).includes('digging')) ?? null;
}

export function bury(world, c, call, { stale, logAction, remember }) {
  const room = world.rooms.get(c.location);
  if (!room?.services?.burial) return stale(world, c, call, 'This is no place to bury anyone.');
  const o = world.objects.resolve(call.arguments.body);
  if (!isCorpse(o) || (o.roomId !== c.location && o.holderId !== c.id)) return stale(world, c, call, 'The body is not here; you would have to bring it.');
  const tool = diggingTool(world, c);
  if (!tool) return stale(world, c, call, 'You have nothing to dig with. A spade is needed.');
  const helpers = citizensIn(world.citizens, c.location, { exceptId: c.id }).filter((x) => x.activity.type === 'doing' && (x.activity.detail?.kind === 'bury' || /dig/i.test(x.activity.detail?.description ?? '')));
  const minutes = helpers.length ? BURY_HELPED_MINUTES : BURY_MINUTES;
  const words = String(call.arguments.words ?? '').trim().slice(0, 80) || null;
  // a carried body is set down at the graves first
  if (o.holderId === c.id) world.objects.change(o.id, { holderId: null, roomId: c.location, placement: { relation: 'floor', of: null } }, { actorId: c.id, action: 'put', notify: false });
  logAction(world, c, call, { objectId: o.id, deadId: o.data?.citizenId ?? null, words });
  world.setActivity(c, { type: 'doing', until: world.now + minutes, detail: { kind: 'bury', objectId: o.id, words, description: 'digging a grave', minutes } });
  // helpers already digging finish together with the one who buries
  for (const h of helpers) if (h.activity.until > world.now + minutes) h.activity.until = world.now + minutes;
  const others = citizensIn(world.citizens, c.location, { exceptId: c.id });
  world.perceive(others.map((x) => x.id), { kind: 'action', text: `${ref(c)} begins to dig a grave.`, importance: 6, sourceId: c.id, roomId: c.location, data: { burial: o.id } });
  remember(world, c, 'You began digging a grave.');
  return { ok: true };
}

export function finishBury(world, c, a) {
  const d = a.detail;
  world.setActivity(c, { type: 'idle' });
  const o = world.objects.get(d.objectId);
  if (!isCorpse(o) || o.roomId !== c.location) {
    world.perceive([c.id], { kind: 'timer', text: 'You stop digging: the body is no longer here.', importance: 6, roomId: c.location });
    return;
  }
  const dead = world.citizens.get(o.data?.citizenId);
  const name = dead?.name ?? 'someone';
  const present = citizensIn(world.citizens, c.location);
  // whatever lay on the body (the cloth) stays here, on the floor
  for (const x of world.objects.around(o.id)) world.objects.change(x.id, { placement: { relation: 'floor', of: null } }, { actorId: 'code', action: 'move', notify: false });
  world.objects.remove(o.id, { actorId: c.id, reason: 'buried' });
  const graveId = `grave_${dead?.id ?? o.id}`;
  if (!world.objects.get(graveId)) {
    world.objects.create({
      id: graveId, type: 'grave', room: c.location, name: `${name}'s grave`, visibility: 'obvious',
      surfaceText: d.words ? `a fresh grave, marked: "${d.words}"` : 'a fresh grave',
      trueText: `${name} lies here, buried on day ${Math.floor(world.now / DAY) + 1}.`,
      data: { citizenId: dead?.id ?? null, buriedAt: world.now, buriedBy: present.map((x) => x.id), words: d.words ?? null, short: `${name}'s grave`, spot: c.spot },
    }, { actorId: 'code', origin: 'code' });
  }
  if (dead) {
    dead.buriedAt = world.now;
    dead.location = null;
    dead.spot = null;
    world.saveCitizen(dead);
  }
  world.logEvent('burial', { actorId: c.id, location: c.location, deadId: dead?.id ?? null, present: present.map((x) => x.id), words: d.words ?? null });
  world.perceive([c.id], { kind: 'timer', text: `The grave is dug and filled. ${dead ? plainRef(dead) : 'The dead'} is buried.${d.words ? ` "${d.words}"` : ''}`, importance: 7, roomId: c.location });
  world.perceive(present.filter((x) => x.id !== c.id).map((x) => x.id), { kind: 'action', text: `${ref(c)} fills in the grave. ${dead ? plainRef(dead) : 'The dead'} is buried.${d.words ? ` The words over it: "${d.words}"` : ''}`, importance: 7, sourceId: c.id, roomId: c.location });
  // mourners: grief +1, then some peace (the grief fades faster from now on)
  for (const x of present) {
    if (!dead || !world.deaths.knows(x, dead.id)) continue;
    world.emotions.bump(x, { type: 'sadness', target: dead.id, delta: 1, cause: `${plainRef(dead)} is in the ground now`, source: 'burial', raw: true, data: { grief: true } });
    for (const e of world.emotions.of(x)) if (e.type === 'sadness' && e.target === dead.id && e.data?.grief) e.data.halfLifeHours = Math.round((e.data.halfLifeHours ?? 240) * 0.8);
    world.saveCitizen(x);
  }
}

// ---------- gatherings ----------
export function proposeGathering(world, c, call, { stale, logAction, remember }) {
  const place = world.rooms.get(call.arguments.place);
  if (!place || !c.knownPlaces?.[place.id]) return stale(world, c, call, "You don't know that place well enough to send people there.");
  const time = String(call.arguments.time ?? '').trim().slice(0, 40) || 'soon';
  const purpose = String(call.arguments.purpose ?? '').trim().replace(/^to /i, '').slice(0, 120) || 'to meet';
  logAction(world, c, call, { place: place.id, time, purpose });
  const listeners = [...world.citizens.values()].filter((o) => o.alive && o.id !== c.id && o.kind === 'citizen' && world.memory.rel(o.id, c.id)?.nameKnown);
  const deadIds = (world.deaths?.knownDead(c) ?? []).filter((id) => new RegExp(`\\b${escapeRe(world.citizens.get(id)?.name ?? '#')}\\b`, 'i').test(purpose));
  world.perceive(listeners.map((o) => o.id), (o) => {
    const close = deadIds.some((id) => world.deaths.griefFor(o, id) >= 3) || (world.memory.rel(o.id, c.id)?.affinity ?? 0) >= 3;
    return {
      kind: 'system', text: `Word reaches you: ${ref(c)} says people should gather at ${place.name} (${time}) — to ${purpose}.`,
      importance: close ? 7 : 5, sourceId: c.id, data: { gathering: { place: place.id, time, purpose, by: c.id } },
    };
  });
  // telling of a death makes it known (believed) for whoever didn't know — the news travels with the notice
  for (const id of deadIds) for (const o of listeners) if (!world.deaths.knows(o, id) && DEATH_WORDS.test(purpose)) {
    const trust = world.memory.rel(o.id, c.id)?.trust ?? 0;
    world.deaths.learn(o, id, { how: `told:${c.id}`, certainty: trust < 0 ? 'doubted' : 'believed', by: c.id });
  }
  const g = { id: `g${Date.now().toString(36)}`, by: c.id, place: place.id, time, purpose, at: world.now, told: listeners.map((o) => o.id) };
  world.gatherings = [...(world.gatherings ?? []), g].slice(-30);
  setState(world.db, 'gatherings', world.gatherings);
  world.logEvent('gathering', { actorId: c.id, location: c.location, place: place.id, time, purpose, told: listeners.length });
  world.setActivity(c, { type: 'waiting', until: world.now + 5, detail: { reason: 'sending word around', minutes: 5 } });
  remember(world, c, `You sent word around: gather at ${place.name} (${time}) to ${purpose}.`);
  return { ok: true };
}

// ---------- B6.2: the belongings of the dead ----------
/** Taking a dead person's things before the burial: shameful if witnessed. Called after a successful take. */
export function onTake(world, c, o, witnessIds) {
  if (o.typeId === 'corpse') return; // carrying the dead to their rest is no theft
  // what is needed to tend the dead — a cloth, water, a blanket — is taken for them, not from them (GLM run)
  if ((world.objects.type(o)?.tags ?? []).some((t) => ['cloth', 'water', 'bedding'].includes(t))) return;
  const ownerId = o.ownerId;
  const owner = ownerId ? world.citizens.get(ownerId) : null;
  const fromHouse = [...world.citizens.values()].find((d) => !d.alive && d.home && d.home === c.location && d.buriedAt == null);
  const dead = owner && !owner.alive && owner.buriedAt == null ? owner : fromHouse;
  if (!dead || dead.id === c.id) return;
  if (world.deaths.knows(c, dead.id)) {
    world.emotions.bump(c, { type: 'shame', target: null, delta: 2, cause: `taking from ${ref(dead)} before the burial`, source: 'appraisal', rule: 'taking_from_the_dead' });
  }
  for (const id of witnessIds ?? []) {
    const w = world.citizens.get(id);
    if (!w || w.id === c.id || !world.deaths.knows(w, dead.id)) continue;
    world.relationships.change(w.id, c.id, { trust: -1.5, affinity: -1 }, { reason: `${c.name} took from ${dead.name} before ${pronouns(dead).subj} was even buried.`, source: 'witness', evidence: { objectId: o.id } });
  }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
