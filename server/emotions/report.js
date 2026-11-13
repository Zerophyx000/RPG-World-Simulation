// Self-report (step 6, §2.3; structured since step 7A): the model says how a moment changed how the citizen feels.
//
// Every decision tool carries an optional `feeling` object — { emotion, target, direction, amount, why } —
// described once per tool by feelingParam(world, c). Reflections (`feelings`) and consolidation (`lingering`)
// use the same fields. The legacy forms ({ emotion, target, change, why } and the string
// "<emotion> <+N or -N> [at <person>]: <why>") still parse for old logs and old tests.
// Everything is clamped to ±3 per report; targets must be people the citizen knows. `why` becomes the cause.
// Words for feelings live in content/emotion-synonyms.json (map + ignore), not in code.
import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_DIR } from '../world/scenarios.js';

// step 7A: synonyms are content, read once. A rule is an emotion name or { emotion, scale?, trust? }.
let SYNONYMS = null;
function synonyms() {
  if (SYNONYMS) return SYNONYMS;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'emotion-synonyms.json'), 'utf8'));
    SYNONYMS = { map: j.map ?? {}, ignore: new Set(j.ignore ?? []) };
  } catch (err) {
    console.warn(`[content] emotion-synonyms.json unreadable: ${err.message}`);
    SYNONYMS = { map: {}, ignore: new Set() };
  }
  return SYNONYMS;
}

export const FEELING_RULE = '- Feelings: any action may carry an optional `feeling` saying how this moment changed how you feel: pick the emotion from the list, who it is about (or none), whether it got stronger or weaker and by how much (1–3), and why in your own words. Leave it out when nothing changed.';

// The optional `feeling` property on every decision tool; the enums hold only what is valid right now.
export function feelingParam(world, c) {
  return {
    type: 'object',
    description: 'Optional. If this moment changes how you feel, say which feeling gets stronger or weaker.',
    properties: {
      emotion: { type: 'string', enum: world.emotions.typeNames() },
      target: { type: 'string', enum: feelingLabels(world, c) },
      direction: { type: 'string', enum: ['stronger', 'weaker'] },
      amount: { type: 'integer', enum: [1, 2, 3] },
      why: { type: 'string', description: 'Short, first person.' },
    },
    required: ['emotion', 'direction', 'amount'],
  };
}

// Who the citizen could mean: the people here plus whoever they already feel something about.
function feelingLabels(world, c) {
  const here = c.location ? world.citizensIn(c.location, { exceptId: c.id }) : [];
  const felt = world.emotions.of(c).map((e) => e.target).filter((id) => id && world.citizens.has(id)).map((id) => world.citizens.get(id));
  const seen = new Set();
  const others = [];
  for (const o of [...here, ...felt]) if (o.id !== c.id && !seen.has(o.id)) { seen.add(o.id); others.push(o); }
  return [...world.memory.labelsFor(c, others).keys(), 'none'];
}

/** → { type, target (citizen id | null), change (-3..3, non-zero), why, trust? } or null. `people`: Map label → citizen. */
export function parseFeeling(world, c, raw, people) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try { return parseFeeling(world, c, JSON.parse(raw), people); } catch { return null; } // meant to be an object, but broken
  }
  const types = world.emotions.typeNames();
  const norm = (w) => {
    const k = String(w ?? '').toLowerCase().replace(/[^a-z]/g, '');
    if (!k) return null;
    if (types.includes(k)) return { type: k, rule: null };   // canonical type names always win
    const rule = synonyms().map[k];
    if (rule == null) return synonyms().ignore.has(k) ? { ignored: true } : null;
    return { type: typeof rule === 'string' ? rule : rule.emotion, rule: typeof rule === 'string' ? null : rule };
  };
  const findPerson = (label) => {
    const l = String(label ?? '').trim().toLowerCase().replace(/^(the|at|towards?|to|of|for)\s+/, '').replace(/[.,;:!]+$/, '');
    if (!l || ['nobody', 'no one', 'none', 'myself', 'me', 'self'].includes(l)) return null;
    for (const [lab, o] of people) if (lab.toLowerCase() === l || lab.toLowerCase() === `the ${l}` || o.name.toLowerCase() === l || o.id === l) return o.id === c.id ? null : o.id;
    for (const [lab, o] of people) if (l.includes(o.name.toLowerCase()) || lab.toLowerCase().includes(l)) return o.id === c.id ? null : o.id;
    return undefined; // named someone they don't know
  };
  let found; let ignored = false; let target = null; let change; let why = ''; let trust;
  if (typeof raw === 'object') {
    found = norm(raw.emotion ?? raw.type);
    why = String(raw.why ?? raw.cause ?? '').trim();
    const dir = String(raw.direction ?? '').trim().toLowerCase() === 'weaker' ? -1 : 1; // missing/invalid → stronger
    change = dir * Math.max(1, Math.min(3, Math.round(Number(raw.amount ?? 1)) || 1));
    if (raw.change != null || raw.delta != null) change = Number(raw.change ?? raw.delta); // legacy structured form
    if (raw.target != null && raw.target !== '') target = findPerson(raw.target);
  } else {
    const text = String(raw).trim();
    const [head, ...rest] = text.split(/:\s+|\s+—\s+|\s+-\s+|\s+because\s+/);
    why = rest.join(': ').trim();
    const m = /^([A-Za-z]+)\s*([+\-−–]\s*\d+(?:\.\d+)?)?\s*(?:(?:at|towards?|to|of|for|about|@)\s+(.+))?$/.exec(head.trim());
    if (!m) {
      // lenient: an emotion word somewhere at the start
      for (const word of head.trim().split(/\s+/)) {
        const n = norm(word);
        if (n?.type) { found = n; break; }
        if (n?.ignored) ignored = true;
      }
      const n = /([+\-−–])\s*(\d+(?:\.\d+)?)/.exec(head);
      change = n ? Number(`${/[+]/.test(n[1]) ? '' : '-'}${n[2]}`) : 1;
      const at = /\b(?:at|towards?|of)\s+(.+)$/.exec(head);
      if (at) target = findPerson(at[1]);
    } else {
      found = norm(m[1]);
      change = m[2] ? Number(m[2].replace(/\s+/g, '').replace(/[−–]/g, '-')) : 1;
      if (m[3]) target = findPerson(m[3]);
    }
  }
  if (found?.ignored) ignored = true;
  if (!found || !types.includes(found.type)) {
    if (ignored) return null; // a body state (tiredness, hunger) is not a feeling: dropped without a fuss
    const word = feelingWord(raw);
    if (word) world.logEvent('emotion_unmapped', { actorId: c.id, location: c.location, word, raw: shortRaw(raw) });
    return null;
  }
  const { type } = found;
  const rule = found.rule;
  if (target === undefined) target = null; // unknown people can't be targets; the feeling itself still counts if it may be unaimed
  if (!Number.isFinite(change) || change === 0) return null;
  // step 7A: a scaled synonym (curiosity → joy at half strength) keeps its sign; less than half a step is nothing.
  if (rule?.scale != null) {
    change *= Number(rule.scale);
    if (Math.abs(change) < 0.5) return null;
  }
  if (rule?.trust != null && target) trust = Number(rule.trust);
  change = Math.max(-3, Math.min(3, change));
  if (world.emotions.types[type].aimed === 'required' && !target) return null;
  return { type, target, change, why: why.slice(0, 200) || null, ...(trust != null ? { trust } : {}) };
}

// The word to name in an emotion_unmapped event: only the emotion word the model reported
// (the object's `emotion` field, or the legacy string's first token) — never the whole report.
function feelingWord(raw) {
  if (typeof raw === 'object') return letters(raw?.emotion ?? raw?.type);
  const head = String(raw).trim().split(/:\s+|\s+—\s+|\s+-\s+|\s+because\s+/)[0].trim();
  return letters(head.split(/\s+/)[0]); // the first token is the regex's m[1] when the string is well-formed
}

function letters(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z]/g, '') || null;
}

function shortRaw(raw) {
  return (typeof raw === 'string' ? raw : JSON.stringify(raw) ?? '').slice(0, 80);
}

/** Apply a parsed report. source: 'self' | 'reflection' | 'consolidation'. */
export function applyFeeling(world, c, f, source = 'self') {
  if (!f) return null;
  // "envy +2 at Jonas" means the envy they already feel about Jonas (and his hammer), not a second entry.
  const about = (world.emotions.of(c).filter((e) => e.type === f.type && (e.target ?? null) === (f.target ?? null)).sort((a, b) => b.intensity - a.intensity)[0])?.about ?? null;
  const r = world.emotions.bump(c, { type: f.type, target: f.target, about, delta: f.change, cause: f.why, source, raw: true, rule: source });
  // step 7A: a trust rule (suspicion, wariness, distrust) also dents trust — always with a reason.
  if (r && f.trust != null && f.target) {
    world.relationships.change(c.id, f.target, { trust: f.trust }, {
      reason: f.why || 'something about them makes me uneasy', source: 'feeling',
    });
  }
  return r;
}

/** JSON-schema item for the structured form (reflection `feelings`, consolidation `lingering`): the same fields as feelingParam. */
export function feelingItemSchema(world, labels) {
  return {
    type: 'object',
    properties: {
      emotion: { type: 'string', enum: world.emotions.typeNames() },
      target: { type: 'string', enum: [...labels, 'none'] },
      direction: { type: 'string', enum: ['stronger', 'weaker'] },
      amount: { type: 'integer', enum: [1, 2, 3] },
      why: { type: 'string', description: 'Short, first person.' },
    },
    required: ['emotion', 'direction', 'amount'],
  };
}
