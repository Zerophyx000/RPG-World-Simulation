// Step 7B: the detailed bleeding model. Per wound: how fast it bleeds (vessel x size x gape x part x activity x
// (1 - clot) x treatment), how fast it clots (slowed by size and gape, shared between wounds, worse as blood is lost),
// internal bleeding that nothing external touches, and the critical grace window. All numbers: content/bleeding.json.
import { clamp } from './content.js';
import { stageFor } from './model.js';

const PUNCTURE_SIZE = { superficial: 0.3, moderate: 0.5, deep: 0.9, penetrating: 1.3 };
const ARTERIAL = new Set(['minor_arterial', 'major_arterial']);

export function sizeFactor(B, cond) {
  const g = cond.geometry ?? {};
  const s = B.sizeFactor;
  if (g.area_cm2 != null) return clamp(g.area_cm2 / 100, 0.1, s.max);
  if (cond.type === 'puncture') return PUNCTURE_SIZE[g.depth] ?? 0.5;
  return clamp((g.length_cm ?? 3) / s.cmPer, s.min, s.max);
}

/** Which tourniquet (if any) covers this wound: { eff } for a tourniquet on its part or a part proximal to it. */
function tourniquetEff(content, cond, tourniquets) {
  let eff = 0;
  for (const t of tourniquets ?? []) {
    if (t.part === cond.partId || content.descendants(t.part).includes(cond.partId)) eff = Math.max(eff, t.eff ?? 1);
  }
  return eff;
}

/** Multipliers from treatment flags: { rate, clot, floor (minimum clot speed for arterial wounds) }. */
export function treatmentEffect(B, cond, now) {
  const f = cond.flags ?? {};
  const g = cond.geometry ?? {};
  const v = g.vessel ?? 'capillary';
  let rate = 1;
  let clot = 1;
  let floor = 0;
  const use = (key, floorSpeed, soak = 1) => {
    const t = B.treatment[key];
    if (!t) return;
    rate *= 1 - (1 - (t[v] ?? 1)) * soak;
    clot *= 1 + (t.clot - 1) * soak;
    floor = Math.max(floor, floorSpeed * soak);
  };
  if (f.pressure) use('pressure', 0.002);
  if (f.wrapped) use('wrapped', 0.0008);
  if (f.bandaged) use('bandaged', 0.002, f.bandagedAt != null && now - f.bandagedAt > 24 * 60 ? 0.5 : 1); // soaks through
  if (f.packed) use('packed', 0.004);
  if (f.stitched) rate = 0;
  if (f.cauterized) rate *= (g.length_cm ?? 0) <= 8 ? 0 : 0.3;
  return { rate: Math.max(0, rate), clot, floor };
}

/** Current real bleeding rate of one wound, % of blood per game hour. */
export function woundRate(content, cond, ctx) {
  const B = content.bleeding;
  const g = cond.geometry ?? {};
  if (cond.resolvedAt != null || !g.vessel && !g.internal) return 0;
  if (g.internal) return Math.max(0, (g.internalRate ?? 0) * (1 - cond.clot));
  if (cond.flags?.clotted) return 0;
  const part = content.parts.get(cond.partId);
  const t = treatmentEffect(B, cond, ctx.now);
  let r = (B.vesselBase[g.vessel] ?? 1) * sizeFactor(B, cond) * (g.gape ?? 0.5) * (part?.bleedFactor ?? 1)
    * (ctx.activity ?? 1) * (1 - cond.clot) * t.rate;
  const tq = tourniquetEff(content, cond, ctx.tourniquets);
  if (tq) r *= 1 - tq;
  return Math.max(0, r);
}

/**
 * One tick for every open wound: clot progress, then the new rates. Mutates cond.clot / cond.bleeding / flags.clotted.
 * ctx: { now, activity (multiplier), stagePenalty (clot multiplier from blood loss), cold, tourniquets }
 * → { total, external, internal, wounds: [{ cond, rate }] }
 */
export function stepWounds(content, conds, ctx, elapsed) {
  const B = content.bleeding;
  const open = conds.filter((c) => (c.geometry?.vessel || c.geometry?.internal) && c.resolvedAt == null);
  const before = open.map((c) => woundRate(content, c, ctx));
  const bleeding = before.filter((r) => r > 0.2).length;
  open.forEach((c, i) => {
    if (c.flags?.clotted && !c.geometry.internal) return;
    const g = c.geometry;
    const others = Math.max(0, bleeding - (before[i] > 0.2 ? 1 : 0));
    const eff = Math.max(0.3, 1 - 0.12 * others) * (ctx.stagePenalty ?? 1) * (ctx.cold ? 0.7 : 1);
    let speed;
    if (g.internal) speed = (g.internalRate ?? 0) < B.internal.smallBelow ? B.internal.clotSpeed : 0;
    else {
      const t = treatmentEffect(B, c, ctx.now);
      speed = B.clotSpeed[g.vessel] ?? 0;
      if (ARTERIAL.has(g.vessel)) speed = Math.max(speed, t.floor);
      speed = speed / sizeFactor(B, c) * Math.max(0.1, 1.2 - (g.gape ?? 0.5)) * t.clot;
    }
    if (speed > 0) c.clot = Math.min(1, c.clot + elapsed * speed * eff);
    if (c.clot >= 0.95 && !g.internal && !(ARTERIAL.has(g.vessel) && g.vessel === 'major_arterial' && !speed)) {
      c.flags.clotted = true;
      c.clot = 1;
    }
  });
  const rates = open.map((c) => woundRate(content, c, ctx));
  let external = 0;
  let internal = 0;
  open.forEach((c, i) => {
    c.bleeding = Math.round(rates[i] * 100) / 100;
    if (c.geometry.internal) internal += rates[i];
    else external += rates[i];
  });
  return { total: external + internal, external, internal, wounds: open.map((cond, i) => ({ cond, rate: rates[i], before: before[i] })) };
}

/** The word for a wound's bleeding rate: oozing … spurting. */
export function bleedWord(B, rate) {
  for (const t of B.texts) if (rate <= t.max) return t.name;
  return B.texts.at(-1).name;
}

/**
 * Is this body's bleeding survivable if someone acts in time? Every wound bleeding faster than the threshold needs
 * a method that could control it (a limb: tourniquet; neck, torso, groin: packing or firm pressure), and nothing
 * may be non-survivable already (a destroyed vital part, internal bleeding over the limit, or too much in total).
 */
export function survivable(content, wounds, { vitalDestroyed = false } = {}) {
  const B = content.bleeding;
  if (vitalDestroyed) return false;
  const internal = wounds.filter((w) => w.cond.geometry.internal).reduce((s, w) => s + w.rate, 0);
  const external = wounds.filter((w) => !w.cond.geometry.internal).reduce((s, w) => s + w.rate, 0);
  if (internal > B.critical.internalMax || external > B.critical.totalMax) return false;
  // several major arteries at once: nobody can control that in time
  const majors = wounds.filter((w) => !w.cond.geometry.internal && w.cond.geometry.vessel === 'major_arterial' && w.rate > B.critical.survivableRate).length;
  if (majors > (B.critical.majorArterialMax ?? 1)) return false;
  // every other wound over the threshold can be controlled by SOME method in this model (a limb: tourniquet; neck,
  // torso, groin: packing or firm pressure), so nothing else makes it non-survivable
  return true;
}

/** Drain applied to blood this tick (% points), after the critical grace cap. */
export function appliedDrain(total, elapsed, cap) {
  const perHour = cap != null ? Math.min(total, cap) : total;
  return (perHour * elapsed) / 60;
}

export { stageFor };
