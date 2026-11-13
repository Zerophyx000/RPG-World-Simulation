// Retrieval: which memories a citizen "has in mind" for a decision. Chosen by code.
//
// score = importance × strength × (1 + 0.5·aboutPresent + 0.3·samePlace + recency)
//   aboutPresent  people present this memory is about (max 2)
//   recency       1.0 within 6 game hours, fading to 0 over 3 game days
//
// Embeddings hook: a semantic similarity term can be added here later without changing callers.
import { memFromDb } from './index.js';

const RECENT_FULL = 6 * 60;
const RECENT_ZERO = 3 * 1440;

/**
 * @param {object} world
 * @param {object} c                  citizen
 * @param {object} ctx                { presentIds: [], placeId }
 * @param {number} k                  how many
 * @returns {Array<{ memory, score }>}
 */
export function retrieve(world, c, { presentIds = [], placeId = null } = {}, k = 5) {
  const now = world.now;
  const onMind = new Set((c.onMyMind ?? []).map((m) => m.memoryId).filter(Boolean));
  const present = new Set(presentIds);
  const rows = world.db.prepare(`SELECT * FROM memories WHERE citizen_id = ? AND status = 'active'`).all(c.id).map(memFromDb);
  const moodValence = c.mood?.valence ?? 0;
  const scored = [];
  for (const m of rows) {
    if (onMind.has(m.id)) continue;
    const aboutPresent = Math.min(2, m.about.filter((id) => present.has(id)).length);
    const samePlace = placeId && m.placeId === placeId ? 1 : 0;
    const age = now - m.gameTime;
    const recency = age <= RECENT_FULL ? 1 : Math.max(0, 1 - (age - RECENT_FULL) / (RECENT_ZERO - RECENT_FULL));
    // Step 6, mood-congruent recall: in a clearly low (or high) mood, memories of the same colour come more easily.
    let congruence = 1;
    if (Math.abs(moodValence) >= 1.5 && m.valence) congruence = 1 + 0.15 * (Math.sign(m.valence) === Math.sign(moodValence) ? 1 : -0.5);
    const score = m.importance * m.strength * (1 + 0.5 * aboutPresent + 0.3 * samePlace + recency) * congruence;
    scored.push({ memory: m, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/** Coarse time labels: the model gets "yesterday", never minutes. */
export function timeLabel(now, t) {
  const age = now - t;
  const dayNow = Math.floor(now / 1440);
  const dayThen = Math.floor(t / 1440);
  if (age < 120) return age < 20 ? 'just now' : 'earlier today';
  if (dayNow === dayThen) {
    const h = ((t % 1440) + 1440) % 1440 / 60;
    return h < 12 ? 'this morning' : h < 18 ? 'this afternoon' : 'this evening';
  }
  const days = dayNow - dayThen;
  if (days === 1) return 'yesterday';
  if (days <= 6) return 'a few days ago';
  if (days <= 21) return 'a week or two ago';
  return 'a long time ago';
}

/** One memory as a prompt line, from the citizen's point of view. */
export function memoryLine(world, c, m) {
  const label = timeLabel(world.now, m.gameTime);
  if (m.kind === 'secondhand' && m.source?.toldBy) {
    return `(${label}, ${world.memory.nameFor(c, m.source.toldBy)} told you) ${m.text}`;
  }
  return `(${label}) ${m.text}`;
}
