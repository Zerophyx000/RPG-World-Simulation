// The room keeper: a narrow LLM on a short leash (step 5).
//
// It is the only LLM allowed to PROPOSE object state changes, and it only proposes: code checks every
// proposal against the object type (states, transitions, anchors) and applies it through
// world.objects.change(), or rejects it. It never creates objects and only refers to ids it was given.
// Isolated like the observer: it sees actions, objects and the room, never anyone's mind or memories.
//
//   purpose 'keeper', route local → school, tier none, structured output (json_schema)
//
// Fallback (no LLM on the route, the governor in red, or any error): keyword rules per type for `use`,
// no change for a targeted `do`, and the first sensible anchor / behind / hidden / 4 for concealment.
import { BROKEN_STATES, RELATIONS } from '../world/objects.js';

const SURFACE_MAX = 120;
const PERCEIVED_MAX = 160;
const KEEPER_MAX_TOKENS = 400;
const CONCEAL_RELATIONS = ['in', 'behind', 'under', 'on', 'beside'];

const SYSTEM = `You are the room keeper of a village simulation. You decide what PHYSICALLY happens to one object when a person handles it. Be literal, physical and brief.
- Never invent new objects, people or events. Refer only to the objects you are given.
- Never describe anyone's thoughts or feelings.
- An object can only end up in one of its listed states, and only via the allowed changes.
- Reply with JSON only.`;

// ---------- use(object, intent) and targeted do ----------
/**
 * @returns {Promise<{accept, newState, surfaceText, perceivedText, rejectText, source: 'keeper'|'fallback', invalid?}>}
 */
export async function keeperUse(world, { obj, actor, intent, doAction = null, minutes = null }) {
  const O = world.objects;
  const type = O.type(obj);
  const fallback = () => ({ ...(doAction ? { accept: false, newState: null } : fallbackUse(world, obj, intent)), source: 'fallback' });
  if (!keeperUp(world)) return fallback();

  const allowed = type.transitions[obj.state] ?? [];
  const room = world.rooms.get(actor.location);
  const user = [
    `Object: ${O.surfaceText(obj)} (a ${type.name}${type.portable ? ', portable' : ''}${type.container ? ', a container' : ''}).`,
    obj.trueText ? `What it really is: ${obj.trueText}` : null,
    `Current state: "${obj.state}". All states: ${type.states.map((s) => `"${s}"`).join(', ')}.`,
    `Allowed changes from "${obj.state}": ${allowed.length ? allowed.map((s) => `"${s}"`).join(', ') : 'none (its state cannot change)'}.`,
    type.affordances.length ? `Things people usually do with it: ${type.affordances.join(', ')}.` : null,
    obj.holderId ? `${actor.name} is holding it.` : `Where: ${O.placementPhrase(obj) || 'in the room'}, in ${room?.name ?? 'a room'}. ${room?.description ?? ''}`,
    doAction
      ? `${actor.name} spends about ${minutes} minutes ${doAction}, working on this object.`
      : `${actor.name} tries to: "${intent}".`,
    '',
    doAction
      ? 'Does this work change the object\'s state? accept = true only if it clearly does and the new state is an allowed change; otherwise accept = false and newState = "none".'
      : 'accept = false if this is physically impossible with this object, or would need a state change that is not allowed; then rejectText says why in one short sentence to the person ("you").',
    'If accepted: newState = the resulting state, or "none" if the state does not change (e.g. warming hands at a fire).',
    'surfaceText: how the object looks now at a glance, a short phrase starting with "a" or "an" (max 15 words), or "" to keep the default.',
    `perceivedText: one sentence, present tense, what an onlooker sees, with {actor} for the person: e.g. "{actor} strikes a flint and the hearth catches."`,
  ].filter((x) => x != null).join('\n');

  const schema = {
    name: 'keeper_use',
    schema: {
      type: 'object',
      properties: {
        accept: { type: 'boolean' },
        newState: { type: 'string', enum: [...type.states, 'none'] },
        surfaceText: { type: 'string' },
        perceivedText: { type: 'string' },
        rejectText: { type: 'string' },
      },
      required: ['accept', 'newState', 'surfaceText', 'perceivedText', 'rejectText'],
      additionalProperties: false,
    },
  };
  let res;
  try {
    res = await world.llm.chat({
      purpose: 'keeper', tier: 'none', maxTokens: KEEPER_MAX_TOKENS, responseSchema: schema, citizenId: actor.id,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    });
  } catch (err) {
    world.logEvent('keeper', { actorId: actor.id, location: actor.location, objectId: obj.id, verdict: 'error', error: String(err.message).slice(0, 200) });
    return fallback();
  }
  const p = res.json ?? {};
  const out = validateUse(world, obj, p, { doAction });
  out.callId = res.callId ?? null;
  if (out.invalid) {
    world.logEvent('keeper', {
      actorId: actor.id, location: actor.location, objectId: obj.id, verdict: 'invalid', reason: out.invalid,
      proposal: { accept: p.accept, newState: p.newState }, callId: res.callId ?? null,
    });
  }
  return out;
}

/** Code checks a keeper proposal for use / do. */
export function validateUse(world, obj, p, { doAction = null } = {}) {
  const type = world.objects.type(obj);
  const perceivedText = clip(p.perceivedText, PERCEIVED_MAX);
  const surfaceText = cleanSurface(p.surfaceText);
  const newState = p.newState && p.newState !== 'none' && p.newState !== obj.state ? String(p.newState) : null;
  if (!p.accept) {
    return { accept: false, newState: null, surfaceText: null, perceivedText, rejectText: clip(p.rejectText, PERCEIVED_MAX) || null, source: 'keeper' };
  }
  if (newState) {
    let invalid = null;
    if (!type.states.includes(newState)) invalid = `"${newState}" is not a state of ${type.name}`;
    else if (!(type.transitions[obj.state] ?? []).includes(newState)) invalid = `${type.name} can't go from "${obj.state}" to "${newState}"`;
    if (invalid) {
      return {
        accept: false, newState: null, surfaceText: null, perceivedText: null, invalid, source: 'keeper',
        rejectText: doAction ? null : `You try, but ${world.objects.short(obj)} won't do that.`,
      };
    }
  }
  return { accept: true, newState, surfaceText: newState ? surfaceText : null, perceivedText, rejectText: null, source: 'keeper' };
}

/** Keyword rules per type: "light" from cold → lit. No match: a polite reject (or a harmless no-change use). */
export function fallbackUse(world, obj, intent) {
  const type = world.objects.type(obj);
  const text = ` ${String(intent ?? '').toLowerCase().replace(/[^a-z' ]+/g, ' ')} `;
  for (const [verb, rule] of Object.entries(type.rules ?? {})) {
    if (!text.includes(` ${verb} `) && !text.includes(` ${verb}s `) && !text.includes(` ${verb}ing `)) continue;
    if (!rule.from.includes(obj.state) || !(type.transitions[obj.state] ?? []).includes(rule.to)) continue;
    return { accept: true, newState: rule.to, surfaceText: null, perceivedText: `{actor} ${verb}s ${world.objects.short(obj)}.`, rejectText: null };
  }
  // A plain affordance without a state change ("warm hands at", "sit on") is fine.
  for (const a of type.affordances) {
    const head = a.toLowerCase().split(' ')[0];
    if (head.length > 2 && text.includes(` ${head} `) && !Object.keys(type.rules ?? {}).includes(head)) {
      return { accept: true, newState: null, surfaceText: null, perceivedText: `{actor} ${a.replace(/^(\w+)/, '$1s')} ${world.objects.short(obj)}.`, rejectText: null };
    }
  }
  const what = String(intent ?? '').trim().replace(/[.!]+$/, '').replace(/\bit\b/i, world.objects.short(obj)) || 'do that';
  return { accept: false, newState: null, surfaceText: null, perceivedText: null, rejectText: `You try to ${what}, but nothing comes of it.` };
}

// ---------- concealment ----------
/**
 * Where and how a carried object gets hidden in the actor's room.
 * @returns {Promise<{relation, of, visibility, searchDifficulty, clue, perceivedText, source, corrected?}>}
 */
export async function keeperConceal(world, { obj, actor, hint = null }) {
  const O = world.objects;
  const room = world.rooms.get(actor.location);
  const anchors = O.inRoom(room.id).filter((a) => a.id !== obj.id && !O.effectivelyHidden(a));
  const fallback = () => ({ ...fallbackConceal(world, obj, anchors, hint), source: 'fallback' });
  if (!anchors.length || !keeperUp(world)) return fallback();

  const list = anchors.map((a) => {
    const t = O.type(a);
    return `- "${a.id}": ${O.surfaceText(a)}${t.container ? ` (container, ${a.state})` : ''}${t.portable ? '' : ' (fixed)'}${O.placementPhrase(a) ? `, ${O.placementPhrase(a)}` : ''}`;
  }).join('\n');
  const user = [
    `${actor.name} wants to hide ${O.surfaceText(obj)} (a ${O.type(obj).name}) somewhere in ${room.name} so that others won't easily find it.`,
    hint ? `They had in mind: ${hint}.` : null,
    `${room.description}`,
    `Objects in the room:\n${list}`,
    '',
    'Pick the hiding place: relation (in / behind / under / on / beside) and the id of the object it is hidden relative to ("of").',
    '"in" only works for containers that are not locked. Use visibility "hidden" if it is out of sight, "noticeable" if a careful look would spot it.',
    'searchDifficulty: 1 (anyone looking finds it) to 8 (very cleverly hidden).',
    'clue: a short phrase (max 8 words) for a subtle visible sign on the hiding place (e.g. "one stone slightly out of line"), or "".',
    `perceivedText: one sentence, present tense, what an onlooker would see, with {actor} for the person.`,
  ].filter((x) => x != null).join('\n');
  const schema = {
    name: 'keeper_conceal',
    schema: {
      type: 'object',
      properties: {
        relation: { type: 'string', enum: CONCEAL_RELATIONS },
        of: { type: 'string', enum: anchors.map((a) => a.id) },
        visibility: { type: 'string', enum: ['noticeable', 'hidden'] },
        searchDifficulty: { type: 'integer' },
        clue: { type: 'string' },
        perceivedText: { type: 'string' },
      },
      required: ['relation', 'of', 'visibility', 'searchDifficulty', 'clue', 'perceivedText'],
      additionalProperties: false,
    },
  };
  let res;
  try {
    res = await world.llm.chat({
      purpose: 'keeper', tier: 'none', maxTokens: KEEPER_MAX_TOKENS, responseSchema: schema, citizenId: actor.id,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    });
  } catch (err) {
    world.logEvent('keeper', { actorId: actor.id, location: actor.location, objectId: obj.id, verdict: 'error', error: String(err.message).slice(0, 200) });
    return fallback();
  }
  const out = validateConceal(world, obj, res.json ?? {}, anchors);
  out.callId = res.callId ?? null;
  if (out.corrected || out.invalid) {
    world.logEvent('keeper', {
      actorId: actor.id, location: actor.location, objectId: obj.id, verdict: out.invalid ? 'invalid' : 'corrected',
      reason: out.invalid ?? out.corrected, proposal: res.json ?? null, callId: res.callId ?? null,
    });
  }
  if (out.invalid) return { ...fallback(), invalid: out.invalid };
  return out;
}

/** Code checks a concealment proposal: valid anchor in the same room, relation that fits it, clamps. */
export function validateConceal(world, obj, p, anchors) {
  const O = world.objects;
  const anchor = anchors.find((a) => a.id === p.of);
  if (!anchor) return { invalid: `"${p.of}" is not an object in this room` };
  let relation = CONCEAL_RELATIONS.includes(p.relation) ? p.relation : 'behind';
  let corrected = null;
  const at = O.type(anchor);
  if (relation === 'in' && (!at.container || anchor.state === 'locked')) {
    corrected = `"in" ${at.name} is not possible; corrected to "behind"`;
    relation = 'behind';
  }
  if (anchor.holderId) return { invalid: 'the anchor is being carried' };
  const visibility = p.visibility === 'noticeable' ? 'noticeable' : 'hidden';
  return {
    relation, of: anchor.id, visibility,
    searchDifficulty: Math.min(8, Math.max(1, Math.round(Number(p.searchDifficulty) || 4))),
    clue: clip(p.clue, 60) || null,
    perceivedText: clip(p.perceivedText, PERCEIVED_MAX),
    source: 'keeper', ...(corrected ? { corrected } : {}),
  };
}

export function fallbackConceal(world, obj, anchors, hint = null) {
  const O = world.objects;
  const fixed = anchors.filter((a) => !O.type(a).portable);
  const hinted = hint?.of && anchors.find((a) => a.id === hint.of);
  const anchor = hinted ?? fixed.find((a) => !O.type(a).container) ?? fixed[0] ?? anchors[0] ?? null;
  if (!anchor) return { relation: 'floor', of: null, visibility: 'noticeable', searchDifficulty: 2, clue: null, perceivedText: '{actor} tucks something away in a corner.' };
  let relation = hinted && RELATIONS.includes(hint.relation) && hint.relation !== 'floor' ? hint.relation : 'behind';
  if (relation === 'in' && (!O.type(anchor).container || anchor.state === 'locked')) relation = 'behind';
  return { relation, of: anchor.id, visibility: 'hidden', searchDifficulty: 4, clue: null, perceivedText: `{actor} pushes ${O.surfaceText(obj)} ${relation} ${O.short(anchor)}.` };
}

// ---------- helpers ----------
function keeperUp(world) {
  if (world.governor?.state === 'red') return false;
  return world.llm.isAvailable('keeper');
}

function clip(s, max) {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : t;
}

function cleanSurface(s) {
  let t = clip(s, SURFACE_MAX).replace(/[.!]+$/, '');
  if (!t) return null;
  if (!/^(a|an|the|some)\b/i.test(t)) t = `${/^[aeiou]/i.test(t) ? 'an' : 'a'} ${t[0].toLowerCase()}${t.slice(1)}`;
  return t;
}

export function isBreaking(state) {
  return BROKEN_STATES.has(state);
}
