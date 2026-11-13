// One "think": snapshot the situation → choose a tier → ask the model → hand its choice to World.
// All state changes go through world.* methods; this module only orchestrates.
//
// mode 'decide' — the usual decision (purpose 'decide', tier from tiers.js)
// mode 'plan'   — plan the day (purpose 'plan', tier full, only the make_plan tool)
import { config } from '../config.js';
import { buildMessages } from './prompt.js';
import { buildTools, validateCall } from './tools.js';
import { chooseTier } from './tiers.js';
import { makePlanTool } from './plan.js';
import { ranOut, RETRY_MAX, CAP_ABOVE, TIER_MAX_TOKENS } from '../llm.js';
import { findLeaks } from '../social/leak.js';

const LEAK_CHECK = process.env.DEBUG_LEAK_CHECK === 'true';

// A `say` decided while 3+ new lines were spoken in the same conversation answers a stale
// question: think again once with the fresh transcript (cheaper than interrupting).
export const STALE_LINES = 3;

export async function think(world, c, { mode = 'decide' } = {}) {
  let t;
  try {
    t = world.beginThink(c, { mode });
  } catch (err) {
    console.error(`[think] could not start for ${c.id}:`, err);
    return;
  }
  const purpose = mode === 'plan' ? 'plan' : 'decide';
  const tierInfo = chooseTier(c, { purpose, stimuli: c.thinkingInbox }, world);
  t.tier = tierInfo.tier;
  // EMOTION_PARAM_EFFECTS (off by default): a slightly higher temperature under overwhelming anger or fear.
  const params = tierInfo.params?.temperatureDelta ? { temperature: Number(process.env.EMOTION_PARAM_BASE_TEMPERATURE ?? 0.7) + tierInfo.params.temperatureDelta } : undefined;
  const call = (messages, tools, tier, maxTokens) => world.llm.chat({
    purpose, citizenId: c.id, messages, tools, signal: t.controller.signal, tier, maxTokens, ...(params ? { params } : {}),
  });

  try {
    let outcome;
    for (;;) {
      outcome = await decide(world, c, t, call, { mode, tier: tierInfo.tier, maxTokens: tierInfo.maxTokens });
      if (!outcome) return world.abandonThink(c, t); // stale / aborted

      const linesSince = world.conversationLinesSince(c, t);
      if (mode === 'decide' && outcome.call?.name === 'say' && linesSince >= STALE_LINES && !t.rethought
          && (world.governor?.staleRethinksAllowed() ?? true)) {
        world.rethinkStale(c, t, linesSince); // logs `rethink_stale`, folds new stimuli into this think
        continue;
      }
      break;
    }
    outcome.tier = tierInfo.tier;
    outcome.tierReason = tierInfo.reason;
    if (mode === 'plan') world.completePlanThink(c, t, outcome);
    else world.completeThink(c, t, outcome);
  } catch (err) {
    if (!world.isCurrentThink(c, t) || t.controller.signal.aborted) world.abandonThink(c, t);
    else world.failThink(c, t, err);
  }
}

// Build → call → validate (with corrective retries). Returns null if the think went stale.
async function decide(world, c, t, call, { mode, tier, maxTokens, noCutoffRetry = false }) {
  const collect = { recalled: [] };
  const messages = buildMessages(world, c, { tier, mode, collect });
  const tools = mode === 'plan' ? [makePlanTool(world, c)] : buildTools(world, c);
  if (LEAK_CHECK) {
    const leaks = findLeaks(world, `${messages.map((m) => m.content).join('\n')}\n${JSON.stringify(tools)}`, c.id);
    if (leaks.length) world.logEvent('error', { actorId: c.id, location: c.location, message: `PROMPT LEAK: ${leaks.map((l) => `${l.kind} "${l.text}"`).join('; ')}`, leak: true });
  }

  const first = await call(messages, tools, tier, maxTokens);
  if (!world.isCurrentThink(c, t)) return null;
  let outcome = interpret(first, tools);

  // step A6: cut-off recovery ladder. A decide call that ran out without a usable tool call is retried
  // ONCE at the next higher cap (none → light, light → full, full → 1.5× what the first call used), with
  // thinking as that tier implies — the model ran out of words, so it needs more of them, not fewer.
  // Plan mode keeps the old cheap thinking-off retry. Never more than one cut-off retry per think.
  if (ranOut(first)) {
    if (mode === 'decide' && !noCutoffRetry) {
      const toTier = CAP_ABOVE[tier] ?? 'full';
      // full → 1.5× what the first call was actually given; none/light → the next tier's cap
      const retryTokens = tier === 'full'
        ? Math.round(1.5 * (maxTokens ?? TIER_MAX_TOKENS[tier] ?? 3000))
        : config.llm.maxTokens[toTier];
      world.logEvent('retry_cutoff', { actorId: c.id, location: c.location, fromTier: tier, toTier, maxTokens: retryTokens });
      outcome = await decide(world, c, t, call, { mode, tier: toTier, maxTokens: retryTokens, noCutoffRetry: true });
      if (!outcome) return null; // stale / aborted inside the retry
      outcome.reasoning = [first.reasoning, outcome.reasoning].filter(Boolean).join('\n\n--- ran out of words; acting on instinct ---\n\n') || null;
      return outcome; // the retry already ran its own correction / cheap fallback
    }
    // plan mode, or the cut-off retry itself ran out again: one cheap thinking-off attempt, as before
    const quick = buildMessages(world, c, { tier: 'none', mode, collect: null });
    const second = await call(quick, tools, 'none', RETRY_MAX[mode === 'plan' ? 'plan' : 'decide']);
    if (!world.isCurrentThink(c, t)) return null;
    outcome = interpret(second, tools);
    outcome.reasoning = [first.reasoning, second.reasoning].filter(Boolean).join('\n\n--- ran out of words; acting on instinct ---\n\n') || null;
  }

  if (outcome.invalid) {
    // One retry, telling the model what was wrong.
    const second = await call([...messages, ...correction(first, outcome)], tools, tier, maxTokens);
    if (!world.isCurrentThink(c, t)) return null;
    const again = interpret(second, tools);
    again.reasoning = joinReasoning(outcome.reasoning, second.reasoning);
    outcome = again.invalid ? { ...again, fallback: true } : again;
  }
  outcome.recalled = collect.recalled;
  return outcome;
}

// LLM result → { call } | { text } | { invalid, error, rawCall }, plus reasoning + inner thought.
function interpret(res, tools) {
  const reasoning = res.reasoning ?? null;
  const tc = res.toolCalls?.[0];
  if (!tc) {
    return { reasoning, text: (res.content ?? '').trim(), innerThought: null };
  }
  const innerThought = typeof tc.arguments?.inner_thought === 'string' ? tc.arguments.inner_thought.trim() : null;
  const v = validateCall(tools, tc);
  if (!v.ok) return { reasoning, invalid: true, error: v.error, rawCall: tc, innerThought };
  return { reasoning, call: v.call, innerThought, extraCalls: res.toolCalls.length - 1 };
}

function correction(res, outcome) {
  const id = outcome.rawCall.id || 'call_1';
  return [
    {
      role: 'assistant',
      content: res.content ?? '',
      tool_calls: [{
        id, type: 'function',
        function: { name: String(outcome.rawCall.name ?? ''), arguments: JSON.stringify(outcome.rawCall.arguments ?? {}) },
      }],
    },
    { role: 'tool', tool_call_id: id, content: `That did not work: ${outcome.error} Try again with exactly one valid tool call.` },
  ];
}

function joinReasoning(a, b) {
  return [a, b].filter(Boolean).join('\n\n--- after correction ---\n\n') || null;
}
