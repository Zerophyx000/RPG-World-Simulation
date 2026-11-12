// Witnessed events → episodic memories (code only, no LLM).
//
// personal importance = stimulus importance × involvement factor (max over the people involved)
//   about / done to the citizen, or a director event where they are   1.0
//   someone they feel strongly about (|affinity| >= 3)                  0.8
//   someone they like/dislike a bit (|affinity| 1–2) or know well       0.5
//   acquaintances and strangers                                         0.3
// Kept if >= 2. Conversation lines are skipped (the reflection after the conversation covers them),
// as are their own actions and minor arrivals/departures. >= 7 also lands "on my mind".

const MIN_IMPORTANCE = 2;
const ON_MIND_AT = 7;

export function witness(mem, c, s) {
  if (!['director', 'action', 'arrive', 'depart', 'speech', 'body', 'object', 'notice'].includes(s.kind)) return;
  if (s.sourceId && s.sourceId === c.id) return;           // own routine actions
  // Conversation lines: participants get the reflection afterwards. Bystanders remember overhearing it,
  // once per conversation, weighted by how they feel about BOTH people talking.
  let bystander = false;
  if (s.kind === 'speech' && s.data?.conversationId) {
    if (c.conversationId === s.data.conversationId) return;
    const key = `${c.id}|${s.data.conversationId}`;
    if (mem.overheard.has(key)) return;
    bystander = key;
  }
  if (s.kind === 'body' && !s.sourceId) return;              // bodily state: not an event to remember
  if (s.data?.effect === 'knowPlace') return;                 // knowledge arrives through places, not memories

  let factor;
  // Step 5: their own things, or something they noticed / found themselves, is about them.
  if (s.kind === 'director' || s.kind === 'body' || s.data?.addressed || s.data?.personal || s.data?.ownObject) factor = 1.0;
  else if (s.sourceId) factor = Math.max(involvement(mem, c.id, s.sourceId), s.data?.toId ? involvement(mem, c.id, s.data.toId) : 0);
  else factor = 0.3;
  const personal = Math.round(s.importance * factor * 10) / 10;
  if ((s.kind === 'arrive' || s.kind === 'depart') && personal < 3) return;
  if (personal < MIN_IMPORTANCE) return;

  if (bystander) mem.overheard.add(bystander);
  const about = [s.sourceId, s.data?.toId].filter((x) => x && x !== c.id);
  const text = toMemoryText(s.text);
  const id = mem.add(c.id, {
    kind: 'episodic', text, importance: personal, about, placeId: c.location,
    source: { stimulus: s.kind, eventId: s.data?.eventId ?? null },
  });
  if (personal >= ON_MIND_AT) mem.pushOnMind(c, { text, importance: personal, memoryId: id });
}

function involvement(mem, viewerId, otherId) {
  const r = mem.rel(viewerId, otherId);
  if (!r) return 0.3;
  const a = Math.abs(r.affinity);
  if (a >= 3) return 0.8;
  if (a >= 1 || r.familiarity >= 3) return 0.5;
  return 0.3;
}

// ---------- text: first person, past tense ----------
// Our own stimulus templates are third person present ("Tomas walks in from the square.");
// director texts are second person present ("A blast throws you against the wall.").
const PAST = [
  [/\bwalks in\b/g, 'walked in'], [/\bleaves for\b/g, 'left for'], [/\bleaves\b/g, 'left'],
  [/\bsays to\b/g, 'said to'], [/\bsays nothing\b/g, 'said nothing'], [/\bsays\b/g, 'said'],
  [/\bis no longer\b/g, 'was no longer'], [/\bis suddenly\b/g, 'was suddenly'], [/\bis here\b/g, 'was there'],
  [/\bis busy\b/g, 'was busy'], [/\bis (\w+ing)\b/g, 'was $1'], [/\bare (\w+ing)\b/g, 'were $1'],
  [/\bsits down and eats\b/g, 'sat down and ate'], [/\blies down to sleep\b/g, 'lay down to sleep'],
  [/\bcurls up on the ground and goes to sleep\b/g, 'curled up on the ground and went to sleep'],
  [/\bsways and slumps to the ground\b/g, 'swayed and slumped to the ground'], [/\bwakes up\b/g, 'woke up'],
  [/\bcollapses and lies still\b/g, 'collapsed and lay still'], [/\bstops breathing\b/g, 'stopped breathing'],
  [/\bstirs and comes to\b/g, 'stirred and came to'], [/\bkneels beside\b/g, 'knelt beside'], [/\band feeds\b/g, 'and fed'],
  [/\bhas ended\b/g, 'ended'], [/\bwalked away, so your conversation is over\b/g, 'walked away and our conversation was over'],
  [/\bstarts\b/g, 'started'],
  // step 5: objects
  [/\bpicks up\b/g, 'picked up'], [/\bputs\b/g, 'put'], [/\bhands\b/g, 'handed'], [/\bpushes\b/g, 'pushed'],
  [/\btucks\b/g, 'tucked'], [/\bhides\b/g, 'hid'], [/\blooks closely at\b/g, 'looked closely at'],
  [/\bthere are fewer\b/gi, (m) => (m[0] === 'T' ? 'There were fewer' : 'there were fewer')], [/\bis not where it belongs\b/g, 'was not where it belonged'],
  [/\bis gone\b/g, 'was gone'], [/\bare gone\b/g, 'were gone'], [/\bhas changed\b/g, 'had changed'], [/\bhas been moved\b/g, 'had been moved'],
  [/\bSomething's different\b/g, 'Something was different'], [/\bI find\b/g, 'I found'],
];
const SECOND_TO_FIRST = [
  [/\byou were\b/gi, 'I was'], [/\byou (find|last|look|see|notice)\b/gi, 'I $1'],
  [/\byou're\b/gi, (m) => cap(m, "I'm")], [/\byou've\b/gi, (m) => cap(m, "I've")], [/\byourself\b/gi, 'myself'],
  [/\byours\b/gi, 'mine'], [/\byour\b/gi, (m) => cap(m, 'my')], [/\bto you\b/gi, 'to me'],
  [/^you\b/i, 'I'], [/([.!?]\s+)you\b/gi, '$1I'], [/\byou\b/gi, 'me'],
];

export function toMemoryText(text) {
  // Only narration is rewritten; anything inside quotes is what someone said and stays word for word.
  return String(text ?? '').trim().split(/("[^"]*"|“[^”]*”)/).map((part, i) => {
    if (i % 2 === 1) return part;
    let t = part;
    if (/\byou\b|\byours?\b/i.test(t)) for (const [re, rep] of SECOND_TO_FIRST) t = t.replace(re, rep);
    for (const [re, rep] of PAST) t = t.replace(re, rep);
    return t;
  }).join('');
}

function cap(match, word) {
  return match[0] === match[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word;
}
