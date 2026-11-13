// Self-report (step 6, §2.3): the model says how a moment changed how the citizen feels.
//
// Decisions carry an optional compact `feeling` string, explained once in the system prompt:
//     "<emotion> <+N or -N> [at <person>]: <why, first person>"       e.g. "anger +2 at Tomas: he lied to my face again"
// (a string, not an object, so that adding it to every tool costs ~10 tokens per tool instead of ~80).
// Reflections (`feelings`) and consolidation (`lingering`) use the structured form { emotion, target, change, why }.
// Everything is clamped to ±3 per report; targets must be people the citizen knows. `why` becomes the cause.

const SYNONYMS = {
  angry: 'anger', furious: 'anger', irritated: 'anger', annoyed: 'anger', rage: 'anger', resentment: 'anger',
  afraid: 'fear', scared: 'fear', frightened: 'fear', anxious: 'fear', worry: 'fear', worried: 'fear', unease: 'fear', dread: 'fear', nervous: 'fear',
  sad: 'sadness', grief: 'sadness', sorrow: 'sadness', lonely: 'sadness', longing: 'sadness', disappointment: 'sadness', disappointed: 'sadness',
  happy: 'joy', glad: 'joy', delight: 'joy', relief: 'joy', relieved: 'joy', hope: 'joy', hopeful: 'joy', amusement: 'joy', amused: 'joy', content: 'joy',
  ashamed: 'shame', embarrassed: 'shame', embarrassment: 'shame', humiliated: 'shame', humiliation: 'shame',
  guilty: 'guilt', remorse: 'guilt', regret: 'guilt',
  proud: 'pride',
  grateful: 'gratitude', thankful: 'gratitude',
  envious: 'envy', covet: 'envy',
  jealous: 'jealousy',
  disgusted: 'disgust', contempt: 'disgust', revulsion: 'disgust',
  fond: 'affection', fondness: 'affection', love: 'affection', warmth: 'affection', tenderness: 'affection', trust: 'affection',
};

export const FEELING_RULE = '- Feelings: any action may carry an optional `feeling` saying how this moment changes how you feel, written as `<emotion> <+N or -N> [at <person>]: <why>` with N from 1 to 3 and the why in your own first-person words. Emotions: joy, sadness, fear, anger, disgust, shame, guilt, pride, affection, gratitude, envy, jealousy. Example: `anger +2 at Tomas: he lied to my face again`. Leave it out when nothing changed.';

export const FEELING_PARAM = { type: 'string', description: 'Optional: how this moment changes how you feel (see "Feelings").' };

/** → { type, target (citizen id | null), change (-3..3, non-zero), why } or null. `people`: Map label → citizen. */
export function parseFeeling(world, c, raw, people) {
  if (raw == null || raw === '') return null;
  const types = world.emotions.typeNames();
  const norm = (w) => {
    const k = String(w ?? '').toLowerCase().replace(/[^a-z]/g, '');
    return types.includes(k) ? k : SYNONYMS[k] ?? null;
  };
  const findPerson = (label) => {
    const l = String(label ?? '').trim().toLowerCase().replace(/^(the|at|towards?|to|of|for)\s+/, '').replace(/[.,;:!]+$/, '');
    if (!l || ['nobody', 'no one', 'none', 'myself', 'me', 'self'].includes(l)) return null;
    for (const [lab, o] of people) if (lab.toLowerCase() === l || lab.toLowerCase() === `the ${l}` || o.name.toLowerCase() === l || o.id === l) return o.id === c.id ? null : o.id;
    for (const [lab, o] of people) if (l.includes(o.name.toLowerCase()) || lab.toLowerCase().includes(l)) return o.id === c.id ? null : o.id;
    return undefined; // named someone they don't know
  };
  let type; let target = null; let change; let why = '';
  if (typeof raw === 'object') {
    type = norm(raw.emotion ?? raw.type);
    change = Number(raw.change ?? raw.delta);
    why = String(raw.why ?? raw.cause ?? '').trim();
    if (raw.target != null && raw.target !== '') target = findPerson(raw.target);
  } else {
    const text = String(raw).trim();
    const [head, ...rest] = text.split(/:\s+|\s+—\s+|\s+-\s+|\s+because\s+/);
    why = rest.join(': ').trim();
    const m = /^([A-Za-z]+)\s*([+\-−–]\s*\d+(?:\.\d+)?)?\s*(?:(?:at|towards?|to|of|for|about|@)\s+(.+))?$/.exec(head.trim());
    if (!m) {
      // lenient: an emotion word somewhere at the start
      const w = head.trim().split(/\s+/).map(norm).find(Boolean);
      if (!w) return null;
      type = w;
      const n = /([+\-−–])\s*(\d+(?:\.\d+)?)/.exec(head);
      change = n ? Number(`${/[+]/.test(n[1]) ? '' : '-'}${n[2]}`) : 1;
      const at = /\b(?:at|towards?|of)\s+(.+)$/.exec(head);
      if (at) target = findPerson(at[1]);
    } else {
      type = norm(m[1]);
      change = m[2] ? Number(m[2].replace(/\s+/g, '').replace(/[−–]/g, '-')) : 1;
      if (m[3]) target = findPerson(m[3]);
    }
  }
  if (!type) return null;
  if (target === undefined) target = null; // unknown people can't be targets; the feeling itself still counts if it may be unaimed
  if (!Number.isFinite(change) || change === 0) return null;
  change = Math.max(-3, Math.min(3, change));
  if (world.emotions.types[type].aimed === 'required' && !target) return null;
  return { type, target, change, why: why.slice(0, 200) || null };
}

/** Apply a parsed report. source: 'self' | 'reflection' | 'consolidation'. */
export function applyFeeling(world, c, f, source = 'self') {
  if (!f) return null;
  return world.emotions.bump(c, { type: f.type, target: f.target, delta: f.change, cause: f.why, source, raw: true, rule: source });
}

/** JSON-schema item for the structured form (reflection `feelings`, consolidation `lingering`). */
export function feelingItemSchema(world, labels) {
  return {
    type: 'object',
    properties: {
      emotion: { type: 'string', enum: world.emotions.typeNames() },
      target: { type: 'string', enum: labels.length ? labels : ['nobody'], description: 'Who it is about, if anyone.' },
      change: { type: 'integer', minimum: -3, maximum: 3, description: 'How much stronger (+) or weaker (−) it became.' },
      why: { type: 'string', description: 'Short, first person.' },
    },
    required: ['emotion', 'change'],
  };
}
