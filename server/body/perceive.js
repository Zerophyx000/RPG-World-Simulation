// Step 7B: perception and the prompt. What a citizen feels in their own body (HOW YOU FEEL), what others can SEE of
// someone (visible conditions, blood on clothes, posture; internal conditions stay invisible), and the physical
// exceptions to "present, don't force": blind, deaf, mute, concussed, in shock. Everything here is text and flags.
import { bySeverity } from './content.js';
import { garmentsCovering, wornGarments } from './garments.js';
import { pronouns } from '../world/citizens.js';

export const statusOf = (c) => c.body?.status ?? [];
export function senses(c) {
  const st = statusOf(c);
  return {
    blind: st.includes('blind'), halfBlind: st.includes('half-blind'), deaf: st.includes('deaf'), hardOfHearing: st.includes('hard of hearing'),
    mute: st.includes('mute'), slurred: st.includes('slurred speech'), concussed: st.includes('concussed'), shock: st.includes('in shock'),
    unconscious: st.includes('unconscious'),
  };
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const label = (B, partId) => B.content.partLabel(partId);

/** The patient's own sensation of one condition (never a diagnosis). */
function feelText(B, cond) {
  const part = label(B, cond.partId);
  const f = cond.flags ?? {};
  if (cond.partId && cond.severity >= 2) {
    if (f.bandaged) return `Your ${part} throbs under the bandage.`;
    if (f.wrapped) return `Your ${part} throbs under the cloth wrapped around it.`;
    if (f.splinted) return `Your ${part} aches inside the splint.`;
    if (f.stitched) return `Your ${part} pulls where it is stitched.`;
  }
  return B.woundText(cond).feel;
}

const BLOOD_FEEL = {
  'mild blood loss': 'You feel pale and thirsty, and uneasy.',
  'moderate blood loss': 'Your pulse is racing and a cold sweat breaks out on you.',
  'severe blood loss': 'Everything is grey and far away; you can barely think.',
  'critical blood loss': 'The world is going dark at the edges.',
};

function sideOf(B, c, kind) {
  // which side is impaired: the part (leg/arm) with a fracture, dislocation, severed part or low health
  const sides = [];
  for (const side of ['left', 'right']) {
    const parts = kind === 'leg' ? [`thigh_${side}`, `shin_${side}`, `foot_${side}`] : [`upper_arm_${side}`, `forearm_${side}`, `hand_${side}`, `fingers_${side}`];
    const bad = B.active(c.id).some((x) => parts.includes(x.partId) && ['fracture', 'dislocation', 'severed', 'crush'].includes(x.type));
    if (bad || parts.some((p) => c.body.parts?.[p]?.missing || (c.body.parts?.[p] && c.body.parts[p].health <= 0))) sides.push(side);
  }
  return sides;
}

/** Lines for HOW YOU FEEL and an urgency line. → { lines, urgent } */
export function ownBody(world, c) {
  const B = world.body;
  const st = c.body;
  const lines = [];
  let urgent = null;
  if (!st) return { lines, urgent };
  const conds = B.active(c.id);
  // the three conditions that matter most to them: pain x severity
  const ranked = conds.filter((x) => (x.pain ?? 0) > 0.5 || x.type === 'fever' || x.type === 'chill').sort((a, b) => (b.pain ?? 0) * b.severity - (a.pain ?? 0) * a.severity).slice(0, 3);
  for (const x of ranked) lines.push(feelText(B, x));
  if (BLOOD_FEEL[st.stage]) lines.push(BLOOD_FEEL[st.stage]);

  const S = new Set(st.status ?? []);
  const sides = (kind) => sideOf(B, c, kind);
  if (S.has("can't move")) lines.push("You can't move your legs.");
  else if (S.has('crawling only')) lines.push("You can't walk; you can only drag yourself along the ground.");
  else if (S.has('limping')) {
    const s = sides('leg');
    lines.push(s.length === 1 ? `You can't put your weight on your ${s[0]} leg.` : 'Your legs will not carry you properly.');
  }
  if (S.has('blind')) lines.push("You can't see anything.");
  else if (S.has('half-blind')) lines.push('Your sight is poor; the world is dim and blurred on one side.');
  for (const side of ['left', 'right']) if ((c.body.parts?.[`eye_${side}`]?.health ?? 5) <= 0 && !S.has('blind')) lines.push(`Your ${side} eye sees nothing.`);
  if (S.has('deaf')) lines.push("You can't hear anything.");
  else if (S.has('hard of hearing')) lines.push('Sounds are muffled, as if through water.');
  if (S.has('mute')) lines.push("You can't make a sound; you can only gesture.");
  else if (S.has('slurred speech')) lines.push('Your words come out slurred and thick.');
  if (S.has('no hands')) lines.push("You can't use your hands.");
  else if (S.has('one-handed')) lines.push(`You can't use your ${(c.body.capacities.manipulationLeft ?? 1) < 0.2 ? 'left' : 'right'} hand.`);
  if (S.has('paralyzed')) lines.push("You can't feel your legs at all.");
  if (S.has('concussed')) lines.push('Your thoughts keep slipping; the edges of things blur.');
  if (S.has('in shock')) lines.push('You are shaking and cold, and everything feels unreal.');

  // bleeding
  const wounds = (st.bleedWounds ?? []).map((w) => ({ cond: B.conditionById(c.id, w.id), rate: w.rate })).filter((w) => w.cond && !w.cond.geometry?.internal).sort((a, b) => b.rate - a.rate);
  if ((st.bleedTotal ?? 0) >= 1 && wounds.length) {
    const w = wounds[0];
    const g = garmentsCovering(world, c.id, w.cond.partId)[0];
    lines.push(g && w.rate < 30 ? `Blood is soaking through your ${world.objects.type(g)?.name ?? 'clothes'}; it isn't stopping.` : `Blood is running from your ${label(B, w.cond.partId)}; it isn't stopping.`);
  }
  if ((st.bleedTotal ?? 0) >= 10) lines.push("You're losing a lot of blood; your hands are cold and shaking.");
  // the urgency line
  const crit = st.critical ? B.active(c.id).find((x) => x.flags?.critical) : null;
  if (st.critical) urgent = `Blood is ${crit && crit.bleeding >= 100 ? 'pumping' : 'pouring'} out of your ${crit ? label(B, crit.partId) : 'body'}. You have minutes.`;
  else if ((st.bleedTotal ?? 0) >= 5 || (st.vitality ?? 100) < 40) urgent = (st.bleedTotal ?? 0) >= 5 ? 'You are bleeding badly and growing weaker; you need help soon.' : 'You are growing weaker; you need help.';
  return { lines, urgent };
}

/** What others can see of this person: visible conditions, blood, posture, aids, torn clothes. → string ('' if nothing) */
export function cuesFor(world, o) {
  const B = world.body;
  if (!o.body || !o.alive) return '';
  const pr = pronouns(o);
  const poss = pr.poss;
  const cues = [];
  const conds = B.active(o.id).filter((x) => x.visible && x.type !== 'anemia').sort((a, b) => b.severity - a.severity);
  const covered = (partId) => garmentsCovering(world, o.id, partId).find((g) => g.state === 'intact' || g.state === 'worn');
  const short = (g) => world.objects.type(g)?.name ?? 'garment';
  for (const x of conds.slice(0, 4)) {
    const f = x.flags ?? {};
    const part = x.partId ? label(B, x.partId) : null;
    if (!x.partId) { cues.push(bySeverity(B.content.typeDef(x.type)?.surface, x.severity)); continue; }
    const g = garmentsCovering(world, o.id, x.partId)[0];
    const stained = Boolean(g?.data?.bloodied);
    if (f.bandaged) cues.push(`a bandage around ${poss} ${part}${stained ? ', stained red' : ''}`);
    else if (f.wrapped) cues.push(`a strip of cloth bound round ${poss} ${part}${stained || x.bleeding > 0.5 ? ', dark with blood' : ''}`);
    else if (f.splinted) cues.push(`${poss} ${part} bound in a splint`);
    else if (x.type === 'scar' || x.type === 'chronic_pain') { if (x.type === 'scar') cues.push(B.woundText(x).look); }
    else if (covered(x.partId) && ['cut', 'puncture', 'burn', 'crush', 'bruise'].includes(x.type)) { if (x.bleeding > 0.5) cues.push(`a blood-soaked ${short(covered(x.partId))}`); }
    else cues.push(B.woundText(x).look.replaceAll('their', poss));
  }
  const S = new Set(statusOf(o));
  if (S.has("can't move") || S.has('crawling only')) cues.push('dragging along the ground');
  else if (S.has('limping')) cues.push('limping');
  if (S.has('one-handed')) cues.push(`holding ${poss} arm against ${poss} body`);
  if (S.has('blind')) cues.push('staring blankly, groping at the air');
  if (S.has('paralyzed')) cues.push(`unable to move ${poss} legs`);
  const stage = o.body.stage;
  if (stage === 'severe blood loss' || stage === 'critical blood loss') cues.push('grey-skinned and glassy-eyed');
  else if (stage === 'moderate blood loss') cues.push('pale and sweating');
  if (conds.some((x) => x.type === 'fever' && x.severity >= 3)) cues.push('flushed and sweating');
  for (const g of wornGarments(world, o.id)) {
    const stain = g.data?.bloodied ? ' and stained with blood' : '';
    if (g.state === 'rags') cues.push(`${poss} ${short(g)} torn into strips${stain}`);
    else if (g.state === 'torn') cues.push(`${poss} ${short(g)} torn${stain}`);
    else if (g.data?.bloodied) cues.push(`${poss} ${short(g)} stained with blood`);
  }
  for (const a of world.objects.wornBy(o.id)) {
    if (a.typeId === 'sling' && !conds.some((x) => x.flags?.splinted)) cues.push(`${poss} arm in a sling`);
    if (a.typeId === 'eye_patch') cues.push('an eye patch');
    if (a.typeId === 'peg_leg') cues.push('walking on a peg leg');
  }
  if (world.objects.carriedBy(o.id).some((a) => a.typeId === 'crutch')) cues.push('leaning on a crutch');
  const uniq = [...new Set(cues.filter(Boolean))].slice(0, 5);
  return uniq.length ? `Looks hurt: ${uniq.join('; ')}.` : '';
}

/** Dynamic appearance tags from step 5.5's cue list (wariness): wounded, bloodied, ragged. */
export function dynamicTags(world, o) {
  const tags = [];
  if (!o.body) return tags;
  const B = world.body;
  const visible = B.active(o.id).some((x) => x.visible && x.partId && ['cut', 'puncture', 'burn', 'fracture', 'crush'].includes(x.type) && x.severity >= 3);
  if (visible) tags.push('wounded');
  const garments = wornGarments(world, o.id);
  if (garments.some((g) => g.data?.bloodied)) tags.push('bloodied');
  if (garments.filter((g) => g.state === 'torn' || g.state === 'rags').length >= 2) tags.push('ragged');
  return tags;
}

/** One line for YOU'RE CARRYING: wearing…, only when something is damaged or stained. */
export function wearingLine(world, c) {
  const bad = wornGarments(world, c.id).filter((g) => g.state === 'torn' || g.state === 'rags' || g.state === 'destroyed' || g.data?.bloodied);
  if (!bad.length) return null;
  const words = (g) => `your ${g.state === 'intact' || g.state === 'worn' ? '' : `${g.state} `}${world.objects.type(g)?.name ?? 'garment'}${g.data?.bloodied ? ' (bloodied)' : ''}`.replace('  ', ' ');
  return `You are wearing: ${bad.map(words).join(', ')}.`;
}

// ---------- hearing: speech and sound reach a deaf or hard-of-hearing citizen changed ----------
const SOUNDY = /bang|boom|blast|scream|bell|roar|crash|shout|cry|thunder|clang|explosion|shriek/i;

/** Adjust a stimulus on its way to citizen `c` (mutates a copy). */
export function hearing(c, s) {
  const sn = senses(c);
  if (!sn.deaf && !sn.hardOfHearing) return s;
  const out = { ...s, data: { ...(s.data ?? {}) } };
  if (s.kind === 'speech') {
    const who = s.sourceId ? `{{c:${s.sourceId}}}` : 'Someone';
    if (sn.deaf) out.text = `${who}'s lips move, but you can't hear anything.`;
    else if (!s.data?.addressed) out.text = `${who} says something, too muffled to make out.`;
    out.data.heardPoorly = true;
  } else if (sn.deaf && (s.kind === 'director' || s.kind === 'action') && SOUNDY.test(s.text ?? '')) {
    out.text = "You hear nothing, but you feel the floor shudder and see everyone around you flinch.";
  }
  return out;
}

/** Whether a concussed or shocked head still takes this detail in (1–2 non-essential details drop out). */
export function dropsDetail(c, index, seed = 0) {
  const sn = senses(c);
  if (!sn.concussed) return false;
  return (index * 7 + seed) % 5 === 0;
}
