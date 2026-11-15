// Step 11.5 (A4): grievances in plain words. What someone did to a citizen, as it happened, for the planning calls
// (scheme, consolidation's ambition changes, reflection) — never softened into "you had a conflict with Tomas":
//   - the strongest relationship events toward them (by how much they cost, weighted by how fresh), with their reasons
//   - WHAT WAS DONE TO YOU: rough acts (where, with what, what it did, what was said, who saw), wounds still felt,
//     lies of theirs this citizen caught, false accusations and framing aimed at them
//   - the heaviest memories about them
//   - the strongest feelings toward them now, in words
// Read-only. Everything here is the citizen's own knowledge: their relationship rows, their memories, their body,
// acts done to them (they were there), lies they caught. Nothing about what others think.
import { ref } from '../memory/index.js';

const ROUGH = new Set(['shove', 'grab', 'slap', 'punch', 'kick', 'strike', 'throw_at', 'snatch', 'pin_down', 'choke', 'tie_up', 'drag']);
const HOSTILE_EMOTIONS = ['anger', 'hatred', 'contempt', 'fear', 'envy', 'jealousy', 'disgust'];
const BAND = ['a little', 'strongly', 'intensely', 'overwhelmingly'];
const DAYS = 7;
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

/** Everything this citizen holds against `otherId`: { score, sections: { events, done, memories, feelings } } (lines may hold {{c:id}}). */
export function grievanceAgainst(world, c, otherId) {
  const w = world;
  const o = w.citizens.get(otherId);
  if (!o || o.id === c.id) return { score: 0, sections: { events: [], done: [], memories: [], feelings: [] } };
  const since = w.now - DAYS * 1440;
  // relationship events that cost something, worst first (a week back, fresher weighs more)
  const rel = w.db.prepare(`SELECT reason, d_affinity a, d_trust t, strength s, game_time g FROM relationship_events
    WHERE citizen_id = ? AND other_id = ? AND (d_affinity < 0 OR d_trust < 0) AND game_time > ?`).all(c.id, otherId, since)
    .map((r) => ({ reason: r.reason, sev: -(Math.min(0, r.a) + Math.min(0, r.t)) * (0.5 + 0.5 * (r.s ?? 1)) }))
    .sort((x, y) => y.sev - x.sev);
  const seen = new Set();
  const events = rel.filter((r) => { const k = r.reason.trim().toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5);
  // what was done to them: rough acts by `o` on `c`
  const done = [];
  const acts = w.db.prepare(`SELECT id, game_time g, location, data FROM events WHERE type = 'physical' AND actor_id = ? AND game_time > ? AND json_extract(data, '$.targetId') = ? ORDER BY id`).all(otherId, since, c.id)
    .map((r) => ({ ...r, d: J(r.data, {}) })).filter((r) => ROUGH.has(r.d.act));
  const crimes = w.db.prepare(`SELECT data FROM events WHERE type = 'crime' AND actor_id = ? AND game_time > ? AND json_extract(data, '$.victimId') = ?`).all(otherId, since, c.id).map((r) => J(r.data, {}));
  const witnesses = new Set(crimes.filter((x) => !x.voided).flatMap((x) => x.witnesses ?? []).filter((id) => id !== c.id && id !== otherId));
  let severity = 0;
  for (const a of acts.slice(-4)) {
    const room = w.rooms.get(a.location)?.name;
    const what = `${ref(o)} ${a.d.act === 'throw_at' ? 'threw something at' : `${a.d.act.replace('_', ' ')}${/e$/.test(a.d.act) ? 'd' : 'ed'}`} you${a.d.part ? ` (${String(a.d.part).replace(/_/g, ' ')})` : ''}${a.d.with ? ` with ${a.d.with}` : ''}${room ? ` at ${room}` : ''}`;
    const eff = (a.d.effects ?? []).filter((e) => !['welcome', 'unwelcome'].includes(e));
    done.push(`${what}${a.d.hit === false ? ', and missed' : eff.length ? ` — ${eff.join(', ')}` : ''}.${a.d.words ? ` ${o.persona?.sex === 'female' ? 'She' : 'He'} said: "${a.d.words}"` : ''}`);
    severity += 2 + eff.length;
  }
  if (witnesses.size) done.push(`${[...witnesses].map((id) => `{{c:${id}}}`).join(' and ')} saw it.`);
  for (const cond of w.body?.active(c.id) ?? []) {
    if (cond.sourceId !== otherId) continue;
    done.push(`You still feel it: ${w.body.woundText(cond)}.`);
    severity += 2;
  }
  for (const l of w.scheming?.lies.caughtBy?.(c, otherId) ?? []) { done.push(`${ref(o)} lied to you: "${l.said}" — and you know it wasn't true.`); severity += 2; }
  for (const l of w.scheming?.lies.aimedAt?.(c, otherId) ?? []) { done.push(`${ref(o)} ${l.kind === 'frame' ? 'made it look as if you had done something you hadn\'t' : 'blamed you falsely'}${l.heardBy.length ? ` in front of ${l.heardBy.map((h) => `{{c:${h.citizen_id}}}`).join(', ')}` : ''}.`); severity += 3; }
  // heavy memories about them
  const memories = w.db.prepare(`SELECT text, importance FROM memories WHERE citizen_id = ? AND status = 'active' AND importance >= 6 AND game_time > ? AND EXISTS (SELECT 1 FROM json_each(about) WHERE value = ?) ORDER BY importance DESC, id DESC LIMIT 3`).all(c.id, since, otherId).map((m) => m.text);
  // feelings toward them now
  const feelings = (w.emotions?.of(c) ?? []).filter((e) => e.target === otherId && HOSTILE_EMOTIONS.includes(e.type) && e.intensity >= 2)
    .sort((a, b) => b.intensity - a.intensity).slice(0, 3)
    .map((e) => `${e.type} ${BAND[w.emotions.band(e.intensity)] ?? ''}`.trim());
  const feelScore = (w.emotions?.of(c) ?? []).filter((e) => e.target === otherId && HOSTILE_EMOTIONS.includes(e.type)).reduce((s, e) => s + e.intensity, 0);
  const score = events.reduce((s, r) => s + r.sev, 0) + severity + feelScore * 0.5 + memories.length;
  return { score, sections: { events: events.map((r) => r.reason), done, memories, feelings } };
}

/** The grievance as a prompt block (names resolved for this citizen), or '' when there is none. */
export function grievanceBlock(world, c, otherId, { heading = '# WHAT WAS DONE TO YOU' } = {}) {
  const g = grievanceAgainst(world, c, otherId);
  const { events, done, memories, feelings } = g.sections;
  if (!events.length && !done.length && !memories.length && !feelings.length) return '';
  const o = world.citizens.get(otherId);
  const parts = [`${heading} — ${ref(o)}`];
  if (done.length) parts.push(done.map((x) => `- ${x}`).join('\n'));
  if (events.length) parts.push(`What it cost between you:\n${events.map((x) => `- ${x}`).join('\n')}`);
  if (memories.length) parts.push(`What you remember:\n${memories.map((x) => `- ${x}`).join('\n')}`);
  if (feelings.length) parts.push(`What you feel toward ${ref(o)} now: ${feelings.join(', ')}.`);
  return world.memory.resolveNames(c, parts.join('\n'));
}

/** The people this citizen holds the most against, worst first: [{ id, score }] with score >= min. */
export function topGrievances(world, c, { min = 4, limit = 3 } = {}) {
  const since = world.now - DAYS * 1440;
  const ids = new Set(world.db.prepare('SELECT DISTINCT other_id FROM relationship_events WHERE citizen_id = ? AND game_time > ? AND (d_affinity < 0 OR d_trust < 0)').all(c.id, since).map((r) => r.other_id));
  for (const e of world.emotions?.of(c) ?? []) if (e.target && HOSTILE_EMOTIONS.includes(e.type)) ids.add(e.target);
  return [...ids].filter((id) => id !== c.id && world.citizens.get(id)?.alive !== false)
    .map((id) => ({ id, score: grievanceAgainst(world, c, id).score }))
    .filter((x) => x.score >= min).sort((a, b) => b.score - a.score).slice(0, limit);
}
