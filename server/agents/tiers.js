// Tiered thinking: how hard a citizen thinks about a decision, decided in code BEFORE the call (step 9.5, A5).
//
//   none  (thinking off, 300 tokens)   ONLY mechanical moments: an activity timer ended, nothing else happened since the
//                                      last decision, no emotion >= 3, no body in the room, a calm body
//   light (1,000 tokens)               everything not listed elsewhere (the default)
//   full  (3,000 tokens)               addressed speech; stimuli >= 7; director events; the waking decision (A4); any
//                                      emotion >= 5; a body in the room; within 12 game hours of learning of the death of
//                                      someone close; their own dangerous or critical body; breaking or receiving news;
//                                      a conversation with someone they have a warning sign about; a need at level >= 3
//
// Caps: LLM_MAX_TOKENS_FULL / _LIGHT / _NONE (server/llm.js TIER_MAX_TOKENS). A cut-off decide call climbs one tier.
// `protect` marks decisions about death, grief, fear, critical bodies and addressed speech: the governor never
// downgrades those (A6). Emotions never lower a tier unless EMOTION_PARAM_EFFECTS=true (experiments only).
import { config } from '../config.js';
import { tierEffect } from '../emotions/present.js';

const MECHANICAL = new Set(['timer']);

/**
 * @param {object} c        citizen
 * @param {object} trigger  { purpose: 'decide', stimuli: [...] }
 * @param {object} world
 * @returns {{ tier, maxTokens, reason, addressed, maxImportance, protect }}
 */
export function chooseTier(c, trigger, world) {
  const stimuli = trigger.stimuli ?? [];
  const now = world.now;
  const maxImportance = stimuli.reduce((m, s) => Math.max(m, s.importance ?? 0), 0);
  const addressed = stimuli.some((s) => s.kind === 'speech' && s.data?.addressed && s.data?.interrupt);
  const needLevel = Math.max(0, ...Object.values(c.needs?.levels ?? {}));
  const emotions = world.emotions?.of(c) ?? [];
  const topEmotion = emotions.reduce((m, e) => Math.max(m, e.intensity), 0);
  const fearOrGrief = emotions.some((e) => e.intensity >= 5 && (e.type === 'fear' || (e.type === 'sadness' && e.data?.grief)));
  const bodyHere = Boolean(c.location && world.objects?.inRoom(c.location).some((o) => o.typeId === 'corpse'));
  const grieving = (c.griefFullUntil ?? -Infinity) > now;
  const mortal = Boolean(c.mortal?.state);
  const news = stimuli.some((s) => s.data?.breakNews || s.data?.news || s.data?.death || s.data?.body) || (c.fullNextUntil ?? -Infinity) > now;
  const waking = stimuli.some((s) => s.data?.wakeUp && s.data?.longSleep);
  const critical = Boolean(world.body?.criticalHere(c));
  const protect = addressed || critical || mortal || bodyHere || grieving || fearOrGrief || news;

  const decide = (tier, reason) => {
    const adj = world.governor ? world.governor.adjust({ tier, addressed, maxImportance, protect }) : { tier, maxTokens: null };
    // step A6: addressed speech is a hard rule — it must be decided at tier full.
    if (addressed && adj.tier !== 'full') {
      world.logEvent('tier_violation', { actorId: c.id, tier: adj.tier, reason: adj.reason ?? reason });
      if (config.debug.tierCheck) console.warn(`[tier] ASSERTION FAILED: ${c.id} addressed speech decided at "${adj.tier}" (wanted full)`);
    }
    return { tier: adj.tier, maxTokens: adj.maxTokens, reason: adj.tier === tier ? reason : `${reason} (governor: ${tier}→${adj.tier})`, addressed, maxImportance, protect };
  };

  const fx = world.emotions ? tierEffect(world, c, stimuli) : { raise: false, lower: false };
  if (fx.lower && !protect) {
    // experiment switch: overwhelming anger or fear makes for a hastier decision
    const base = addressed || maxImportance >= 8 ? 'full' : 'light';
    return { ...decide(base === 'full' ? 'light' : 'none', `${fx.reason ?? 'intense emotion'} (param effects)`), params: fx.params };
  }
  if (critical) return decide('full', 'critical bleeding here');
  if (addressed) return decide('full', 'addressed');
  if (mortal) return decide('full', `own body ${c.mortal.state}`);
  if (bodyHere) return decide('full', 'a body in the room');
  if (news) return decide('full', 'news of a death or of someone hurt');
  if (grieving) return decide('full', 'grieving someone close');
  if (maxImportance >= 7) return decide('full', `importance ${maxImportance}`);
  if (stimuli.some((s) => s.kind === 'director')) return decide('full', 'director event');
  if (waking) return decide('full', 'the waking decision');
  if (topEmotion >= 5) return decide('full', 'a strong feeling');
  if (needLevel >= 3) return decide('full', `need at level ${needLevel}`);
  if (fx.raise) return decide('full', fx.reason);
  if (signalConversation(world, c)) return decide('full', 'talking with someone they have a warning sign about');

  // none: only a timer that ended, nothing else since, calm inside and out
  const mechanical = stimuli.length > 0 && stimuli.every((s) => MECHANICAL.has(s.kind) && !s.data?.wakeUp) && topEmotion < 3 && needLevel < 2 && !c.conversationId;
  if (mechanical) return decide('none', 'an activity ended');
  return decide('light', stimuli.some((s) => s.kind === 'speech') ? 'conversation turn' : 'ordinary moment');
}

// a step-5.5 warning sign about someone in their conversation
function signalConversation(world, c) {
  if (!c.conversationId) return false;
  const conv = world.conversations?.get(c.conversationId);
  if (!conv) return false;
  const notes = c.signalNotes ?? {};
  const q = world.db.prepare("SELECT 1 FROM relationship_events WHERE citizen_id = ? AND other_id = ? AND source = 'signal' LIMIT 1");
  return conv.participants.some((id) => id !== c.id && (Object.keys(notes).some((k) => k.endsWith(`|${id}`)) || Boolean(q.get(c.id, id))));
}
