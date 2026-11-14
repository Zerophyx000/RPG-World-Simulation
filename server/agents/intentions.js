// Step 9.5 (A1): intentions instead of day plans. A short, unordered list of things a citizen means to do, edited by the
// citizen inside their ordinary decisions (no extra calls) and by reflections (promises), and NEVER carried out by code:
// an intention only happens when the citizen decides to do it.
//
//   c.intentions = [{ id, text, about: [citizenIds], place, source, createdAt, touchedAt, weight }]
//   source: self (a decision) · promise (said they would, from reflection) · need · habit_break · carried (from a plan)
//
// At most 8 (the lowest weight drops). Weight fades 0.25 per untouched game day (promises half as fast, unless the person
// is dead or gone); below 0.15 an intention is gone. Doing something related touches it (fade resets).
import { ref } from '../memory/index.js';
import { repairJson } from '../emotions/report.js';

export const MAX_INTENTIONS = 8;
export const MAX_ADDS = 2;
export const TEXT_MAX = 100;
const FADE_PER_DAY = 0.25;
const GONE_BELOW = 0.15;
const START_WEIGHT = { self: 0.8, promise: 0.75, need: 0.7, habit_break: 0.5, carried: 0.6 };

const day = (t) => Math.floor(t / 1440);

/** People a citizen can name in an intention: the living they know, and the dead they know are dead. */
function peopleLabels(world, c) {
  return world.memory.labelsFor(c, world.memory.knownPeople(c, { dead: true }));
}

/** The optional `intentions` field on every decision tool. */
export function intentionsParam(world, c) {
  const people = [...peopleLabels(world, c).keys()];
  const places = Object.keys(c.knownPlaces ?? {}).filter((id) => world.rooms.has(id));
  const ids = (c.intentions ?? []).map((i) => i.id);
  const item = {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'What you mean to do, in a few words.' },
      ...(people.length ? { about: { type: 'array', items: { type: 'string', enum: people }, description: 'Who it concerns.' } } : {}),
      ...(places.length ? { place: { type: 'string', enum: places, description: 'Where, if it matters.' } } : {}),
    },
    required: ['text'],
  };
  return {
    type: 'object',
    description: "Optional. Add, finish or drop things you mean to do. Drop anything that no longer matters.",
    properties: {
      add: { type: 'array', maxItems: MAX_ADDS, items: item },
      ...(ids.length ? { done: { type: 'array', items: { type: 'string', enum: ids } }, drop: { type: 'array', items: { type: 'string', enum: ids } } } : {}),
    },
  };
}

function nextId(c) {
  const n = Math.max(0, ...(c.intentions ?? []).map((i) => Number(String(i.id).slice(1)) || 0), c.intentionSeq ?? 0) + 1;
  c.intentionSeq = n;
  return `i${n}`;
}

/** Add one intention (code paths: reflections, needs, a migration). Returns it, or null if invalid / a duplicate. */
export function addIntention(world, c, { text, about = [], place = null, source = 'self', weight = null }) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, TEXT_MAX);
  if (t.length < 3) return null;
  c.intentions ??= [];
  const norm = t.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  const dup = c.intentions.find((i) => i.text.toLowerCase().replace(/[^a-z0-9 ]/g, '') === norm);
  if (dup) { dup.touchedAt = world.now; dup.weight = Math.max(dup.weight, START_WEIGHT[source] ?? 0.7); return null; }
  const it = {
    id: nextId(c), text: t, about: [...new Set(about)].filter((id) => world.citizens.has(id) && id !== c.id),
    place: place && world.rooms.has(place) ? place : null, source, createdAt: world.now, touchedAt: world.now,
    weight: weight ?? START_WEIGHT[source] ?? 0.7,
  };
  c.intentions.push(it);
  if (c.intentions.length > MAX_INTENTIONS) {
    c.intentions.sort((a, b) => b.weight - a.weight);
    const gone = c.intentions.splice(MAX_INTENTIONS);
    for (const g of gone) world.logEvent('intention', { actorId: c.id, op: 'pushed_out', id: g.id, text: g.text });
  }
  world.logEvent('intention', { actorId: c.id, location: c.location, op: 'add', id: it.id, text: it.text, source, about: it.about, place: it.place });
  return it;
}

/**
 * Apply the `intentions` field of a decision: at most 2 adds, ids must exist. `raw` may be an object or (broken) JSON.
 * Returns { added, done, dropped }.
 */
export function applyEdits(world, c, raw) {
  const out = { added: [], done: [], dropped: [] };
  let v = raw;
  if (typeof v === 'string') v = repairJson(v);
  if (!v || typeof v !== 'object') return out;
  const people = peopleLabels(world, c);
  const byLabel = (l) => people.get(l)?.id ?? [...people.values()].find((o) => o.name.toLowerCase() === String(l).toLowerCase())?.id ?? null;
  for (const a of (Array.isArray(v.add) ? v.add : []).slice(0, MAX_ADDS)) {
    if (!a || typeof a !== 'object' && typeof a !== 'string') continue;
    const spec = typeof a === 'string' ? { text: a } : a;
    const about = (Array.isArray(spec.about) ? spec.about : spec.about ? [spec.about] : []).map(byLabel).filter(Boolean);
    const place = spec.place && c.knownPlaces?.[spec.place] ? spec.place : null;
    const it = addIntention(world, c, { text: spec.text, about, place, source: 'self' });
    if (it) out.added.push(it.id);
  }
  const ids = new Set((c.intentions ?? []).map((i) => i.id));
  for (const [key, op] of [['done', 'done'], ['drop', 'drop']]) {
    for (const id of Array.isArray(v[key]) ? v[key] : []) {
      if (!ids.has(id)) continue;
      const it = c.intentions.find((i) => i.id === id);
      c.intentions = c.intentions.filter((i) => i.id !== id);
      ids.delete(id);
      (op === 'done' ? out.done : out.dropped).push(id);
      world.logEvent('intention', { actorId: c.id, location: c.location, op, id, text: it?.text });
    }
  }
  if (out.added.length || out.done.length || out.dropped.length) world.saveCitizen(c);
  return out;
}

/** Doing something related (the person, the place, the words) resets an intention's fade. */
export function touch(world, c, call) {
  if (!(c.intentions ?? []).length || !call) return;
  const a = call.arguments ?? {};
  const people = peopleLabels(world, c);
  const ids = new Set([a.to, a.person, a.who, a.from].filter(Boolean).map((l) => people.get(l)?.id).filter(Boolean));
  const place = a.destination ?? a.place ?? null;
  const words = `${a.action ?? ''} ${a.text ?? ''} ${a.intent ?? ''}`.toLowerCase();
  let changed = false;
  for (const it of c.intentions) {
    const hit = it.about.some((id) => ids.has(id)) || (it.place && (it.place === place || (it.place === c.location && /do|use|take|tend|bury/.test(call.name))))
      || it.text.toLowerCase().split(/\W+/).filter((w) => w.length >= 5).some((w) => words.includes(w));
    if (hit) { it.touchedAt = world.now; it.weight = Math.min(1, it.weight + 0.1); changed = true; }
  }
  if (changed) world.saveCitizen(c);
}

/** Once per game day (or on a gap): untouched intentions fade; promises at half speed unless the person is dead or gone. */
export function fade(world, c) {
  const list = c.intentions ?? [];
  if (!list.length) return;
  const last = c.intentionsFadedAt ?? world.now;
  const days = (world.now - last) / 1440;
  if (c.intentionsFadedAt != null && days < 0.25) return;
  c.intentionsFadedAt = world.now;
  if (days <= 0) return world.saveCitizen(c);
  const keep = [];
  for (const it of list) {
    const idle = Math.max(0, Math.min(days, (world.now - it.touchedAt) / 1440));
    const gone = it.about.some((id) => { const o = world.citizens.get(id); return !o || (!o.alive && world.deaths?.knows(c, id)); });
    const rate = it.source === 'promise' && !gone ? FADE_PER_DAY / 2 : FADE_PER_DAY;
    it.weight -= rate * idle;
    if (it.weight < GONE_BELOW) world.logEvent('intention', { actorId: c.id, op: 'faded', id: it.id, text: it.text });
    else keep.push(it);
  }
  c.intentions = keep;
  world.saveCitizen(c);
}

/** How long ago, in the citizen's words. */
function since(world, t) {
  const d = day(world.now) - day(t);
  if (d <= 0) {
    const h = ((t % 1440) + 1440) % 1440 / 60;
    return h < 11 ? 'since this morning' : h < 17 ? 'since this afternoon' : 'since this evening';
  }
  if (d === 1) return 'from yesterday';
  return d === 2 ? 'two days ago' : `${d} days ago`;
}

/** THINGS YOU'D MEANT TO DO, worded softly (A1.4). */
export function promptBlock(world, c, { waking = false } = {}) {
  const list = [...(c.intentions ?? [])].sort((a, b) => b.weight - a.weight);
  if (!list.length) return null;
  const lines = list.map((it) => {
    const when = since(world, it.createdAt);
    const promise = it.source === 'promise' && !/promis/i.test(it.text) ? ', as you promised' : '';
    const yesterday = waking && day(it.createdAt) < day(world.now) ? ' — from yesterday' : '';
    return `- ${world.memory.resolveNames(c, it.text)}${promise} (${when}) [${it.id}]${yesterday}`;
  });
  return `THINGS YOU'D MEANT TO DO (only if they still matter to you):\n${lines.join('\n')}`;
}

/** The top one for the roster. */
export function topIntention(c) {
  return [...(c.intentions ?? [])].sort((a, b) => b.weight - a.weight)[0] ?? null;
}

/** The inspector view. */
export function intentionsView(world, c) {
  const name = (id) => world.citizens.get(id)?.name ?? id;
  return (c.intentions ?? []).map((i) => ({ ...i, aboutNames: i.about.map(name), placeName: world.rooms.get(i.place)?.name ?? null, weight: Math.round(i.weight * 100) / 100 }));
}

/** Director: replace the list (each entry validated). */
export function setIntentions(world, c, list) {
  c.intentions = [];
  for (const x of (Array.isArray(list) ? list : []).slice(0, MAX_INTENTIONS)) {
    addIntention(world, c, { text: x.text, about: x.about ?? [], place: x.place ?? null, source: x.source ?? 'self', weight: x.weight != null ? Number(x.weight) : null });
  }
  world.logEvent('director', { action: 'intentions', citizenId: c.id, n: c.intentions.length });
  world.saveCitizen(c);
  return intentionsView(world, c);
}

/** Words for a plan step (the migration and old plans use these). */
export function intentionFromStep(step) {
  return String(step?.note || step?.description || step?.kind || '').trim();
}

export { ref };
