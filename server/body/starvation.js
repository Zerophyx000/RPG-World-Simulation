// Step 11.5 (B1/B2/B4): days without food. The hunger meter (c.needs.hunger, 0–100) is the URGE — hungry within a day,
// as before. Step 7B hung death on that meter (vitality drained once it reached the top level), so a citizen went from
// a meal to starvation in under two game days. This is the BODY's clock instead, from the last meal (c.needs.fedAt):
//
//   < 1 day     hungry, irritable (the urge's reminders, unchanged)
//   3 days      weak: force and speed down (combatProfile), fatigue builds faster
//   7 days      faint spells (a short blackout when exerting), slower healing
//   14 days     bedridden-level weakness, illness easier; vitality starts to fail
//   STARVATION_DEATH_DAYS (30)   death
//
// Any meal resets the clock (fedAt = now) and the effects lift over the following day (c.needs.starveRecover). Others see
// it from "weak" on (cuesFor / the cue when someone reaches a stage), and a host with a starving person under their roof
// is told where food is (hostLines). Reads and writes only c.needs / c.body fields; collapse and revive go through
// world/actions.js like any other blackout.
import { citizensIn } from '../world/rooms.js';
import { pronouns } from '../world/citizens.js';
import { ref } from '../memory/index.js';
import { collapse, revive } from '../world/actions.js';

export const STAGES = ['fed', 'weak', 'faint', 'bedridden'];
const AT = [0, 3, 7, 14]; // days without food
export const deathDays = () => Math.max(15, Number(process.env.STARVATION_DEATH_DAYS ?? 30) || 30);
const FORCE = [1, 0.75, 0.55, 0.35];
const FATIGUE = [1, 1.3, 1.6, 2.0];
const HEAL = [1, 0.85, 0.6, 0.4];
const ILLNESS = [1, 1, 1.5, 2.5];
const FAINT = [0, 0, 0.06, 0.15]; // per exertion (a walk, a rough act, hard work)
const FAINT_MINUTES = [5, 15];
const FEEL = [
  null,
  "You haven't eaten properly in days. Your legs are weak and your hands shake.",
  "You haven't eaten in a week. The world tilts when you stand; you could black out if you push yourself.",
  "You haven't eaten in two weeks. You can barely lift your head; your body is failing.",
];

/** Days since the last meal (old rows: estimated from the urge meter once, then kept). */
export function daysWithout(world, c) {
  const n = c.needs;
  if (!n) return 0;
  if (n.fedAt == null) n.fedAt = world.now - ((n.hunger ?? 0) / 4) * 60;
  return Math.max(0, (world.now - n.fedAt) / 1440);
}

/** The stage now (0 fed … 3 bedridden), as a float while a meal's relief is still lifting the last one. */
export function stageOf(world, c) {
  const d = daysWithout(world, c);
  let s = 0;
  for (let i = AT.length - 1; i > 0; i--) if (d >= AT[i]) { s = i; break; }
  const r = c.needs?.starveRecover;
  if (r && world.now - r.from < 1440) s = Math.max(s, r.stage * (1 - (world.now - r.from) / 1440));
  return s;
}
const lerp = (arr, s) => { const i = Math.floor(s); const f = s - i; return i >= arr.length - 1 ? arr.at(-1) : arr[i] + (arr[i + 1] - arr[i]) * f; };
export const forceFactor = (world, c) => lerp(FORCE, stageOf(world, c));
export const fatigueFactor = (world, c) => lerp(FATIGUE, stageOf(world, c));
export const healFactor = (world, c) => lerp(HEAL, stageOf(world, c));
export const illnessFactor = (world, c) => lerp(ILLNESS, stageOf(world, c));
export const stageName = (world, c) => STAGES[Math.floor(stageOf(world, c))];

/** A meal (any meal): the clock resets; the effects lift over the next day. */
export function onMeal(world, c) {
  if (!c.needs) return;
  const s = Math.floor(stageOf(world, c));
  c.needs.fedAt = world.now;
  c.needs.starveSeen = 0;
  c.needs.starveRecover = s > 0 ? { stage: s, from: world.now } : null;
}

/** Vitality drain per game hour from starvation: none before 14 days, then enough to end at STARVATION_DEATH_DAYS. */
export function vitalityDrain(world, c) {
  const d = daysWithout(world, c);
  return d < AT[3] ? 0 : 100 / ((deathDays() - AT[3]) * 24);
}

/** What they feel (HOW YOU FEEL), or null. */
export function feelLine(world, c) { return FEEL[Math.floor(stageOf(world, c))] ?? null; }

/** What others see, or ''. */
export function cueFor(world, o) {
  const s = Math.floor(stageOf(world, o));
  if (!s || !o.alive) return '';
  const p = pronouns(o);
  const has = p.subj === 'they' ? "haven't" : "hasn't";
  return s >= 3 ? `${p.subj === 'they' ? 'They are' : `${p.subj[0].toUpperCase()}${p.subj.slice(1)} is`} skin and bone and can barely lift ${p.poss} head; ${p.subj} ${has} eaten in a very long time.`
    : s >= 2 ? `${p.subj === 'they' ? 'They are' : `${p.subj[0].toUpperCase()}${p.subj.slice(1)} is`} grey and hollow-cheeked and sways on ${p.poss} feet; ${p.subj} ${has} eaten in a week or more.`
      : `${p.subj === 'they' ? 'They are' : `${p.subj[0].toUpperCase()}${p.subj.slice(1)} is`} pale and shaking; ${p.subj} looks as if ${p.subj} ${has} eaten in days.`;
}

/** A blackout when exerting (faint spells, from 7 days). Call on a walk, a rough act, hard work. */
export function maybeFaint(world, c, { rng = Math.random } = {}) {
  if (!c.alive || c.activity?.type === 'collapsed') return false;
  const p = lerp(FAINT, stageOf(world, c));
  if (!p || rng() >= p) return false;
  const minutes = FAINT_MINUTES[0] + Math.round(rng() * (FAINT_MINUTES[1] - FAINT_MINUTES[0]));
  c.body.faintUntil = world.now + minutes;
  collapse(world, c, { reason: 'fainted' });
  world.logEvent('faint', { actorId: c.id, location: c.location, days: Math.round(daysWithout(world, c) * 10) / 10, minutes });
  return true;
}

/** The host's line: someone weak with hunger under their roof, and the food places they know. */
export function hostLines(world, c) {
  if (!c.home || c.location !== c.home) return [];
  const out = [];
  const food = Object.keys(c.knownPlaces ?? {}).filter((id) => world.rooms.get(id)?.services?.food).map((id) => world.rooms.get(id));
  for (const o of citizensIn(world.citizens, c.home, { exceptId: c.id })) {
    if (Math.floor(stageOf(world, o)) < 1) continue;
    out.push(`${ref(o)} needs food.${food.length ? ` ${food.slice(0, 2).map((r) => `${r.name[0].toUpperCase()}${r.name.slice(1)} has ${r.services.food.description ?? 'food'}`).join('; ')}.` : ''}`);
  }
  return out;
}

/** Every body tick: the faint wears off, a new stage is felt and seen, and the end comes at STARVATION_DEATH_DAYS. */
export function tick(world, c) {
  const n = c.needs;
  if (!n || !c.alive) return;
  if (c.activity?.type === 'collapsed' && c.activity.detail?.reason === 'fainted' && world.now >= (c.body.faintUntil ?? 0)) {
    c.body.faintUntil = null;
    revive(world, c, { text: 'You come to on the ground. You must have fainted; your head swims.', body: true });
  }
  const s = Math.floor(stageOf(world, c));
  if (s > (n.starveSeen ?? 0) && !n.starveRecover) {
    n.starveSeen = s;
    world.perceive([c.id], { kind: 'body', text: FEEL[s], importance: 5 + s, roomId: c.location });
    const others = citizensIn(world.citizens, c.location ?? '', { exceptId: c.id });
    if (others.length) world.perceive(others.map((o) => o.id), (o) => ({ kind: 'action', text: `${ref(c)}: ${cueFor(world, c)}`, importance: Math.min(9, (s >= 2 ? 7 : 5) + ((world.memory.rel(o.id, c.id)?.affinity ?? 0) >= 2 ? 1 : 0)), sourceId: c.id, roomId: c.location }));
    world.logEvent('hunger_stage', { actorId: c.id, location: c.location, stage: STAGES[s], days: Math.round(daysWithout(world, c) * 10) / 10 });
  }
  if (daysWithout(world, c) >= deathDays()) world.body.die(c, { cause: 'starvation', reason: 'starvation' });
}
