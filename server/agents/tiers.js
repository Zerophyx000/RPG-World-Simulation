// Tiered thinking: how hard a citizen thinks about a decision, decided in code BEFORE the call.
//
// step 10 (0.1): the tier follows CHANGE, not level. A 9.5 GLM run made 78% of a calm day's decisions full because the
// model keeps its characters' feelings high all the time ("any feeling >= 5 → full"). A grieving baker at grief 7 needs
// deep reasoning when something changes, not every time she kneads dough. Each decision leaves a snapshot on the citizen
// (c.tierSnap = { at, emotions: { "type|target": intensity }, seen: [stimulus ids], deaths: "id:certainty,…" }); the next
// decision is
//
//   full   (tier_reason)  waking        the first decision after a real sleep (step 9.5 A4)
//                         altercation   target, aggressor or importance-8 bystander in a fight (step 10 §3.2)
//                         critical      a critical bleeding window in the room (their own or someone's): minutes decide
//                         death_news    the first decision after learning of a death or finding a body
//                         new_stimulus  a stimulus not decided on yet, importance >= TIER_FULL_IMPORTANCE (6), not routine
//                         emotion_jump  an emotion rose by >= TIER_EMOTION_JUMP (3), or a new one appeared at >= 5
//   none   (routine)      ONLY mechanical moments: an activity timer ended, nothing else, calm inside and out
//   light  (conversation | ordinary)   everything else. Sustained feelings still colour it: HOW YOU FEEL and ON YOUR
//                         MIND are in every prompt, plus "Still with you: …" for an old strong feeling.
//
// Conversation turns (step 10, after the calm-day GLM run: 142 of 159 full decisions were someone speaking to them):
// being spoken to counts as a new stimulus of its own importance (9) only when it OPENS an exchange — the first line
// this person has addressed to them in the last OPENING_GAP_MINUTES (30). Later turns of the same exchange count as
// importance 5 (light, and subject to the cap): a turn that changes how they feel is still full by emotion_jump, and
// news of a death by death_news. c.addressedBy = { speakerId: last game minute they addressed this citizen }.
//
// Per-citizen cap: at most FULL_PER_GAME_HOUR (2) full decisions in a rolling game hour; beyond that → light, logged as
// `tier_capped`. Exempt: waking, altercations, critical bleeding, and any fresh stimulus of importance >= TIER_CAP_EXEMPT_IMPORTANCE (8)
// (addressed speech is 9, so being spoken to is always full).
//
// Caps: LLM_MAX_TOKENS_FULL / _LIGHT / _NONE (server/llm.js). Protected FULL decisions (death, grief, fear, critical
// bodies, addressed speech) get LLM_MAX_TOKENS_PROTECTED (4,500), and the governor never downgrades them (A6).
// Emotions never lower a tier unless EMOTION_PARAM_EFFECTS=true (experiments only).
import { config } from '../config.js';
import { tierEffect } from '../emotions/present.js';
import { isRoutineStimulus } from './habits.js';

const n = (key, fallback) => { const v = Number(process.env[key]); return Number.isFinite(v) && process.env[key] !== '' ? v : fallback; };
export const TIER_RULES = {
  fullImportance: n('TIER_FULL_IMPORTANCE', 6),
  emotionJump: n('TIER_EMOTION_JUMP', 3),
  fullPerGameHour: n('FULL_PER_GAME_HOUR', 2),
  capExemptImportance: n('TIER_CAP_EXEMPT_IMPORTANCE', 8),
};
const PROTECTED_MAX_TOKENS = n('LLM_MAX_TOKENS_PROTECTED', 4500);
const SEEN_KEEP = 80;
const OPENING_GAP_MINUTES = n('TIER_OPENING_GAP_MINUTES', 30);
const TURN_IMPORTANCE = 5;
const MECHANICAL = new Set(['timer']);
/** Reasons that the per-hour cap never downgrades. */
const CAP_EXEMPT = new Set(['waking', 'altercation', 'critical']);

const emoKey = (e) => `${e.type}|${e.target ?? ''}`;
const deathSig = (c) => Object.entries(c.knownDeaths ?? {}).map(([id, k]) => `${id}:${k?.certainty ?? ''}`).sort().join(',');

/** Has any emotion jumped since the last decision's snapshot? → { type, target, from, to } | null */
export function emotionJump(world, c) {
  const snap = c.tierSnap?.emotions ?? null;
  for (const e of world.emotions?.of(c) ?? []) {
    const prev = snap?.[emoKey(e)];
    if (prev == null ? e.intensity >= 5 : e.intensity - prev >= TIER_RULES.emotionJump) {
      return { type: e.type, target: e.target ?? null, from: prev ?? 0, to: Math.round(e.intensity * 10) / 10 };
    }
  }
  return null;
}

function emotionMap(world, c) {
  return Object.fromEntries((world.emotions?.of(c) ?? []).map((e) => [emoKey(e), Math.round(e.intensity * 100) / 100]));
}

/** After a decision's own feeling was applied: the snapshot's emotions follow, so a self-report is no "jump" later. */
export function refreshTierSnapshot(world, c) {
  if (!c.tierSnap) return;
  c.tierSnap.emotions = emotionMap(world, c);
}

/**
 * @param {object} c        citizen
 * @param {object} trigger  { purpose: 'decide', stimuli: [...] }
 * @param {object} world
 * @returns {{ tier, maxTokens, reason, detail, addressed, maxImportance, protect }}
 */
export function chooseTier(c, trigger, world) {
  const stimuli = trigger.stimuli ?? [];
  const now = world.now;
  const snap = c.tierSnap ?? null;
  const seen = new Set(snap?.seen ?? []);
  const fresh = stimuli.filter((s) => !seen.has(s.id));
  const freshReal = fresh.filter((s) => !isRoutineStimulus(s));
  // addressed speech opens an exchange, or continues one (then it weighs like talk nearby)
  const addressedBy = { ...(c.addressedBy ?? {}) };
  const opening = new Set();
  for (const s of freshReal) {
    if (s.kind !== 'speech' || !s.data?.addressed || !s.sourceId) continue;
    const last = addressedBy[s.sourceId] ?? -Infinity;
    if ((s.gameTime ?? now) - last > OPENING_GAP_MINUTES) opening.add(s.id);
    addressedBy[s.sourceId] = Math.max(last, s.gameTime ?? now);
  }
  for (const [id, at] of Object.entries(addressedBy)) if (now - at > 24 * 60) delete addressedBy[id];
  const weight = (s) => (s.kind === 'speech' && s.data?.addressed && !opening.has(s.id) ? Math.min(s.importance ?? 0, TURN_IMPORTANCE) : s.importance ?? 0);
  const freshMax = freshReal.reduce((m, s) => Math.max(m, weight(s)), 0);
  const maxImportance = stimuli.reduce((m, s) => Math.max(m, s.importance ?? 0), 0);
  const addressed = freshReal.some((s) => opening.has(s.id) && s.data?.interrupt);
  const needLevel = Math.max(0, ...Object.values(c.needs?.levels ?? {}));
  const emotions = world.emotions?.of(c) ?? [];
  const topEmotion = emotions.reduce((m, e) => Math.max(m, e.intensity), 0);
  const fearOrGrief = emotions.some((e) => e.intensity >= 5 && (e.type === 'fear' || (e.type === 'sadness' && e.data?.grief)));
  const bodyHere = Boolean(c.location && world.objects?.inRoom(c.location).some((o) => o.typeId === 'corpse'));
  const grieving = (c.griefFullUntil ?? -Infinity) > now;
  const mortal = Boolean(c.mortal?.state);
  const critical = Boolean(world.body?.criticalHere(c));
  const deathStim = (s) => s.data?.breakNews || s.data?.news || s.data?.death || s.data?.body;
  // the governor never downgrades these, and a full one gets the higher token cap
  const protect = addressed || critical || mortal || bodyHere || grieving || fearOrGrief || stimuli.some(deathStim) || stimuli.some((s) => s.data?.altercation);

  const sig = deathSig(c);
  const waking = stimuli.some((s) => s.data?.wakeUp && s.data?.longSleep);
  const altercation = fresh.some((s) => s.data?.altercation && (['target', 'aggressor'].includes(s.data.role) || s.importance >= 8));
  // a death they didn't know of before, or one that became certain (suspected → certain) since the last decision
  const before = new Set(String(snap?.deaths ?? '').split(',').filter(Boolean));
  const deathNews = (snap != null && sig.split(',').filter(Boolean).some((x) => !before.has(x))) || fresh.some(deathStim);
  const jump = emotionJump(world, c);
  // step 11: the first decision with a newly due scheme step; being asked to join a scheme
  const schemeStep = Boolean(c.schemeStepNew);
  const proposal = fresh.some((s) => s.data?.proposal);

  let tier;
  let reason;
  let detail = null;
  if (waking) { tier = 'full'; reason = 'waking'; }
  else if (altercation) { tier = 'full'; reason = 'altercation'; }
  else if (critical) { tier = 'full'; reason = 'critical'; }
  else if (deathNews) { tier = 'full'; reason = 'death_news'; }
  else if (proposal) { tier = 'full'; reason = 'proposal'; }
  else if (schemeStep) { tier = 'full'; reason = 'scheme_step'; }
  else if (freshMax >= TIER_RULES.fullImportance) { tier = 'full'; reason = 'new_stimulus'; detail = `importance ${freshMax}`; }
  else if (jump) { tier = 'full'; reason = 'emotion_jump'; detail = `${jump.type}${jump.target ? `→${jump.target}` : ''} ${jump.from}→${jump.to}`; }
  else if (stimuli.length > 0 && stimuli.every((s) => MECHANICAL.has(s.kind) && !s.data?.wakeUp && !s.data?.vigilEnd) && topEmotion < 3 && needLevel < 2 && !c.conversationId) {
    tier = 'none'; reason = 'routine';
  } else {
    tier = 'light'; reason = c.conversationId || stimuli.some((s) => s.kind === 'speech') ? 'conversation' : 'ordinary';
  }

  // the per-citizen cap (never for waking, fights, or anything of importance >= 8)
  const recentFull = (c.fullAt ?? []).filter((t) => t > now - 60);
  if (tier === 'full' && !CAP_EXEMPT.has(reason) && freshMax < TIER_RULES.capExemptImportance && recentFull.length >= TIER_RULES.fullPerGameHour) {
    world.logEvent('tier_capped', { actorId: c.id, location: c.location, wanted: reason, detail, fullInLastHour: recentFull.length });
    detail = `${reason}${detail ? ` (${detail})` : ''}`;
    tier = 'light';
    reason = 'tier_capped';
  }

  // emotion experiments (EMOTION_PARAM_EFFECTS=true only): overwhelming anger or fear makes for a hastier decision
  const fx = world.emotions ? tierEffect(world, c, stimuli) : { raise: false, lower: false };
  let params;
  if (fx.lower && !protect && tier !== 'none') {
    tier = tier === 'full' ? 'light' : 'none';
    detail = `${reason}${detail ? ` (${detail})` : ''}: ${fx.reason ?? 'intense emotion'} (param effects)`;
    params = fx.params;
  }

  const adj = world.governor ? world.governor.adjust({ tier, addressed, maxImportance, protect }) : { tier, maxTokens: null };
  // step A6 (step 10: the OPENING line of an exchange): addressed speech must be decided at tier full
  if (addressed && adj.tier !== 'full') {
    world.logEvent('tier_violation', { actorId: c.id, tier: adj.tier, reason: adj.reason ?? reason });
    if (config.debug.tierCheck) console.warn(`[tier] ASSERTION FAILED: ${c.id} addressed speech decided at "${adj.tier}" (wanted full)`);
  }
  if (adj.tier !== tier) { detail = `${reason}${detail ? ` (${detail})` : ''}; governor ${tier}→${adj.tier}`; reason = 'governor'; }
  // protected full decisions get the higher cap so a long deliberation fits the first time (9.5 run: 5.8% cut off)
  const maxTokens = adj.maxTokens ?? (adj.tier === 'full' && protect ? PROTECTED_MAX_TOKENS : null);

  // the snapshot this decision leaves for the next one
  c.tierSnap = { at: now, emotions: emotionMap(world, c), seen: [...seen, ...stimuli.map((s) => s.id)].slice(-SEEN_KEEP), deaths: sig };
  c.addressedBy = addressedBy;
  c.fullAt = adj.tier === 'full' ? [...recentFull, now] : recentFull;

  return { tier: adj.tier, maxTokens, reason, detail, addressed, maxImportance, protect, ...(params ? { params } : {}) };
}
