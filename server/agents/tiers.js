// Tiered thinking: how hard a citizen thinks about a decision, decided in code BEFORE the call.
//
//   full  (thinking on, 2,000 tokens)  addressed speech; importance >= 8; director events; first decision after
//                                      waking; planning; any decision while a need is at level >= 3
//   light (600 tokens)                 conversation turns not addressed to them; arrivals/departures of people
//                                      with |affinity| >= 3; timers that end a plan; plan snags / visits
//   none  (thinking off, 300 tokens)   routine: an activity finished, minor timers, low-importance stimuli
//
// One pure function, so the rules are easy to tune. The governor may lower the result.

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
    return { tier: adj.tier, maxTokens: adj.maxTokens, reason: adj.tier === tier ? reason : `${reason} (governor: ${tier}→${adj.tier})`, addressed, maxImportance };
  };

  if (trigger.purpose === 'plan') return decide('full', 'planning');
  if (addressed) return decide('full', 'addressed');
  if (maxImportance >= 8) return decide('full', `importance ${maxImportance}`);
  if (stimuli.some((s) => s.kind === 'director')) return decide('full', 'director event');
  if (stimuli.some((s) => s.data?.wakeUp)) return decide('full', 'first decision after waking');
  if (needLevel >= 3) return decide('full', `need at level ${needLevel}`);

  if (stimuli.some((s) => s.kind === 'speech' && (s.data?.addressed || s.data?.conversationId))) return decide('light', 'conversation turn');
  const strong = stimuli.some((s) => (s.kind === 'arrive' || s.kind === 'depart') && s.sourceId
    && Math.abs(world.memory?.rel(c.id, s.sourceId)?.affinity ?? 0) >= 3);
  if (strong) return decide('light', 'someone who matters came or went');
  if (stimuli.some((s) => s.data?.planEnd || s.data?.tierHint === 'light')) return decide('light', 'plan');
  if (stimuli.some((s) => s.data?.tierHint === 'full')) return decide('full', 'hint');

  return decide('none', 'routine');
}
