// Step 7B: the derived body. Part health, capacities (0..1), status effects and pain are COMPUTED from the
// active conditions (plus blood, vitality, fatigue and aids) and cached by Body; nothing here mutates state.
import { clamp } from './content.js';

// Stages by blood level, each with the LOWER bound it starts at (none >= 85, mild 70-85, moderate 60-70, severe 50-60, critical below).
export const stageFor = (B, blood) => {
  const st = B.stages.find((s) => blood >= s.min) ?? B.stages.at(-1);
  return blood < (B.deathBlood ?? 35) ? { ...B.stages.at(-1), name: 'fatal blood loss' } : st;
};

/** Part health fractions (0..1) from active conditions. Returns { frac(partId), missing:Set, destroyed:Set }. */
export function partHealth(content, conds) {
  const loss = new Map();
  const missing = new Set();
  const destroyed = new Set();
  for (const c of conds) {
    const def = content.typeDef(c.type);
    if (!def || !c.partId || !content.parts.has(c.partId)) continue;
    if (c.type === 'severed') {
      missing.add(c.partId);
      for (const d of content.descendants(c.partId)) missing.add(d);
      continue;
    }
    if (def.loss) loss.set(c.partId, (loss.get(c.partId) ?? 0) + def.loss * c.severity);
    if (def.destroyAt && c.severity >= def.destroyAt) destroyed.add(c.partId);
  }
  const frac = (id) => (missing.has(id) || destroyed.has(id) ? 0 : clamp(1 - (loss.get(id) ?? 0), 0, 1));
  return { frac, missing, destroyed };
}

// How much each link of a limb chain matters (a bruised upper arm hardly hampers the hand; a lost hand does).
const ARM = [['upper_arm', 0.3], ['forearm', 0.5], ['hand', 1], ['fingers', 0.6]];
const LEG = [['thigh', 0.8], ['shin', 0.8], ['foot', 0.5]];

// Multiplied down the chain; once a link is destroyed or missing, everything beyond it contributes nothing.
function chain(content, health, links, side) {
  let v = 1;
  let zero = false;
  for (const [base, w] of links) {
    const f = zero ? 0 : health.frac(`${base}_${side}`);
    if (f <= 0) zero = true;
    v *= 1 - w * (1 - f);
  }
  return v;
}

/** The cap a fracture or dislocation puts on the limb it is in (until splinted / set). */
function limbCap(content, conds, region) {
  let cap = 1;
  for (const c of conds) {
    const def = content.typeDef(c.type);
    if (!def?.capCap || content.parts.get(c.partId)?.region !== region) continue;
    const f = c.flags ?? {};
    const k = f.set && def.capCap.set != null ? def.capCap.set : f.splinted ? def.capCap.splinted : def.capCap.unsplinted;
    cap = Math.min(cap, k);
  }
  return cap;
}

/**
 * state: { conds (active), blood, vitality, fatigue, aids: { crutch, peg: {left,right}, eyePatch, sling } }
 * → { parts, capacities, status, pain, stage, conscious }
 */
export function computeBody(content, state) {
  const { conds, blood, vitality } = state;
  const B = content.bleeding;
  const aids = state.aids ?? {};
  const health = partHealth(content, conds);
  const stage = stageFor(B, blood);

  // pain: the worst wound counts fully, the rest a third each; some aids take the edge off
  let painMax = 0;
  let painSum = 0;
  for (const c of conds) {
    const def = content.typeDef(c.type);
    if (!def) continue;
    const pb = c.flags?.painBoost;
    const boost = pb && typeof pb === 'object' ? ((pb.until ?? 0) > (state.now ?? 0) ? pb.amount ?? 1 : 0) : pb && pb > (state.now ?? 0) ? 1 : 0;
    let p = (def.painPerSev ?? 0) * c.severity + boost;
    if (c.flags?.bandaged) p -= 0.5;
    if (aids.sling && content.limbOf(c.partId) === 'arm') p -= 1;
    if (aids.eyePatch && c.type === 'eye_damage') p -= 1;
    if (c.flags?.herbal) p -= 2;
    p = clamp(p, 0, 10);
    c.pain = Math.round(p * 100) / 100;
    painMax = Math.max(painMax, p);
    painSum += p;
  }
  const pain = clamp(painMax + 0.3 * (painSum - painMax), 0, 10);

  const sev = (type) => Math.max(0, ...conds.filter((c) => c.type === type).map((c) => c.severity));
  const frac = health.frac;
  const brain = frac('brain');
  const shock = vitality < 30 || pain >= 8;
  const concussed = conds.some((c) => c.type === 'concussion');
  const fever = sev('fever');
  // step 10: choking steps and smoke (c.phys.asphyxia + c.phys.smoke): about 3 → senseless
  const asph = Math.max(0, Number(state.asphyxia) || 0);
  const cons = clamp(
    brain - 0.25 * asph + stage.consciousness - (shock ? 0.3 : 0) - (concussed ? 0.15 : 0) - (fever >= 6 ? 0.05 * (fever - 5) : 0)
      - ((state.fatigue ?? 0) >= 93 ? 0.05 : 0) - (vitality < 15 ? 0.2 : 0),
    0, 1,
  );

  // senses
  const eyeAdj = (id) => (conds.some((c) => c.type === 'reduced_sight' && c.partId === id) ? 0.7 : 1);
  const sight = clamp(0.5 * frac('eye_left') * eyeAdj('eye_left') + 0.5 * frac('eye_right') * eyeAdj('eye_right'), 0, 1);
  const hearing = clamp(0.5 * frac('ear_left') + 0.5 * frac('ear_right'), 0, 1);
  const speech = clamp(Math.min(frac('jaw'), frac('tongue')) * (cons < 0.5 ? cons * 2 : 1), 0, 1);
  const lungs = (frac('lung_left') + frac('lung_right')) / 2;
  const breathing = clamp(lungs * (0.6 + 0.4 * frac('chest')) * (0.5 + 0.5 * frac('neck')) * (1 - 0.3 * Math.min(3, asph)), 0, 1);
  const bloodPumping = frac('heart');

  // limbs
  const spineDead = frac('spine') <= 0;
  const manip = {};
  for (const side of ['left', 'right']) {
    let m = Math.min(chain(content, health, ARM, side), limbCap(content, conds, `${side}_arm`));
    if (spineDead) m *= 0.5;
    manip[side] = clamp(m, 0, 1);
  }
  const legs = {};
  for (const side of ['left', 'right']) {
    let l = Math.min(chain(content, health, LEG, side), limbCap(content, conds, `${side}_leg`)); // "at most 0.3 until splinted"
    const lowerMissing = health.missing.has(`shin_${side}`) || health.missing.has(`thigh_${side}`) || health.missing.has(`foot_${side}`);
    if (lowerMissing && aids.peg?.[side] && !health.missing.has(`thigh_${side}`)) l = Math.max(l, 0.5); // a peg leg stands in
    legs[side] = clamp(l, 0, 1);
  }
  let moving = (legs.left + legs.right) / 2;
  const hasLeg = legs.left > 0 || legs.right > 0;
  if (aids.crutch && hasLeg && moving < 0.55) moving = 0.55;
  const lastingLimp = conds.some((c) => c.type === 'limp');
  if (lastingLimp) moving = Math.min(moving, content.typeDef('limp')?.movingMax ?? 0.85);
  moving *= 1 - 0.03 * Math.max(0, pain - 5);
  moving *= stage.moving;
  if (cons < 0.5) moving *= cons * 2;
  if (spineDead) moving = 0;
  moving = clamp(moving, 0, 1);

  const eating = clamp(Math.min(frac('jaw'), 0.5 + 0.5 * frac('stomach')), 0, 1);

  const capacities = {
    consciousness: r2(cons), sight: r2(sight), hearing: r2(hearing), speech: r2(speech), breathing: r2(breathing),
    bloodPumping: r2(bloodPumping), manipulationLeft: r2(manip.left), manipulationRight: r2(manip.right),
    moving: r2(moving), eating: r2(eating),
  };
  if (state.reducedSight) capacities.sight = Math.min(capacities.sight, 0.8);

  // status effects: thresholds on capacities, never separate hacks
  const status = [];
  for (const [cap, table] of Object.entries(content.raw.capacityStatus ?? {})) {
    const v = capacities[cap];
    const hit = table.find(([t]) => v < t);
    if (hit) status.push(hit[1]);
  }
  const mL = capacities.manipulationLeft;
  const mR = capacities.manipulationRight;
  if (mL < 0.2 && mR < 0.2) status.push('no hands');
  else if (mL < 0.2 || mR < 0.2) status.push('one-handed');
  if (spineDead) status.push('paralyzed');
  if (cons < 0.3) status.push('unconscious');
  if (shock) status.push('in shock');
  if (concussed) status.push('concussed');
  if (vitality < 15) status.push('dying');

  // parts differing from full health (the cache stored in citizen data)
  const parts = {};
  for (const id of content.parts.keys()) {
    const f = frac(id);
    const miss = health.missing.has(id);
    if (miss || f < 1) parts[id] = { health: r2(f * content.parts.get(id).maxHealth), missing: miss };
  }
  // wear: blood loss stage, anemia (x1.3), pain >= 4 (x1.3), a chill, a fever
  const fatigueFactor = (stage.fatigue ?? 1) * (conds.some((c) => c.type === 'anemia') ? 1.3 : 1) * (pain >= 4 ? 1.3 : 1) * (1 + 0.05 * sev('chill')) * (fever >= 3 ? 1.1 : 1);
  return { parts, capacities, status, pain: r2(pain), stage: stage.name, fatigueFactor: r2(fatigueFactor), shock, concussed, missing: health.missing, destroyed: health.destroyed };
}

const r2 = (v) => Math.round(v * 100) / 100;
