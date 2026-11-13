// Step 7B: treatment. No skills yet: the result comes from method fit, supply quality, the patient's state and
// randomness. Improvised care (pressure, a strip of cloth, a tourniquet, keeping still) is limited and low-impact;
// real supplies (bandages, herbs, needles, spirits, splints) are ordinary objects that lose state when used and are
// restocked at dedicated places. Nothing here restores sight, hearing, organs, the spine or lost parts.
//
//   treat       one wound at a time (a tourniquet covers everything below it on the limb)
//   examine_person   visible conditions fully, internal ones only as vague hints (detectChance() is the one place a
//               future doctor skill plugs into)
//   consent     an awake patient is told and can refuse for 5 game minutes (refuse_treatment); carrying needs accept_help
//   carry_person / put_down_person, wash_clothes
import { citizensIn } from '../world/rooms.js';
import { ref } from '../memory/index.js';
import { pronouns } from '../world/citizens.js';
import { clamp } from './content.js';
import { tearable, degradeGarment, setBloodied, wornGarments, garmentsCovering } from './garments.js';

const QUALITY_ORDER = ['untreated', 'improvised', 'poor', 'good', 'excellent'];
const FINAL = new Set(['used up', 'empty']);
const DEEP = new Set(['deep', 'penetrating']);
const PAST = {
  apply_pressure: 'pressed on', wrap_with_cloth: 'wrapped', keep_still: 'kept me still and resting', tourniquet: 'tied a tourniquet on', rinse: 'rinsed',
  clean_with_spirits: 'cleaned', bandage: 'bandaged', pack_wound: 'packed', splint: 'splinted', set_bone: 'set', stitch: 'stitched', cauterize: 'cauterized',
  herbal_remedy: 'treated with herbs', amputate: 'cut off',
};
const GERUND = {
  apply_pressure: 'pressing on', wrap_with_cloth: 'wrapping', keep_still: 'keeping still', tourniquet: 'tying a tourniquet on', rinse: 'rinsing', clean_with_spirits: 'cleaning',
  bandage: 'bandaging', pack_wound: 'packing', splint: 'splinting', set_bone: 'setting', stitch: 'stitching', cauterize: 'cauterizing', herbal_remedy: 'treating',
  amputate: 'amputating',
};

const T = (world) => world.body.content.treatments;
const hourOf = (now) => ((now % 1440) + 1440) % 1440 / 60;

// ---------- what is at hand ----------
const busy = (c) => ['collapsed', 'sleeping'].includes(c.activity.type);

/** A supply object with this tag, in hand or here (not used up). */
export function supplyFor(world, treater, tag) {
  const O = world.objects;
  // everything they notice here (not only what the prompt lists)
  const here = treater.location ? O.perceiveRoom(treater).items.map((it) => it.o) : [];
  return [...O.carriedBy(treater.id), ...here].find((o) => O.type(o)?.tags?.includes(tag) && !FINAL.has(o.state)) ?? null;
}

export function hasWater(world, c) {
  const room = world.rooms.get(c.location);
  if (!room) return false;
  if ((T(world).waterRooms ?? []).includes(room.id)) return true;
  const O = world.objects;
  return [...O.inRoom(room.id), ...O.carriedBy(c.id)].some((o) => (O.type(o)?.tags ?? []).some((t) => (T(world).waterTags ?? []).includes(t)) && !FINAL.has(o.state) && o.state !== 'empty');
}

function stateOk(world, o, list) {
  return list.includes(o.state);
}

export function hasFire(world, c) {
  const room = world.rooms.get(c.location);
  if (!room) return false;
  const F = T(world).fireStates ?? {};
  return world.objects.inRoom(room.id).some((o) => F[o.typeId]?.length && stateOk(world, o, F[o.typeId]));
}

function isDark(world, c) {
  const h = hourOf(world.now);
  if (h >= 5.5 && h < 20.5) return false;
  const L = T(world).lightStates ?? {};
  const O = world.objects;
  return !([...O.inRoom(c.location), ...O.carriedBy(c.id)].some((o) => L[o.typeId]?.includes(o.state)));
}

/** Hands free for the work: working hands minus what they hold (the supply itself doesn't count as busy). */
function freeHands(world, c, except = null) {
  const O = world.objects;
  let used = 0;
  for (const o of O.carriedBy(c.id)) if (o !== except) used += O.type(o)?.size ?? 1;
  if (c.carryingPerson) used += 2;
  if (c.activity?.detail?.kind === 'pressure') used += 1;
  return Math.max(0, O.handsOf(c.id) - used);
}

const isOpenWound = (cond) => Boolean(cond.geometry?.vessel) && !cond.geometry?.internal;
const limbRegion = (world, cond) => world.body.content.limbOf(cond.partId);

/** The garment (or cord) a cloth-based method will use, preferring their own clothes. */
function clothFor(world, treater, patient) {
  const own = tearable(world, treater.id).find((g) => g.state !== 'torn' || true);
  if (own) return { garment: own, owner: treater };
  const carried = world.objects.carriedBy(treater.id).find((o) => world.objects.type(o)?.tags?.includes('garment') && !['rags', 'destroyed'].includes(o.state));
  if (carried) return { garment: carried, owner: treater };
  if (patient && patient !== treater) {
    const theirs = tearable(world, patient.id)[0];
    if (theirs) return { garment: theirs, owner: patient };
  }
  return null;
}

// ---------- knowing conditions ----------
/** What the treater may treat on this patient: visible wounds (not hidden under intact clothes), what they found by examining, and — for themselves — what they feel. */
export function knownConditions(world, treater, patient) {
  const B = world.body;
  const conds = B.active(patient.id).filter((x) => !x.permanent && x.type !== 'anemia');
  const self = treater.id === patient.id;
  const mem = treater.knownConditions?.[patient.id] ?? {};
  const out = [];
  for (const cond of conds) {
    const found = mem[cond.id];
    if (self) {
      if (cond.geometry?.internal || (B.content.typeDef(cond.type)?.internal && !found)) { if (found) out.push({ cond, vague: true, hint: found.hint }); continue; }
      out.push({ cond, vague: false });
      continue;
    }
    const covered = cond.partId && garmentsCovering(world, patient.id, cond.partId).some((g) => g.state === 'intact' || g.state === 'worn');
    const seen = cond.visible && (!covered || cond.bleeding > 0.5 || found);
    if (seen || found?.exact) out.push({ cond, vague: false });
    else if (found?.vague) out.push({ cond, vague: true, hint: found.hint });
  }
  return out;
}

/** The chance of noticing a subtle or internal condition when examining (one place for a future doctor skill). */
export function detectChance(world, examiner, cond) {
  const X = T(world).examine;
  return clamp(X.baseChance - X.perDifficulty * (cond.detectDifficulty ?? 0), X.min, X.max);
}

const HINTS = {
  internal_bleeding: "tender and swollen under the ribs; something is wrong inside",
  organ_damage: 'tender deep inside; something is wrong in there',
  concussion: 'dazed, with unfocused eyes',
  fever: 'burning up',
  infection: 'hot and swollen around a wound',
  fracture: 'a bone that does not feel right',
  chill: 'shivering',
};

function woundLabel(world, treater, patient, k) {
  const B = world.body;
  const who = patient.id === treater.id ? 'You' : world.memory.nameFor(treater, patient.id, { start: true });
  const base = k.vague ? `something wrong${k.cond.partId ? ` around the ${B.content.partLabel(k.cond.partId)}` : ''} (${k.hint ?? 'not clear what'})` : B.woundText(k.cond).look || B.content.typeDef(k.cond.type)?.label;
  const bleed = !k.vague && k.cond.bleeding > 0.3 ? ` (${B.woundText(k.cond).bleed})` : '';
  return `${who}: ${base}${bleed}`.slice(0, 140);
}

// ---------- which methods are possible right now ----------
/** → [{ id, label, why? }] possible for this condition now (supplies, service, hands); wrong-but-possible ones are included. */
export function methodsFor(world, treater, patient, cond) {
  const M = T(world).methods;
  const out = [];
  const self = treater.id === patient.id;
  for (const [id, m] of Object.entries(M)) {
    if (self && m.selfOk === false) continue;
    const n = m.needs ?? {};
    const sup = n.supply ? supplyFor(world, treater, n.supply) : null;
    if (n.hands && !(freeHands(world, treater, sup) >= n.hands)) continue;
    if (n.supply && !sup) continue;
    if (n.supplyOrGarment && !supplyFor(world, treater, n.supplyOrGarment) && !clothFor(world, treater, patient)) continue;
    if (n.garment && !clothFor(world, treater, patient)) continue;
    if (n.garmentOrCord && !clothFor(world, treater, patient) && !supplyFor(world, treater, 'cord')) continue;
    if (n.water && !hasWater(world, treater)) continue;
    if (n.fire && !hasFire(world, treater)) continue;
    if (m.limbOnly && !limbRegion(world, cond)) continue;
    out.push({ id, label: m.label });
  }
  return out;
}

/** Everything the tools need: { wounds: [{ key, label, patientId, condId, cond }], methods: [ids] } (null if nothing to treat). */
export function treatOptions(world, treater, present) {
  if (busy(treater) || !(treater.body?.capacities?.consciousness >= 0.3)) return null;
  const wounds = [];
  const methods = new Set();
  const people = [treater, ...present.filter((o) => o.alive)];
  for (const p of people) {
    for (const k of knownConditions(world, treater, p)) {
      const ms = methodsFor(world, treater, p, k.cond);
      if (!ms.length) continue;
      for (const m of ms) methods.add(m.id);
      wounds.push({ key: woundLabel(world, treater, p, k), patientId: p.id, condId: k.cond.id, cond: k.cond });
    }
  }
  if (!wounds.length) return null;
  // labels must be unique enum values
  const seen = new Map();
  for (const w of wounds) {
    const n = (seen.get(w.key) ?? 0) + 1;
    seen.set(w.key, n);
    if (n > 1) w.key = `${w.key} [${n}]`;
  }
  return { wounds: wounds.slice(0, 12), methods: [...methods] };
}

// ---------- doing it ----------
function stepState(world, o, steps, actorId) {
  const states = world.objects.type(o)?.states ?? [];
  const i = states.indexOf(o.state);
  const next = states[Math.min(states.length - 1, i + steps)];
  if (next && next !== o.state) world.objects.change(o.id, { state: next }, { actorId, action: 'use', notify: false, text: `${world.objects.short(o)} is ${next}` });
}

function pendingFor(c, now) {
  c.pendingHelp = (c.pendingHelp ?? []).filter((p) => p.until > now);
  return c.pendingHelp;
}

export function pendingList(world, c) {
  return pendingFor(c, world.now);
}

function qualityWord(T_, q) {
  for (const [min, word] of T_.qualityWords) if (q >= min) return word;
  return 'poor';
}

function bestQuality(a, b) {
  return QUALITY_ORDER.indexOf(b) > QUALITY_ORDER.indexOf(a ?? 'untreated') ? b : a ?? 'untreated';
}

/** The action: tool `treat({ wound, method })`. Returns { ok } | { ok:false, reason }. */
export function startTreatment(world, treater, call, { stale, logAction }) {
  const present = citizensIn(world.citizens, treater.location, { exceptId: treater.id });
  const opts = treatOptions(world, treater, present);
  const wound = opts?.wounds.find((w) => w.key === call.arguments.wound);
  const method = call.arguments.method;
  const M = T(world).methods[method];
  if (!wound || !M) return stale(world, treater, call, 'You look at the wound, but cannot work out what to do for it just now.');
  const patient = world.citizens.get(wound.patientId);
  const cond = world.body.conditionById(patient.id, wound.condId);
  if (!patient || !cond || patient.location !== treater.location || !patient.alive) return stale(world, treater, call, 'The person you meant to tend to is not here any more.');
  if (!methodsFor(world, treater, patient, cond).some((m) => m.id === method)) return stale(world, treater, call, `You can't do that right now: you lack what it takes.`);
  const self = patient.id === treater.id;
  const part = cond.partId ? world.body.content.partLabel(cond.partId) : 'body';
  const minutes = M.minutesPerCm ? Math.max(M.minMinutes ?? 4, Math.round((cond.geometry?.length_cm ?? 4) * M.minutesPerCm)) : M.minutes;
  logAction(world, treater, call, { patientId: patient.id, conditionId: cond.id, method });
  const token = `${world.now}:${treater.id}:${cond.id}`;
  const gerund = GERUND[method] ?? 'treating';
  const description = `${gerund} ${self ? 'their own' : `${patient.name}'s`} ${part}`;
  const detail = { kind: 'treat', method, patientId: patient.id, conditionId: cond.id, token, description, minutes };

  // pressure takes effect at once and lasts while the presser stays at it
  if (method === 'apply_pressure') {
    cond.flags.pressure = { by: treater.id, since: world.now };
    world.body.markDirty(cond);
    world.setActivity(treater, { type: 'doing', until: world.now + 30, detail: { kind: 'pressure', patientId: patient.id, conditionId: cond.id, description: `pressing on ${self ? 'their own' : `${patient.name}'s`} ${part}`, minutes: 30 } });
    announce(world, treater, patient, method, part, self);
    world.logEvent('treatment', { actorId: treater.id, location: treater.location, patientId: patient.id, conditionId: cond.id, method, quality: 'improvised' });
    return { ok: true };
  }

  world.setActivity(treater, { type: 'doing', until: world.now + minutes, detail });
  announce(world, treater, patient, method, part, self);
  // consent: an awake patient is told and may refuse for a few minutes
  if (!self && !['sleeping', 'collapsed'].includes(patient.activity.type)) {
    const list = pendingFor(patient, world.now);
    list.push({ from: treater.id, kind: 'treat', token, until: world.now + T(world).consent.windowMinutes, conditionId: cond.id, method });
    world.perceive([patient.id], {
      kind: 'action', text: `${ref(treater)} wants to ${M.verb ?? 'treat'} your ${part}. You can accept it or refuse.`, importance: 7, sourceId: treater.id, roomId: treater.location,
      data: { interrupt: true, treatment: true },
    });
  }
  return { ok: true };
}

function announce(world, treater, patient, method, part, self) {
  const others = citizensIn(world.citizens, treater.location, { exceptId: treater.id }).filter((o) => o.id !== patient.id);
  const text = `${ref(treater)} starts ${GERUND[method] ?? 'treating'} ${self ? 'their own' : `${ref(patient)}'s`} ${part}.`;
  world.perceive(others.map((o) => o.id), { kind: 'action', text, importance: 4, sourceId: treater.id, roomId: treater.location, data: { treatment: true } });
}

/** The treatment's time is up: roll the quality and apply the effect. */
export function finishTreatment(world, treater, a) {
  const d = a.detail;
  const B = world.body;
  const patient = world.citizens.get(d.patientId);
  const cond = patient && B.conditionById(patient.id, d.conditionId);
  const M = T(world).methods[d.method];
  world.setActivity(treater, { type: 'idle' });
  if (!patient?.alive || patient.location !== treater.location || !cond || !M) {
    world.perceive([treater.id], { kind: 'timer', text: 'You stop: there is nothing more you can do here.', importance: 5, roomId: treater.location });
    return;
  }
  const self = patient.id === treater.id;
  const patientTold = patient.pendingHelp?.find((p) => p.token === d.token);
  if (patientTold?.refused) return; // refuse_treatment already stopped it
  if (patient.pendingHelp) patient.pendingHelp = patient.pendingHelp.filter((p) => p.token !== d.token);
  const part = cond.partId ? B.content.partLabel(cond.partId) : 'body';
  const who = self ? 'yourself' : ref(patient);
  const methodName = d.method;

  // can't use it any more? (supplies gone while working)
  const need = M.needs ?? {};
  let supply = need.supply ? supplyFor(world, treater, need.supply) : null;
  if (need.supply && !supply) {
    world.perceive([treater.id], { kind: 'timer', text: 'You reach for what you need, but it is not there any more.', importance: 5, roomId: treater.location });
    return;
  }
  let improvised = Boolean(M.improvised);
  // fit, supply quality, conditions
  const fit = M.fit?.[cond.type] ?? 0;
  let supplyQ = M.quality ?? 1;
  if (need.supplyOrGarment) {
    supply = supplyFor(world, treater, need.supplyOrGarment);
    if (!supply) { supplyQ = M.improvisedQuality ?? 0.6; improvised = true; }
  }
  let cf = 1;
  if (patient.activity.type === 'moving') cf *= 0.7;
  if ((treater.body?.capacities?.sight ?? 1) < 0.15) cf *= 0.4;
  if (M.twoHanded && (treater.body?.capacities && (treater.body.capacities.manipulationLeft < 0.2 || treater.body.capacities.manipulationRight < 0.2))) cf *= 0.6;
  if (isDark(world, treater)) cf *= 0.8;
  if (self) cf *= 0.7;
  const q = clamp(fit * supplyQ * cf * (0.7 + B.rng() * 0.45), 0, 1.3);
  const word = improvised ? 'improvised' : qualityWord(T(world), q);

  const result = applyMethod(world, treater, patient, cond, d.method, M, { q, word, supply, improvised, part });
  cond.treatments.push({ method: d.method, by: treater.id, quality: word, at: world.now, effective: result.effective });
  if (result.effective) cond.flags.quality = bestQuality(cond.flags.quality, word);
  B.markDirty(cond);
  treater.knownConditions ??= {};
  (treater.knownConditions[patient.id] ??= {})[cond.id] = { at: world.now, exact: true };
  world.logEvent('treatment', { actorId: treater.id, location: treater.location, patientId: patient.id, conditionId: cond.id, method: d.method, quality: word, qualityValue: Math.round(q * 100) / 100, effective: result.effective });

  world.perceive([treater.id], { kind: 'timer', text: result.text.replaceAll('{who}', who), importance: 5, roomId: treater.location });
  if (!self) {
    if (!['sleeping', 'collapsed'].includes(patient.activity.type)) {
      world.perceive([patient.id], { kind: 'action', text: `${ref(treater)} ${PAST[methodName] ?? 'treated'} your ${part}.${result.effective ? '' : ' It does not seem to help.'}`, importance: 5, sourceId: treater.id, roomId: patient.location });
    }
    if (result.effective && cond.partId) {
      world.relationships.change(patient.id, treater.id, { trust: 1, affinity: 1 }, {
        reason: `${ref(treater)} ${PAST[methodName] ?? 'treated'} my ${part} when I needed help.`, source: 'witness', evidence: { sign: 'cared_for', conditionId: cond.id },
      });
    }
  }
  B.afterChange(patient);
  if (!self) B.afterChange(treater);
}

/** The medical effect of one method. → { effective, text } */
function applyMethod(world, treater, patient, cond, id, M, { q, word, supply, improvised, part }) {
  const B = world.body;
  const O = world.objects;
  const f = cond.flags;
  const g = cond.geometry ?? {};
  const len = g.length_cm ?? 0;
  const label = B.content.typeDef(cond.type)?.label ?? cond.type;
  const nothing = (text) => ({ effective: false, text });
  const methodWord = M.label.replace(/^(tie|give|press on|wrap|pack|clean|rinse|set|splint|bandage|stitch|cauterize|amputate)\b\s*/i, '').trim();
  if (!(M.fit?.[cond.type] > 0)) {
    return nothing(`The ${id === 'splint' ? 'splint' : id === 'bandage' ? 'bandage' : id.replace(/_/g, ' ')} does nothing for the ${label}${cond.bleeding > 0.5 ? '; it keeps bleeding' : ''}.`);
  }
  if (q < 0.25) return nothing('You make a clumsy mess of it, and it does not help.');
  const useSupply = (steps = M.steps ?? 1) => { if (supply) stepState(world, supply, steps, treater.id); };
  const arterial = ['minor_arterial', 'major_arterial'].includes(g.vessel);
  switch (id) {
    case 'wrap_with_cloth': {
      if (cond.type === 'burn' && (g.area_cm2 ?? 0) / 28 > (M.maxBurn ?? 4) * 1.0 && cond.severity > (M.maxBurn ?? 4)) return nothing('The burn is too bad for a strip of cloth to do anything.');
      if (!isOpenWound(cond) && cond.type !== 'burn') return nothing(`A strip of cloth does nothing for the ${label}.`);
      const cloth = clothFor(world, treater, patient);
      if (!cloth) return nothing('There is nothing to tear a strip from.');
      degradeGarment(world, cloth.garment, len > 10 ? 2 : 1, { cause: 'torn for a bandage', actorId: treater.id });
      setBloodied(world, cloth.garment, true);
      f.wrapped = true; f.wrappedAt = world.now;
      return { effective: true, text: `You tear a strip from ${cloth.owner === treater ? 'your' : 'their'} ${O.type(cloth.garment)?.name ?? 'garment'} and bind {who}'s ${part}. It will do for now.` };
    }
    case 'keep_still': {
      const mins = M.restMinutes ?? 120;
      f.rested = true;
      world.setActivity(patient, { type: 'waiting', until: world.now + mins, detail: { reason: 'resting an injury', minutes: mins } });
      return { effective: true, text: 'You settle {who} down to rest, and keep still.' };
    }
    case 'tourniquet': {
      const region = B.content.limbOf(cond.partId);
      const side = B.content.parts.get(cond.partId)?.side;
      if (!region || !side) return nothing("A tourniquet won't go there: only on an arm or a leg.");
      const level = region === 'leg' ? `thigh_${side}` : `upper_arm_${side}`;
      const cloth = clothFor(world, treater, patient);
      const cord = !cloth ? supplyFor(world, treater, 'cord') : null;
      if (cloth) degradeGarment(world, cloth.garment, 1, { cause: 'torn for a tourniquet', actorId: treater.id });
      else if (cord) stepState(world, cord, 2, treater.id);
      if (cloth) setBloodied(world, cloth.garment, true);
      patient.body.tourniquets ??= [];
      patient.body.tourniquets.push({ part: level, at: world.now, eff: q >= 0.5 ? 1 : clamp(q + 0.4, 0.4, 1), improvised: true, by: treater.id }); // slips later (body/index.js)
      return { effective: true, text: `You pull a tight tourniquet round {who}'s ${B.content.partLabel(level)}. The bleeding below it should stop.` };
    }
    case 'rinse':
      f.cleaned = true;
      return { effective: true, text: `You rinse the dirt out of {who}'s ${part}.` };
    case 'clean_with_spirits':
      f.cleaned = true; f.spirits = true; f.painBoost = { until: world.now + 10, amount: 1 };
      useSupply();
      return { effective: true, text: `You clean {who}'s ${part} with the spirits. It stings fiercely.` };
    case 'bandage': {
      if (!isOpenWound(cond) && cond.type !== 'burn' && !(cond.type === 'fracture' && g.vessel)) return nothing(`A bandage does nothing for the ${label}.`);
      useSupply(len > 10 || (g.area_cm2 ?? 0) > 100 ? 2 : 1);
      f.bandaged = true; f.bandagedAt = world.now;
      return { effective: true, text: `You bandage {who}'s ${part} ${word === 'poor' ? 'as best you can' : word === 'excellent' ? 'neatly and firmly' : 'firmly'}.` };
    }
    case 'pack_wound': {
      if (!isOpenWound(cond)) return nothing('There is no open wound to pack.');
      useSupply(2);
      if (!supply) {
        const cloth = clothFor(world, treater, patient);
        if (cloth) { degradeGarment(world, cloth.garment, 2, { cause: 'packed into a wound', actorId: treater.id }); setBloodied(world, cloth.garment, true); }
      }
      f.packed = true; f.painBoost = { until: world.now + 20, amount: 3 };
      return { effective: true, text: `You pack the wound in {who}'s ${part} tight and press hard. It is very painful.` };
    }
    case 'splint': {
      if (cond.type !== 'fracture' && cond.type !== 'dislocation') return nothing('A splint will not help that.');
      if (supply) {
        O.change(supply.id, { holderId: patient.id, placement: { relation: 'worn' }, state: 'used' }, { actorId: treater.id, action: 'give', notify: false, text: `${O.short(supply)} is bound onto ${patient.name}` });
      }
      f.splinted = true;
      return { effective: true, text: `You bind a splint along {who}'s ${part}.` };
    }
    case 'set_bone': {
      f.painBoost = { until: world.now + 15, amount: 4 };
      if (q >= 0.5) { f.set = true; return { effective: true, text: `You set the bone in {who}'s ${part}: it clicks back into place. {who} needs a splint to keep it there.` }; }
      f.set = false; f.quality = 'poor';
      return { effective: true, text: `You try to set {who}'s ${part}, but it is not quite right.` };
    }
    case 'stitch': {
      if (!isOpenWound(cond)) return nothing('There is no open wound to sew.');
      if (arterial && !f.packed) return nothing('The wound pulses too hard to sew: it would have to be packed first.');
      if (q < 0.5) { f.cleaned = false; f.painBoost = { until: world.now + 20, amount: 3 }; f.poorStitch = true; }
      f.stitched = true; cond.clot = 1; f.clotted = true;
      return { effective: true, text: q < 0.5 ? `You stitch {who}'s ${part} shut, but it is a rough job; it will hurt and may fester.` : `You stitch {who}'s ${part} shut with small, careful stitches.` };
    }
    case 'cauterize': {
      if (!isOpenWound(cond)) return nothing('There is nothing bleeding to burn shut.');
      f.cauterized = true; f.painBoost = { until: world.now + 30, amount: 5 };
      B.addCondition(patient, { type: 'burn', partId: cond.partId, severity: clamp(Math.round(len / 2), 2, 6), cause: 'cauterized to stop the bleeding', quiet: true, flags: { quality: 'untreated' } });
      return { effective: true, text: `You press the glowing iron to {who}'s ${part}. The bleeding ${len <= 8 ? 'stops' : 'slows'}, and the smell of burnt flesh fills the air.` };
    }
    case 'herbal_remedy': {
      useSupply();
      f.herbal = true;
      return { effective: true, text: `You give {who} the herbs: they ease the ${label} and slow its progress.` };
    }
    case 'amputate': {
      const region = B.content.limbOf(cond.partId);
      if (!region) return nothing('You cannot cut that off.');
      const ids = new Set([cond.partId, ...B.content.descendants(cond.partId)]);
      for (const x of [...B.active(patient.id)]) if (ids.has(x.partId) && x.type !== 'severed') B.resolve(patient, x, 'amputated');
      B.addCondition(patient, { type: 'severed', partId: cond.partId, severity: 8, cause: 'amputated', quiet: true });
      for (const o of B.active(patient.id)) if (o.type === 'severed' && o.partId === cond.partId) o.flags.painBoost = { until: world.now + 60, amount: 6 };
      return { effective: true, text: `You cut off {who}'s ${part}. The infection can no longer spread from it, but the stump bleeds heavily.` };
    }
    default:
      return nothing('It does not seem to help.');
  }
}

// ---------- examine_person ----------
export function startExamine(world, c, call, { stale, logAction }) {
  const present = citizensIn(world.citizens, c.location, { exceptId: c.id });
  const target = present.find((o) => world.memory.labelsFor(c, [o]).has(call.arguments.person)) ?? world.citizens.get(call.arguments.person);
  if (!target || target.location !== c.location || !target.alive) return stale(world, c, call, 'The person you meant to examine is not here any more.');
  const minutes = T(world).examine.minutes;
  const sense = (c.body?.status ?? []).includes('blind') ? ' by touch' : '';
  logAction(world, c, call, { targetId: target.id });
  const token = `${world.now}:${c.id}:exam`;
  world.setActivity(c, { type: 'doing', until: world.now + minutes + (sense ? 3 : 0), detail: { kind: 'examine_person', targetId: target.id, token, description: `looking ${target.name} over${sense}`, minutes } });
  if (!['sleeping', 'collapsed'].includes(target.activity.type)) {
    pendingFor(target, world.now).push({ from: c.id, kind: 'examine', token, until: world.now + T(world).consent.windowMinutes });
    world.perceive([target.id], { kind: 'action', text: `${ref(c)} wants to look you over for injuries. You can accept it or refuse.`, importance: 6, sourceId: c.id, roomId: c.location, data: { interrupt: true } });
  }
  world.perceive(present.filter((o) => o.id !== target.id).map((o) => o.id), { kind: 'action', text: `${ref(c)} looks ${ref(target)} over carefully${sense}.`, importance: 3, sourceId: c.id, roomId: c.location });
  return { ok: true };
}

export function finishExamine(world, c, a) {
  const d = a.detail;
  const target = world.citizens.get(d.targetId);
  world.setActivity(c, { type: 'idle' });
  if (!target?.alive || target.location !== c.location) { world.perceive([c.id], { kind: 'timer', text: 'You straighten up: the person has gone.', importance: 4, roomId: c.location }); return; }
  if (target.pendingHelp?.some((p) => p.token === d.token && p.refused)) return;
  target.pendingHelp = (target.pendingHelp ?? []).filter((p) => p.token !== d.token);
  const B = world.body;
  c.knownConditions ??= {};
  const mine = (c.knownConditions[target.id] ??= {});
  const found = [];
  for (const cond of B.active(target.id)) {
    if (cond.permanent && cond.type !== 'scar' && cond.type !== 'limp') continue;
    if (cond.visible) {
      mine[cond.id] = { at: world.now, exact: true };
      if (cond.type !== 'scar') found.push(`${B.woundText(cond).look}${cond.bleeding > 0.3 ? ` (${B.woundText(cond).bleed})` : ''}`);
      continue;
    }
    if (B.rng() < detectChance(world, c, cond) * ((c.body?.capacities?.sight ?? 1) >= 0.15 ? 1 : 0.5)) {
      const hint = HINTS[cond.type] ?? 'something is not right';
      mine[cond.id] = { at: world.now, vague: true, hint };
      found.push(`${hint}${cond.partId ? ` (around the ${B.content.partLabel(cond.partId)})` : ''}`);
    }
  }
  const who = ref(target);
  world.perceive([c.id], { kind: 'timer', text: found.length ? `You look ${who} over and find: ${found.join('; ')}.` : `You look ${who} over and find nothing wrong that you can tell.`, importance: 6, roomId: c.location, data: { examined: target.id } });
  world.logEvent('examine_person', { actorId: c.id, location: c.location, targetId: target.id, found: found.length });
  if (!['sleeping', 'collapsed'].includes(target.activity.type)) world.perceive([target.id], { kind: 'action', text: `${ref(c)} looks you over carefully.`, importance: 3, sourceId: c.id, roomId: c.location });
}

// ---------- consent ----------
export function refuseTreatment(world, c, call, { stale, logAction }) {
  const from = world.citizens.get(call.arguments.from) ?? [...world.citizens.values()].find((o) => world.memory.labelsFor(c, [o]).has(call.arguments.from));
  const list = pendingFor(c, world.now);
  const req = list.find((p) => p.from === from?.id);
  if (!from || !req) return stale(world, c, call, 'Nobody is trying to help you right now.');
  logAction(world, c, call, { fromId: from.id });
  req.refused = true;
  if (from.activity.detail?.token === req.token) world.setActivity(from, { type: 'idle' });
  c.pendingHelp = list.filter((p) => p !== req);
  world.perceive([from.id], { kind: 'action', text: `${ref(c)} pushes your hands away and refuses your help.`, importance: 6, sourceId: c.id, roomId: c.location });
  world.relationships.change(from.id, c.id, { affinity: -0.5 }, { reason: `${ref(c)} pushed my help away.`, source: 'witness', evidence: { sign: 'refused_help' } });
  world.setActivity(c, { type: 'idle' });
  return { ok: true };
}

export function acceptHelp(world, c, call, { stale, logAction }) {
  const from = world.citizens.get(call.arguments.from) ?? [...world.citizens.values()].find((o) => world.memory.labelsFor(c, [o]).has(call.arguments.from));
  const req = pendingFor(c, world.now).find((p) => p.from === from?.id && p.kind === 'carry');
  if (!from || !req) return stale(world, c, call, 'Nobody is offering to carry you.');
  logAction(world, c, call, { fromId: from.id });
  c.pendingHelp = (c.pendingHelp ?? []).filter((p) => p !== req);
  beginCarry(world, from, c);
  world.setActivity(c, { type: 'idle' });
  return { ok: true };
}

// ---------- carrying people ----------
export function carriable(world, c, o) {
  return o.alive && o.location === c.location && !o.carriedBy && (o.activity.type === 'collapsed' || (o.body?.capacities?.moving ?? 1) < 0.35);
}

export function startCarry(world, c, call, { stale, logAction }) {
  const present = citizensIn(world.citizens, c.location, { exceptId: c.id });
  const target = present.find((o) => world.memory.labelsFor(c, [o]).has(call.arguments.person)) ?? world.citizens.get(call.arguments.person);
  if (!target || !carriable(world, c, target)) return stale(world, c, call, 'You cannot carry that person.');
  if (world.objects.handsOf(c.id) < 2 || world.objects.slotsUsed(c.id) > 0) return stale(world, c, call, 'You need both hands free to carry someone.');
  logAction(world, c, call, { targetId: target.id });
  if (target.activity.type === 'collapsed' || target.activity.type === 'sleeping') {
    beginCarry(world, c, target);
    return { ok: true };
  }
  // an awake patient has to agree
  pendingFor(target, world.now).push({ from: c.id, kind: 'carry', token: `${world.now}:${c.id}:carry`, until: world.now + T(world).consent.windowMinutes });
  world.perceive([target.id], { kind: 'action', text: `${ref(c)} offers to carry you. You can accept it or refuse.`, importance: 7, sourceId: c.id, roomId: c.location, data: { interrupt: true } });
  world.setActivity(c, { type: 'waiting', until: world.now + T(world).consent.windowMinutes, detail: { reason: `waiting for ${target.name} to accept being carried`, minutes: 5 } });
  return { ok: true };
}

function beginCarry(world, c, p) {
  c.carryingPerson = p.id;
  p.carriedBy = c.id;
  world.perceive(citizensIn(world.citizens, c.location, { exceptId: c.id }).map((o) => o.id), (o) => ({
    kind: 'action', text: `${ref(c)} lifts ${o.id === p.id ? 'you' : ref(p)} up and carries ${o.id === p.id ? 'you' : pronouns(p).obj}.`, importance: 5, sourceId: c.id, roomId: c.location,
  }));
  world.logEvent('carry', { actorId: c.id, location: c.location, targetId: p.id, action: 'pick_up' });
  world.setActivity(c, { type: 'idle' });
}

export function putDownPerson(world, c, call, { stale, logAction }) {
  const p = world.citizens.get(c.carryingPerson);
  if (!p) return stale(world, c, call, 'You are not carrying anyone.');
  logAction(world, c, call, { targetId: p.id });
  dropCarried(world, c, 'put_down');
  return { ok: true };
}

/** End a carry (put down, the carrier fell asleep, collapsed or died). */
export function dropCarried(world, c, reason = 'dropped') {
  const p = c.carryingPerson ? world.citizens.get(c.carryingPerson) : null;
  if (!p) { c.carryingPerson = null; return; }
  c.carryingPerson = null;
  p.carriedBy = null;
  if (!p.location && c.location) p.location = c.location;
  const gently = reason === 'put_down';
  world.perceive(citizensIn(world.citizens, c.location ?? p.location, { exceptId: c.id }).map((o) => o.id), (o) => ({
    kind: 'action', text: `${ref(c)} ${gently ? 'lays' : 'lets'} ${o.id === p.id ? 'you' : ref(p)} ${gently ? 'down gently' : 'fall to the ground'}.`, importance: gently ? 3 : 5, sourceId: c.id, roomId: c.location ?? p.location,
  }));
  world.logEvent('carry', { actorId: c.id, location: c.location, targetId: p.id, action: reason });
}

/** The carried person goes with the carrier at each leg of a walk. */
export function carryAlong(world, c, toId) {
  const p = c.carryingPerson ? world.citizens.get(c.carryingPerson) : null;
  if (!p) return;
  p.location = null;
  p.carriedBy = c.id;
  p.carryDest = toId;
}

export function carryArrive(world, c) {
  const p = c.carryingPerson ? world.citizens.get(c.carryingPerson) : null;
  if (!p) return;
  p.location = c.location;
  p.carryDest = null;
  world.saveCitizen(p);
}

// ---------- washing ----------
export function washClothes(world, c, call, { stale, logAction }) {
  if (!hasWater(world, c)) return stale(world, c, call, 'There is no water here to wash in.');
  const dirty = wornGarments(world, c.id).filter((g) => g.data?.bloodied);
  if (!dirty.length) return stale(world, c, call, 'Your clothes are not stained.');
  logAction(world, c, call);
  for (const g of dirty) setBloodied(world, g, false);
  world.setActivity(c, { type: 'doing', until: world.now + 8, detail: { description: 'washing the blood out of their clothes', minutes: 8 } });
  return { ok: true };
}

export const WASH_OFFERED = (world, c) => hasWater(world, c) && wornGarments(world, c.id).some((g) => g.data?.bloodied);
