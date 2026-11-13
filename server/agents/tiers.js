// Tiered thinking: how hard a citizen thinks about a decision, decided in code BEFORE the call.
//
//   full  (thinking on, 3,000 tokens)  addressed speech; importance >= 8; director events; first decision after
//                                      waking; planning; any decision while a need is at level >= 3
//   light (1,000 tokens)               conversation turns not addressed to them; arrivals/departures of people
//                                      with |affinity| >= 3; timers that end a plan; plan snags / visits
//   none  (thinking off, 300 tokens)   routine: an activity finished, minor timers, low-importance stimuli
//
// Caps are defaults, overridable per tier via LLM_MAX_TOKENS_FULL / LLM_MAX_TOKENS_LIGHT / LLM_MAX_TOKENS_NONE
// (server/llm.js TIER_MAX_TOKENS). A cut-off decide call climbs one tier (server/agents/think.js).
//
// Step 6: an intense emotion (>= 7) relevant to what triggered the think RAISES the tier to full. Emotions never
// lower a tier unless EMOTION_PARAM_EFFECTS=true (experiments only, off by default).
//
// One pure function, so the rules are easy to tune. The governor may lower the result.
import { config } from '../config.js';
import { tierEffect } from '../emotions/present.js';

/**
 * @param {object} c        citizen
 * @param {object} trigger  { purpose: 'decide'|'plan', stimuli: [...] }
 * @param {object} world
 * @returns {{ tier, maxTokens, reason, addressed, maxImportance }}
 */
export function chooseTier(c, trigger, world) {
  const stimuli = trigger.stimuli ?? [];
  const maxImportance = stimuli.reduce((m, s) => Math.max(m, s.importance ?? 0), 0);
  const addressed = stimuli.some((s) => s.kind === 'speech' && s.data?.addressed && s.data?.interrupt);
  const needLevel = Math.max(0, ...Object.values(c.needs?.levels ?? {}));
  const decide = (tier, reason) => {
    const adj = world.governor ? world.governor.adjust({ tier, addressed, maxImportance }) : { tier, maxTokens: null };
    // step A6: addressed speech is a hard rule — it must be decided at tier full, even if the governor
    // wanted to save tokens. Log a violation instead of silently drifting from the design.
    if (addressed && trigger.purpose !== 'plan' && adj.tier !== 'full') {
      world.logEvent('tier_violation', { actorId: c.id, tier: adj.tier, reason: adj.reason ?? reason });
      if (config.debug.tierCheck) console.warn(`[tier] ASSERTION FAILED: ${c.id} addressed speech decided at "${adj.tier}" (wanted full)`);
    }
    return { tier: adj.tier, maxTokens: adj.maxTokens, reason: adj.tier === tier ? reason : `${reason} (governor: ${tier}→${adj.tier})`, addressed, maxImportance };
  };

  const fx = world.emotions ? tierEffect(world, c, stimuli) : { raise: false, lower: false };
  if (fx.lower && trigger.purpose !== 'plan') {
    // experiment switch: overwhelming anger or fear makes for a hastier decision
    const base = addressed || maxImportance >= 8 ? 'full' : 'light';
    return { ...decide(base === 'full' ? 'light' : 'none', `${fx.reason ?? 'intense emotion'} (param effects)`), params: fx.params };
  }
  if (trigger.purpose === 'plan') return decide('full', 'planning');
  if (world.body?.criticalHere(c)) return decide('full', 'critical bleeding here'); // step 7B: the patient and everyone present
  if (addressed) return decide('full', 'addressed');
  if (maxImportance >= 8) return decide('full', `importance ${maxImportance}`);
  if (stimuli.some((s) => s.kind === 'director')) return decide('full', 'director event');
  if (stimuli.some((s) => s.data?.wakeUp)) return decide('full', 'first decision after waking');
  if (needLevel >= 3) return decide('full', `need at level ${needLevel}`);
  if (fx.raise) return decide('full', fx.reason);

  if (stimuli.some((s) => s.kind === 'speech' && (s.data?.addressed || s.data?.conversationId))) return decide('light', 'conversation turn');
  const strong = stimuli.some((s) => (s.kind === 'arrive' || s.kind === 'depart') && s.sourceId
    && Math.abs(world.memory?.rel(c.id, s.sourceId)?.affinity ?? 0) >= 3);
  if (strong) return decide('light', 'someone who matters came or went');
  if (stimuli.some((s) => s.data?.planEnd || s.data?.tierHint === 'light')) return decide('light', 'plan');
  if (stimuli.some((s) => s.data?.tierHint === 'full')) return decide('full', 'hint');

  return decide('none', 'routine');
}
