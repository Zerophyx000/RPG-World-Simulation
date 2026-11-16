// Step 7B: state-driven accidents and exposure. Risk = base x carelessness x practice x room factor, scaled by
// ACCIDENT_RATE. A practiced, calm, rested person essentially never has an accident; the same person exhausted and
// furious can. Practice is provisional (persona.practiced) until the RPG step has real skills: practiceFactor() is the
// one function to replace. Every accident goes through the damage API (which also wears the covering garment).
import { illnessFactor as starvationIllness } from './starvation.js'; // step 11.5
import { config } from '../config.js';
import { ref } from '../memory/index.js';
import { pronouns } from '../world/citizens.js';
import { citizensIn } from '../world/rooms.js';
import { clamp } from './content.js';
import { garmentsCovering } from './garments.js';

const A = (world) => world.body.content.accidents;
const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const between = (rng, [a, b]) => a + rng() * (b - a);

/** How much more careless their state makes them (1 = calm and rested). */
export function carelessness(world, c) {
  const K = A(world).carelessness;
  let f = 1;
  const idx = world.needs.levelIndex('fatigue', c.needs);
  const name = world.needs.levelName('fatigue', idx);
  if (K.fatigue[name]) f *= K.fatigue[name];
  const strong = (c.emotions ?? []).some((e) => K.emotion.types.includes(e.type) && e.intensity >= K.emotion.min);
  if (strong) f *= K.emotion.factor;
  if ((c.body?.pain ?? 0) >= K.pain.min) f *= K.pain.factor;
  const st = c.body?.status ?? [];
  if (st.includes('concussed') || st.includes('in shock')) f *= K.impaired;
  return Math.min(K.max, f);
}

/** Provisional until skills exist: a content flag per kind of danger. */
export function practiceFactor(world, c, kind) {
  const P = A(world).practice;
  return (c.persona?.practiced ?? []).includes(kind) ? P.practiced : P.unpracticed;
}

const text = (s, c, thing) => String(s).replace('{name}', ref(c)).replace('{poss}', pronouns(c).poss).replace('{thing}', thing ?? 'thing');

function announce(world, c, src, thing, result) {
  const msg = text(src.text, c, thing);
  world.perceive(citizensIn(world.citizens, c.location, { exceptId: c.id }).map((o) => o.id), { kind: 'action', text: msg, importance: 5, sourceId: c.id, roomId: c.location, data: { accident: true } });
  world.logEvent('accident', { actorId: c.id, location: c.location, source: src.id, thing: thing ?? null, conditions: (result?.conditions ?? []).map((x) => ({ id: x.id, type: x.type, part: x.partId })) });
}

/** After working at (or using) an object: a burn at a hot one, a cut from a tool. → the accident text or '' */
export function activityAccident(world, c, o, minutes) {
  const B = world.body;
  const rate = config.body.accidentRate;
  if (!c.alive || !o || rate <= 0 || minutes <= 0) return '';
  const cfg = A(world);
  const kinds = [];
  if (cfg.hotStates[o.typeId]?.includes(o.state)) kinds.push('hot');
  if (world.objects.type(o)?.tags?.some((t) => cfg.toolTags.includes(t))) kinds.push('tool');
  for (const kind of kinds) {
    const src = { ...cfg.sources[kind], id: kind };
    const hours = minutes / 60;
    const p = 1 - (1 - clamp(src.perHour * rate * carelessness(world, c) * practiceFactor(world, c, src.practice), 0, 0.95)) ** hours;
    if (B.rng() >= p) continue;
    const part = pick(B.rng, src.damage.parts);
    const thing = o.data?.short ?? world.objects.type(o)?.name;
    const res = B.damage(c.id, { damageType: src.damage.damageType, part, amount: between(B.rng, src.damage.amount), cause: kind === 'hot' ? `burned at the ${thing}` : `cut by the ${thing}` });
    announce(world, c, src, thing, res);
    return res.conditions.length ? ` ${text(src.text, c, thing)}` : '';
  }
  return '';
}

/** Moving: a fall in a dangerous place, a stumble when already limping or crawling. */
export function moveAccident(world, c, { crawl = false, toId = null } = {}) {
  const B = world.body;
  const rate = config.body.accidentRate;
  if (!c.alive || rate <= 0) return false;
  const cfg = A(world);
  const rolls = [];
  const danger = Number(world.rooms.get(toId)?.danger ?? 0);
  if (danger >= cfg.sources.fall.minDanger) rolls.push({ ...cfg.sources.fall, id: 'fall', p: cfg.sources.fall.perMove * (danger / cfg.sources.fall.dangerScale) });
  if (crawl || (c.body?.capacities?.moving ?? 1) < 0.8) rolls.push({ ...cfg.sources.stumble, id: 'stumble', p: cfg.sources.stumble.perMove });
  for (const src of rolls) {
    const p = clamp(src.p * rate * carelessness(world, c) * practiceFactor(world, c, src.practice), 0, 0.9);
    if (B.rng() >= p) continue;
    let r = B.rng();
    const out = src.outcomes.find((o) => (r -= o.p) <= 0) ?? src.outcomes.at(-1);
    const missing = B.missingParts(c);
    const parts = out.parts.filter((id) => !missing.has(id));
    const part = pick(B.rng, parts.length ? parts : out.parts);
    const cond = B.addCondition(c, { type: out.type, partId: part, severity: Math.round(between(B.rng, out.severity) * 10) / 10, cause: src.id === 'fall' ? 'a fall' : 'a stumble', sourceId: 'accident' });
    announce(world, c, src, null, { conditions: cond ? [cond] : [] });
    return true;
  }
  return false;
}

/** Cold and wet without shelter: a chill, which can turn into a fever. Called every ~10 game minutes. */
export function exposure(world, c, minutes) {
  const B = world.body;
  const room = world.rooms.get(c.location);
  const rate = config.body.illnessRate;
  if (!room || !(room.tags ?? []).includes('outdoor')) return;
  const bad = (room.effects ?? []).some((e) => /rain|downpour|soaked|snow|frost|storm|freezing|cold/i.test(`${e.text ?? ''}`));
  if (!bad) return;
  const X = A(world).sources.exposure;
  const torsoGarment = garmentsCovering(world, c.id, 'torso');
  const ragged = !torsoGarment.length || torsoGarment.every((g) => ['torn', 'rags'].includes(g.state));
  const exhausted = world.needs.levelIndex('fatigue', c.needs) >= world.needs.levelOf('fatigue', 'exhausted');
  const rough = c.activity.type === 'sleeping' && c.activity.detail?.quality === 'rough';
  const per = X.perHour * rate * starvationIllness(world, c) * (exhausted ? X.exhaustedFactor : 1) * (ragged ? X.ragsFactor : 1) * (rough ? X.roughSleepFactor : 1);
  const p = 1 - (1 - clamp(per, 0, 0.95)) ** (minutes / 60);
  if (B.rng() >= p) return;
  const had = B.active(c.id).find((x) => x.type === 'chill');
  B.addCondition(c, { type: 'chill', severity: had ? Math.min(8, had.severity + 1) : 3, cause: 'being out in the cold and wet', sourceId: 'exposure' });
  const chill = B.active(c.id).find((x) => x.type === 'chill');
  if (chill && chill.severity >= 4 && B.rng() < X.feverChance * config.body.illnessRate) B.addCondition(c, { type: 'fever', severity: 3, cause: 'a chill that went to the chest' });
}
