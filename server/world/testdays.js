// Test days (step A8): director scripts in content/test-days/<name>.json that replay a day against
// the live world. Every action maps 1:1 onto a director operation and calls the SAME world method
// the matching route in server/http.js calls (never via HTTP).
//
// Script: { name, description, actions: [ ... ] }
//   at      game minutes after the run starts (number), or "HH:MM" = that time on the day the run
//           started (already past → the action is skipped and logged)
//   type    event | apply | whisper | memory | relationship | emotion | mood | needs |
//           objects-create | objects-patch | objects-reset | activate
//   chance  0..1 — the action only fires when the seeded roll is below it
//   pick    [alternatives] — the seeded roll fires exactly one alternative (own type + fields)
//   The action body is otherwise exactly the body the director route would take.
//
// All rolls come from ONE mulberry32 stream seeded by the run's seed and are consumed in script
// order, so a given seed always resolves the same script the same way.
//
// Scheduling is on GAME time through a clock tick handler. The clock's horizon hook
// (clock.horizonFn, normally quiet.nextEventAt) is wrapped for the duration of the run so the
// quiet-time fast-forward cannot jump far past the next scheduled action; it is restored on stop.
import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_DIR, loadDirectorPresets } from './scenarios.js';

const DIR = path.join(CONTENT_DIR, 'test-days');
const DAY = 1440;
const MAX_32 = 0x100000000;
const CLOCK_RE = /^(\d{1,2}):(\d{2})$/;
const RUNS = new WeakMap(); // world -> run state; in memory only (a restart simply drops the run)

// The operation types, and the world method each one calls (the same one the director route in
// server/http.js calls — see the matching POST/PATCH route there).
const TYPES = {
  'event': 'directorEvent',
  'apply': 'directorEvent',
  'whisper': 'whisper',
  'memory': 'directorMemory',
  'relationship': 'setRelationship',
  'emotion': 'emotions.directorEmotion',
  'mood': 'emotions.directorMood',
  'needs': 'setNeeds',
  'objects-create': 'createObject',
  'objects-patch': 'patchObject',
  'objects-reset': 'resetObject',
  'activate': 'activateCitizen',
};

// ---------- scripts on disk ----------
function scriptFiles() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
}

function readScript(name) {
  const files = scriptFiles();
  const file = files.find((f) => f.slice(0, -5) === name)
    ?? files.find((f) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))?.name === name; } catch { return false; } });
  if (!file) return null;
  return { base: file.slice(0, -5), script: JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')) };
}

/** Available scripts for the director UI: [{ name, description, actions }] (unreadable ones are skipped). */
export function listTestDays() {
  const out = [];
  for (const f of scriptFiles()) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      out.push({ name: s?.name ?? f.slice(0, -5), description: s?.description ?? '', actions: Array.isArray(s?.actions) ? s.actions.length : 0 });
    } catch (err) {
      console.warn(`[test-days] ${f} unreadable: ${err.message}`);
    }
  }
  return out;
}

// ---------- validation ----------
function missing(a, ...keys) {
  return keys.filter((k) => a[k] == null || a[k] === '').map((k) => `needs "${k}"`);
}

// Field checks for one operation (no `at`, no chance/pick): returns bare problem strings.
function typeProblems(a) {
  switch (a.type) {
    case 'event': {
      const out = [];
      const hasBody = a.preset || a.texts?.here || a.text || (Array.isArray(a.effects) && a.effects.length)
        || a.roomEffect?.text || (Array.isArray(a.objectChanges) && a.objectChanges.length);
      if (!hasBody) out.push('needs a preset, texts.here, effects, roomEffect or objectChanges');
      if (a.preset && !loadDirectorPresets().some((p) => p.id === a.preset)) out.push(`unknown preset "${a.preset}"`);
      return out;
    }
    case 'apply': return Array.isArray(a.effects) && a.effects.length ? [] : ['needs a non-empty "effects" array'];
    case 'whisper': return missing(a, 'citizenId', 'text');
    case 'memory': {
      const out = missing(a, 'citizenId', 'action');
      if (a.action === 'add' && !String(a.text ?? '').trim()) out.push('action "add" needs "text"');
      if (a.action === 'forget' && a.memoryId == null) out.push('action "forget" needs "memoryId"');
      else if (a.action != null && !['add', 'forget'].includes(a.action)) out.push('action must be "add" or "forget"');
      return out;
    }
    case 'relationship': return missing(a, 'citizenId', 'otherId');
    case 'emotion': return [...missing(a, 'citizenId', 'type'), ...(a.delta == null ? ['needs "delta"'] : [])];
    case 'mood': return missing(a, 'citizenId');
    case 'needs': return [...missing(a, 'citizenId'), ...(['hunger', 'fatigue', 'hp'].every((k) => a[k] == null || a[k] === '') ? ['needs hunger, fatigue or hp'] : [])];
    case 'objects-create': return [...missing(a, 'id', 'type'), ...(!a.room && !a.holder ? ['needs "room" or "holder"'] : [])];
    case 'objects-patch': return [...missing(a, 'id'), ...(!a.patch || typeof a.patch !== 'object' || !Object.keys(a.patch).length ? ['needs a non-empty "patch" object'] : [])];
    case 'objects-reset': return missing(a, 'objectId');
    case 'activate': return missing(a, 'id');
    default: return [];
  }
}

// An action body: chance, pick (recursively — alternatives carry their own type but no `at`), then the type.
function checkBody(a, label) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return [`${label}: must be an object`];
  const problems = [];
  if (a.chance != null && !(typeof a.chance === 'number' && a.chance >= 0 && a.chance <= 1)) problems.push(`${label}: chance must be 0..1`);
  if (a.pick != null) {
    if (!Array.isArray(a.pick) || !a.pick.length) problems.push(`${label}: pick must be a non-empty array`);
    else a.pick.forEach((alt, i) => problems.push(...checkBody(alt, `${label}.pick[${i + 1}]`)));
    return problems; // a pick has no operation of its own
  }
  if (typeof a.type !== 'string' || !TYPES.has(a.type)) {
    return [`${label}: unknown type "${a.type}" (have: ${TYPES.join(', ')})`];
  }
  return typeProblems(a).map((p) => `${label}: ${p}`);
}

function checkAction(a, label) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return [`${label}: must be an object`];
  const problems = [];
  if (typeof a.at === 'number') { if (!(a.at >= 0)) problems.push(`${label}: at must be >= 0`); }
  else if (typeof a.at === 'string') { if (!CLOCK_RE.test(a.at.trim())) problems.push(`${label}: at must be game minutes (number) or "HH:MM"`); }
  else problems.push(`${label}: at must be game minutes (number) or "HH:MM"`);
  problems.push(...checkBody(a, label));
  return problems;
}

// ---------- running ----------
// Resolve one script action into a scheduled entry: absolute game time, chance roll, picked alternative.
function resolveAction(raw, index, startedAt, dayStart, rand) {
  const at = typeof raw.at === 'string' ? dayStart + clockMinutes(raw.at) : startedAt + raw.at;
  const a = { index, at, scheduled: raw.at, type: raw.type, action: raw, skipped: null, done: false };
  if (at < startedAt) a.skipped = 'past'; // "HH:MM" earlier on the start day
  if (!a.skipped && raw.chance != null && rand() >= raw.chance) a.skipped = 'chance';
  if (!a.skipped && Array.isArray(raw.pick) && raw.pick.length) {
    const alt = raw.pick[Math.min(raw.pick.length - 1, Math.floor(rand() * raw.pick.length))];
    a.type = alt.type;
    a.action = alt;
  }
  return [a];
}

// The event body: the preset (content/director-presets.json) supplies defaults, the action's own fields win.
function eventBody(a) {
  const { at: _at, chance: _chance, pick: _pick, preset, ...body } = a;
  if (!preset) return body;
  const p = loadDirectorPresets().find((x) => x.id === preset);
  if (!p) throw new Error(`unknown preset "${preset}"`);
  return { ...p, ...body };
}

function runAction(world, a) {
  switch (a.type) {
    case 'event': return world.directorEvent(eventBody(a));
    case 'apply': return world.directorEvent({ roomId: a.roomId ?? null, radius: a.radius, effects: a.effects });
    case 'whisper': return world.whisper({ citizenId: a.citizenId, text: a.text, importance: a.importance });
    case 'memory': return world.directorMemory(a);
    case 'relationship': return world.setRelationship(a);
    case 'emotion': return world.emotions.directorEmotion(a);
    case 'mood': return world.emotions.directorMood(a);
    case 'needs': return world.setNeeds({ citizenId: a.citizenId, hunger: a.hunger, fatigue: a.fatigue, hp: a.hp });
    case 'objects-create': return world.createObject(a);
    case 'objects-patch': return world.patchObject(a.id, a.patch ?? {});
    case 'objects-reset': return world.resetObject(a.objectId);
    case 'activate': return world.activateCitizen({ id: a.id, location: a.location });
    default: throw new Error(`unknown type "${a.type}"`); // filtered out at load
  }
}


function fire(world, run, a) {
  world.logEvent('test_day', {
    name: run.name, seed: run.seed, index: a.index, type: a.type, at: a.at, scheduled: a.scheduled,
    ...(a.skipped ? { skipped: a.skipped } : {}),
  });
  if (a.skipped) return;
  try {
    runAction(world, a.action);
  } catch (err) {
    world.logEvent('error', { message: `test day "${run.name}" action ${a.index + 1} (${a.type}) failed: ${err.message}` });
  }
}

function fireDue(world, run, now) {
  for (const a of run.actions) {
    if (a.done) continue;
    if (a.at > now) break; // sorted by time: everything after this is still in the future
    a.done = true;
    run.done++;
    fire(world, run, a);
  }
  if (run.done >= run.total) teardown(world, run, 'finished');
}

function teardown(world, run, why) {
  const i = world.clock.handlers.indexOf(run.tick);
  if (i >= 0) world.clock.handlers.splice(i, 1);
  if (world.clock.horizonFn === run.horizon) world.clock.horizonFn = run.prevHorizon;
  run.running = false;
  world.logEvent('test_day', { name: run.name, seed: run.seed, action: why === 'finished' ? 'end' : 'stop', why, done: run.done, total: run.total });
}

/** Start a script: { ok, name, seed, startedAt, actions } or { ok: false, error }. One run at a time. */
export function startTestDay(world, { name, seed } = {}) {
  name = String(name ?? '').trim();
  if (!name) return { ok: false, error: 'name is required' };
  const n = seed == null || seed === '' ? null : Number(seed);
  if (n != null && (!Number.isInteger(n) || n < 0 || n >= MAX_32)) return { ok: false, error: 'seed must be an integer from 0 to 4294967295' };
  const used = n == null ? (Math.random() * MAX_32) >>> 0 : n >>> 0;

  let loaded;
  try {
    loaded = readScript(name);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!loaded) return { ok: false, error: `unknown test day "${name}" (have: ${listTestDays().map((d) => d.name).join(', ') || 'none'})` };
  if (!Array.isArray(loaded.script.actions)) return { ok: false, error: `${loaded.base}: actions must be an array` };

  const startedAt = world.now;
  const dayStart = Math.floor(startedAt / DAY) * DAY;
  const rand = mulberry32(used);
  const problems = [];
  let actions = [];
  for (const [i, raw] of loaded.script.actions.entries()) {
    const ps = checkAction(raw, `action ${i + 1}`);
    problems.push(...ps);
    if (!ps.length) actions.push(...resolveAction(raw, i, startedAt, dayStart, rand));
  }
  if (problems.length) return { ok: false, error: `${loaded.base}: ${problems.join('; ')}` };
  actions.sort((a, b) => (a.at - b.at) || (a.index - b.index)); // a coarse tick fires several at once, in order

  const prior = RUNS.get(world);
  if (prior?.running) teardown(world, prior, 'replaced'); // only one run at a time

  const run = { name: loaded.script.name ?? loaded.base, seed: used, startedAt, actions, total: actions.length, done: 0, running: true, tick: null, horizon: null, prevHorizon: null };
  run.tick = (_elapsed, now) => fireDue(world, run, now);
  run.prevHorizon = world.clock.horizonFn ?? null;
  // step A8: while a test day runs, the next scheduled action is also a clock horizon, so the
  // quiet-time fast-forward lands just after it instead of jumping far past it.
  run.horizon = () => {
    const next = run.actions.find((x) => !x.done && x.at > world.now + 1e-6);
    if (!next) return run.prevHorizon ? run.prevHorizon() : null;
    const q = run.prevHorizon ? run.prevHorizon() : null;
    return q == null ? next.at : Math.min(q, next.at);
  };
  world.clock.onTick(run.tick);
  world.clock.horizonFn = run.horizon;
  RUNS.set(world, run);
  world.logEvent('test_day', { name: run.name, seed: run.seed, action: 'start', total: run.total });
  return { ok: true, name: run.name, seed: run.seed, startedAt, actions: run.total };
}

export function stopTestDay(world) {
  const run = RUNS.get(world);
  if (!run?.running) return { ok: false, error: 'no test day running' };
  teardown(world, run, 'director');
  return { ok: true, name: run.name, seed: run.seed, done: run.done, total: run.total };
}

export function testDayStatus(world) {
  const run = RUNS.get(world);
  if (!run) return { running: false, name: null, seed: null, startedAt: null, done: 0, total: 0, next: null };
  const next = run.running ? run.actions.find((a) => !a.done) ?? null : null;
  return { running: Boolean(run.running), name: run.name, seed: run.seed, startedAt: run.startedAt, done: run.done, total: run.total, next: next?.at ?? null };
}

/** Routes in exactly http.js's format; the orchestrator spreads them into its route table. */
export function testDayRoutes(world) {
  return [
    ['GET', /^\/api\/director\/test-days$/, () => listTestDays()],
    ['POST', /^\/api\/director\/test-days\/run$/, (_req, body) => startTestDay(world, body ?? {})],
    ['POST', /^\/api\/director\/test-days\/stop$/, () => stopTestDay(world)],
    ['GET', /^\/api\/director\/test-days\/status$/, () => testDayStatus(world)],
  ];
}

// ---------- helpers ----------
function clockMinutes(s) {
  const m = CLOCK_RE.exec(String(s).trim());
  return Number(m[1]) * 60 + Number(m[2]);
}

// Deterministic 32-bit PRNG: same seed → same chance rolls and picks.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
