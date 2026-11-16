// Step 11.5 (A1): a rough keyword hint for whether a planning answer speaks in the character's voice or in the
// assistant's. It is only a hint for a human reader (the reports mark it, a person decides); it never feeds back
// into the world. Shared by scripts/export-run.js and scripts/scheme-eval.js.

/** Generic prosocial phrasing an assistant-tuned model drifts into. */
export const ASSISTANT_PATTERNS = [
  /\bhealth(y|ier|iest)\b/i, /\bconstructive(ly)?\b/i, /\breconcil(e|iation)\b/i, /\bcommunicat(e|ion) (openly|honestly)\b/i,
  /\brather than (escalat|retaliat|seek(ing)? revenge)/i, /\bbest for everyone\b/i, /\bde-?escalat/i, /\bpeaceful(ly)? resol/i,
  /\bmove (on|forward) (positively|together)\b/i, /\bharm(ful)? to (others|everyone)\b/i, /\bnot worth the (conflict|harm)\b/i,
  /\bmature\b/i, /\bresolve (this|it|things) (calmly|peacefully|through)/i, /\bopen (and honest )?(dialogue|conversation)\b/i,
  /\bboundar(y|ies)\b/i, /\bself-care\b/i, /\bforgiveness is\b/i, /\bviolence (is|never) (never|not) the answer\b/i,
  /\bcycle of (revenge|violence|retaliation)\b/i, /\bpositive (relationship|outcome)\b/i, /\bwell-?being\b/i,
];

/** A few signs of a reason rooted in the person: a name, a body, a fear, family, money, a place. */
const IN_CHARACTER_HINTS = [
  /\b(my|his|her) (mother|father|wife|husband|son|daughter|brother|sister|lad|girl|boy)\b/i, /\btwice my size\b/i,
  /\b(shilling|coin|penn(y|ies)|debt|owe)\b/i, /\b(forge|bakery|tavern|smithy|well|cup)\b/i, /\b(fist|nose|jaw|blood|beat|knife|hammer)\b/i,
  /\b(afraid|scared|coward|shame|pride|proud|laugh(ed)? at me)\b/i, /\bI'd only\b/i, /\bnot yet\b/i,
];

/**
 * @returns {{ mark: 'assistant voice' | 'in character' | 'unclear', hits: string[] }}
 */
export function markVoice(text) {
  const t = String(text ?? '');
  if (!t.trim()) return { mark: 'unclear', hits: [] };
  const hits = ASSISTANT_PATTERNS.filter((re) => re.test(t)).map((re) => t.match(re)[0]);
  if (hits.length) return { mark: 'assistant voice', hits };
  const ic = IN_CHARACTER_HINTS.filter((re) => re.test(t)).map((re) => t.match(re)[0]);
  return { mark: ic.length ? 'in character' : 'unclear', hits: ic };
}

/** Counts of marks over a list of texts: { 'in character': n, 'assistant voice': n, unclear: n } */
export function voiceSplit(texts) {
  const out = { 'in character': 0, 'assistant voice': 0, unclear: 0 };
  for (const t of texts) out[markVoice(t).mark]++;
  return out;
}
