// Step 7B: healing over game time, infection, fever, lasting effects. Realistic speeds (HEAL_TIME_SCALE=1.0):
// healing += elapsed / healTime x factors x regen. Natural healing has limits: above a type's naturalMax (serious eye,
// ear, organ, spine damage) or its healFloor, rest does nothing; fractures and dislocations don't heal untreated.
import { clamp } from './content.js';

const QUALITY = { untreated: 0.4, improvised: 0.6, poor: 0.7, good: 1.0, excellent: 1.3 };

export function isClosed(cond) {
  const f = cond.flags ?? {};
  const g = cond.geometry ?? {};
  if (g.internal) return cond.clot >= 0.95;
  if (!g.vessel) return true;
  return Boolean(f.clotted || f.stitched || f.cauterized);
}

export function qualityOf(cond) {
  return QUALITY[cond.flags?.quality ?? 'untreated'] ?? 0.4;
}

/** Why this condition can't heal right now (null = it can). */
function blockedBy(content, cond) {
  const def = content.typeDef(cond.type);
  const req = def?.requires;
  const f = cond.flags ?? {};
  if (req && cond.severity > (req.above ?? 0)) {
    if (req.allOf && !req.allOf.every((k) => f[k])) return `needs: ${req.allOf.join(', ')}`;
    if (req.anyOf && !req.anyOf.some((k) => f[k])) return `needs: ${req.anyOf.join(' or ')}`;
  }
  if (cond.severity > (def?.naturalMax ?? 10) && !f.externalHeal) return 'beyond natural healing';
  return null;
}

/**
 * Advance healing for one citizen's conditions by `minutes`. ctx: { scale, illness, rest, nutrition, fever, anemic,
 * regen, moved, infectedParts:Set }. Returns { resolved: [cond], worsened: [cond] } (the Body persists and logs).
 */
export function healTick(content, conds, ctx, minutes) {
  const out = { resolved: [], worsened: [] };
  const hours = minutes / 60;
  for (const cond of conds) {
    const def = content.typeDef(cond.type);
    if (!def || cond.resolvedAt != null || cond.permanent || def.auto) continue;
    if (cond.type === 'fever') continue; // follows the infection that drives it (infectionTick)
    if (cond.geometry?.internal) {
      if (cond.clot >= 0.95) out.resolved.push(cond);
      continue;
    }
    if (!def.heal) continue;
    if (!isClosed(cond)) continue; // an open, bleeding wound doesn't start to heal
    const why = blockedBy(content, cond);
    if (why) {
      // a broken limb that is moved while unsplinted gets worse
      if (def.worsensWhenMoved && ctx.moved && cond.severity < 10) {
        cond.severity = clamp(cond.severity + def.worsensWhenMoved * hours, 0, 10);
        out.worsened.push(cond);
      }
      continue;
    }
    const temp = cond.flags?.temporary && def.tempHeal;
    const total = ((temp ? def.tempHeal.base + def.tempHeal.perSev * cond.initialSeverity : def.heal.base + def.heal.perSev * cond.initialSeverity)) * ctx.scale;
    if (total <= 0) continue;
    const floor = temp ? 0 : def.healFloor ?? 0;
    const cap = floor > 0 ? 1 - floor / cond.initialSeverity : 1;
    if (cap <= cond.healing + 1e-9) continue;
    const infected = ctx.infectedParts?.has(cond.partId);
    const factor = qualityOf(cond)
      * (def.naturalMax < 10 ? 1 : ctx.rest) // rest only speeds up what rest can heal
      * ctx.nutrition * (infected ? 0.3 : 1) * (ctx.fever ? 0.7 : 1) * (ctx.anemic ? 0.8 : 1) * ctx.regen
      * (cond.flags?.sling ? 1.1 : 1);
    cond.healing = Math.min(cap, cond.healing + (hours / total) * factor);
    cond.severity = Math.max(floor, Math.round(cond.initialSeverity * (1 - cond.healing) * 100) / 100);
    if (cond.healing >= 0.999 && floor === 0) out.resolved.push(cond);
  }
  return out;
}

/** The infection risk per game hour of a wound (null = this wound can't get infected). */
export function infectionRisk(content, cond) {
  const def = content.typeDef(cond.type);
  const inf = def?.infection;
  if (!inf || cond.resolvedAt != null) return null;
  if (inf.minSeverity && cond.severity < inf.minSeverity) return null;
  const f = cond.flags ?? {};
  let r = inf.untreated;
  if (f.cauterized) r = inf.cauterized ?? inf.bandaged;
  else if (f.bandaged && f.cleaned) r = (inf.bandaged ?? r) * 0.6;
  else if (f.bandaged) r = inf.bandaged ?? r;
  else if (f.cleaned) r = inf.cleaned ?? r;
  else if (f.wrapped) r = r * 0.85; // cloth isn't clean
  if (f.stitched) r *= 0.6;
  if (f.herbal) r *= 0.5;
  if (isClosed(cond) && cond.healing > 0.6) r *= 0.25; // mostly healed over
  return r;
}

/**
 * Wound infection progress. Returns { newInfections: [cond], fever: number|null } — the Body creates the infection
 * conditions, and sets the fever severity this returns (target) for a systemic condition.
 */
export function infectionTick(content, conds, ctx, minutes, now) {
  const hours = minutes / 60;
  const out = { newInfections: [], feverTarget: null, grown: [] };
  for (const cond of conds) {
    if (cond.resolvedAt != null) continue;
    if (cond.type === 'infection') {
      const def = content.typeDef('infection');
      const f = cond.flags;
      if (f.contained) cond.flags.age = (f.age ?? 0) + hours; // keeps its age; no growth
      else {
        cond.flags.age = (f.age ?? 0) + hours;
        const growth = (def.grows ?? 0.08) * hours * ctx.illness * (f.herbal ? 0.3 : 1);
        if (growth > 0) {
          cond.severity = clamp(cond.severity + growth, 1, 10);
          cond.initialSeverity = Math.max(cond.initialSeverity, cond.severity);
          out.grown.push(cond);
        }
      }
      if ((cond.flags.age ?? 0) >= (def.feverAfterHours ?? 24) && !cond.flags.contained) {
        out.feverTarget = Math.max(out.feverTarget ?? 0, clamp(0.85 * cond.severity + 1, 2, 10));
      }
      continue;
    }
    const risk = infectionRisk(content, cond);
    if (risk == null || cond.flags?.infected) continue;
    cond.infection = Math.min(1, cond.infection + risk * hours * ctx.illness);
    if (cond.infection >= 1) out.newInfections.push(cond);
  }
  return out;
}

/** Lasting effects when a condition resolves: [{ type, severity, partId }] to become permanent conditions. */
export function rollSequelae(content, cond, rng) {
  const def = content.typeDef(cond.type);
  const out = [];
  const seen = new Set();
  const f = cond.flags ?? {};
  const poor = !f.quality || ['untreated', 'improvised', 'poor'].includes(f.quality) || (def?.capCap && !(f.splinted && f.set));
  for (const s of def?.sequelae ?? []) {
    if (seen.has(s.type) || cond.initialSeverity < (s.minSeverity ?? 0)) continue;
    if (s.when === 'poor' && !poor) continue;
    if (s.parts === 'leg' && !content.isLeg(cond.partId)) continue;
    if (s.parts === 'other' && content.isLeg(cond.partId)) continue;
    if (rng() < s.chance) {
      seen.add(s.type);
      out.push({ type: s.type, partId: cond.partId, severity: clamp(Math.round((cond.initialSeverity * 0.5 + 1) * 10) / 10, 1, 6) });
    }
  }
  return out;
}
