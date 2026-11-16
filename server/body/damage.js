// Step 7B: the damage API. Accidents, director events and (later) weapons all end up in applyDamage():
//   world.body.damage(citizenId, { damageType, part, amount, spread?, cause, sourceId })
// damageType: cut | pierce | blunt | burn | crush | blast. part: a part id, "random" (weighted by hitWeight) or a
// region ("head", "left_arm"). Covering garments wear down first (armor reduction will hook in here in the RPG
// step), then the rest becomes conditions via content/damage.json, with wound geometry, a vessel roll and a
// severity derived from geometry plus part. Returns the created conditions.
import { clamp } from './content.js';
import { garmentsCovering, degradeGarment } from './garments.js';

export const DAMAGE_TYPES = ['cut', 'pierce', 'blunt', 'burn', 'crush', 'blast'];

const between = (rng, a, b) => a + rng() * (b - a);
const pickWeighted = (rng, items, w) => {
  const total = items.reduce((s, x) => s + w(x), 0);
  if (total <= 0) return items[Math.floor(rng() * items.length)] ?? null;
  let r = rng() * total;
  for (const x of items) {
    r -= w(x);
    if (r <= 0) return x;
  }
  return items.at(-1) ?? null;
};

export function resolvePart(body, c, part) {
  const { content } = body;
  const missing = body.missingParts(c);
  const surface = (id) => content.parts.get(id) && !content.parts.get(id).internal && !missing.has(id);
  if (part && part !== 'random' && content.parts.has(part)) return part;
  const pool = part && part !== 'random' ? content.resolveParts(part).filter(surface) : [...content.parts.keys()].filter(surface);
  const list = pool.length ? pool : [...content.parts.keys()].filter(surface);
  return pickWeighted(body.rng, list, (id) => content.parts.get(id).hitWeight)?.valueOf() ?? 'torso';
}

export function depthFor(D, amount, partId, content) {
  let depth = (D.depthByAmount.find(([max]) => amount <= max) ?? D.depthByAmount.at(-1))[1];
  const part = content.parts.get(partId);
  // a limb has no cavity: nothing "penetrates" into it
  if (depth === 'penetrating' && content.limbOf(partId)) depth = D.limbPenetrationDepth ?? 'deep';
  if (depth === 'penetrating' && !part?.under?.length && !['head', 'neck'].includes(partId)) depth = 'deep';
  return depth;
}

export function rollVessel(rng, content, partId, depth) {
  const map = content.parts.get(partId)?.vessels?.[depth] ?? {};
  let r = rng();
  for (const [vessel, p] of Object.entries(map)) {
    r -= p;
    if (r <= 0) return vessel;
  }
  return depth === 'superficial' || depth === 'moderate' ? 'capillary' : 'venous';
}

/** Wound geometry + severity from the damage type, amount and part (severity is derived, never set directly). */
export function makeWound(body, partId, { kind = 'cut', amount, depth, vessel, length, gape }) {
  const D = body.content.damage;
  const g = D.geometry[kind] ?? D.geometry.cut;
  const rng = body.rng;
  const d = depth ?? depthFor(D, amount, partId, body.content);
  const len = length ?? Math.max(0.5, Math.round(amount * g.lengthPerAmount * between(rng, 0.8, 1.2) * 10) / 10);
  const gp = gape ?? clamp(g.gape + between(rng, -g.gapeJitter, g.gapeJitter), 0.05, 1);
  const v = vessel ?? rollVessel(rng, body.content, partId, d);
  const S = D.severity;
  const severity = clamp(Math.round((S.depth[d] + Math.log2(Math.max(1, len / 2)) * S.lengthLog2 + (S.vessel[v] ?? 0)) * 10) / 10, 1, 10);
  return { geometry: { length_cm: len, depth: d, gape: Math.round(gp * 100) / 100, vessel: v, internal: false }, severity };
}

function wearGarments(body, c, partId, damageType, amount, cause) {
  const D = body.content.damage;
  const changed = [];
  const per = D.garmentLoss[damageType] ?? 1;
  for (const g of garmentsCovering(body.world, c.id, partId)) {
    // the outermost garment takes it first; a hit strong enough goes through to the next layer
    let steps = Math.floor((amount * per) / D.garmentStepAmount);
    if (body.rng() < ((amount * per) / D.garmentStepAmount) % 1) steps++;
    if (amount >= 3 && steps === 0 && body.rng() < 0.35) steps = 1;
    if (steps > 0) {
      const before = g.state;
      const after = degradeGarment(body.world, g, steps, { cause });
      if (after !== before) changed.push({ id: g.id, from: before, to: after });
    }
    break; // outermost layer only; no protection effect in this step
  }
  return changed;
}

/** The main entry. spec: { damageType, part, amount, cause, sourceId, count?, spreadOver? } → { conditions, garments, part } */
export function applyDamage(body, c, spec) {
  const { content } = body;
  const D = content.damage;
  const type = DAMAGE_TYPES.includes(spec.damageType) ? spec.damageType : 'blunt';
  const cause = spec.cause ?? `${type} damage`;
  const out = { conditions: [], garments: [], parts: [] };
  const add = (t, partId, severity, extra = {}) => {
    const cond = body.addCondition(c, { type: t, partId, severity, cause, sourceId: spec.sourceId ?? null, ...extra });
    if (cond) out.conditions.push(cond);
    return cond;
  };

  if (type === 'blast') return blast(body, c, spec, out, add, cause);

  const partId = resolvePart(body, c, spec.part);
  const part = content.parts.get(partId);
  const amount = Math.max(0.5, Number(spec.amount) || 5) * (part?.headMult ?? 1);
  out.parts.push(partId);
  out.garments.push(...wearGarments(body, c, partId, type, amount, cause));
  hit(body, c, { type, partId, amount, add, D });
  body.world.logEvent('injury', {
    actorId: c.id, location: c.location, damageType: type, part: partId, amount: Math.round(amount * 10) / 10, cause, sourceId: spec.sourceId ?? null,
    conditions: out.conditions.map((x) => ({ id: x.id, type: x.type, part: x.partId, severity: x.severity })), garments: out.garments,
  });
  body.afterChange(c);
  return out;
}

function hit(body, c, { type, partId, amount, add, D }) {
  const { content, rng } = body;
  const part = content.parts.get(partId);
  const torsoish = ['chest', 'abdomen', 'torso'].includes(partId);
  if (type === 'cut' || type === 'pierce') {
    const w = makeWound(body, partId, { kind: type, amount });
    const cond = add(type === 'cut' ? 'cut' : 'puncture', partId, w.severity, { geometry: w.geometry });
    organRoll(body, partId, w.geometry.depth, amount, add, D);
    if (torsoish && (w.geometry.depth === 'penetrating' || (w.geometry.depth === 'deep' && rng() < 0.4))) internalBleed(body, partId, amount, add);
    return cond;
  }
  if (type === 'burn') {
    const sev = clamp(Math.round(amount * D.burn.severityPerAmount * 10) / 10, 1, 10);
    return add('burn', partId, sev, { geometry: { area_cm2: Math.round(amount * D.burn.areaPerAmount), depth: sev >= 7 ? 'deep' : 'moderate', ...(sev >= 8 ? { vessel: 'capillary', gape: 0.3 } : {}) } });
  }
  if (type === 'crush') {
    const sev = clamp(Math.round(amount * D.crush.severityPerAmount * 10) / 10, 1, 10);
    add('crush', partId, sev);
    if (part?.bone && rng() < D.crush.fractureChance * (amount / 20)) add('fracture', partId, clamp(sev - 1, 2, 9));
    if (torsoish && amount >= D.blunt.internalAt) internalBleed(body, partId, amount, add);
    return;
  }
  // blunt
  const B = D.blunt;
  const sev = clamp(Math.round(amount * B.bruisePerAmount * 10) / 10, 1, 10);
  add('bruise', partId, sev);
  if (part?.bone && amount >= B.fractureAt && rng() < Math.min(0.9, amount * B.fractureChancePerAmount)) {
    const open = amount >= 26 && rng() < 0.4;
    add('fracture', partId, clamp(Math.round((amount / 4) * 10) / 10, 2, 10), open ? { geometry: { length_cm: D.geometry.compound.length, depth: 'deep', gape: D.geometry.compound.gape, vessel: rollVessel(rng, content, partId, 'deep'), internal: false } } : {});
  }
  if (content.parts.get(partId)?.region === 'head' && amount >= B.concussionAt && rng() < Math.min(0.9, B.concussionChance * amount)) add('concussion', 'head', clamp(Math.round(amount / 4), 1, 8));
  if (torsoish && amount >= B.internalAt) internalBleed(body, partId, amount, add);
}

/** Penetrating / deep hits under the torso or skull may damage an organ underneath. */
function organRoll(body, partId, depth, amount, add, D) {
  const under = body.content.parts.get(partId)?.under ?? [];
  const p = D.organRoll[depth];
  if (!under.length || !p || body.rng() >= p) return;
  const organ = under[Math.floor(body.rng() * under.length)];
  const organDef = body.content.parts.get(organ);
  const sev = clamp(Math.round(amount * D.organRoll.severityPerAmount * 10) / 10, 1, 10);
  const internal = ['heart', 'liver', 'lung_left', 'lung_right', 'stomach'].includes(organ);
  add('organ_damage', organ, sev, internal ? { geometry: { internal: true, internalRate: Math.round(sev * (organ === 'heart' ? 8 : 4) * 10) / 10 } } : {});
  return organDef;
}

export function internalBleed(body, partId, amount, add) {
  const rate = Math.round(clamp(amount * 1.6, 2, 70) * 10) / 10; // % blood per hour
  return add('internal_bleeding', partId, clamp(Math.round(rate / 6), 1, 10), { geometry: { internal: true, internalRate: rate } });
}

function blast(body, c, spec, out, add, cause) {
  const { content, rng } = body;
  const D = content.damage;
  const amount = Math.max(1, Number(spec.amount) || 15);
  const n = clamp(spec.fragments ?? Math.round(1 + amount / D.blast.fragmentsPer * 2 + rng() * 2), 1, 8);
  for (let i = 0; i < n; i++) {
    const partId = resolvePart(body, c, spec.part ?? 'random');
    const a = Math.max(1.5, amount * between(rng, 0.15, 0.5)) * (content.parts.get(partId)?.headMult ?? 1);
    out.parts.push(partId);
    out.garments.push(...wearGarments(body, c, partId, 'blast', a, cause));
    const w = makeWound(body, partId, { kind: 'fragment', amount: a });
    add(w.geometry.depth === 'deep' && rng() < 0.4 ? 'puncture' : 'cut', partId, w.severity, { geometry: w.geometry });
  }
  if (rng() < (spec.burnChance ?? D.blast.burnChance)) {
    const partId = resolvePart(body, c, 'random');
    add('burn', partId, clamp(Math.round(amount * D.burn.severityPerAmount * 10) / 10, 1, 8), { geometry: { area_cm2: Math.round(amount * D.burn.areaPerAmount), depth: 'moderate' } });
  }
  if (rng() < D.blast.earChance) {
    for (const ear of ['ear_left', 'ear_right']) if (rng() < 0.8) add('ear_damage', ear, clamp(Math.round(amount / 4), 2, 7), { flags: { temporary: true } });
  }
  if (rng() < D.blast.concussionChance * (amount / 15)) add('concussion', 'head', clamp(Math.round(amount / 5), 1, 7));
  body.world.logEvent('injury', {
    actorId: c.id, location: c.location, damageType: 'blast', amount, cause, sourceId: spec.sourceId ?? null,
    conditions: out.conditions.map((x) => ({ id: x.id, type: x.type, part: x.partId, severity: x.severity })), garments: out.garments,
  });
  body.afterChange(c);
  return out;
}
