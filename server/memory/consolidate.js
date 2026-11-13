// Sleep consolidation ("dreaming"), decay and name fading.
//
// On falling asleep (step-3 hook), if >= 12 game hours since the last consolidation or >= 8 new memories:
// one 'consolidate' call (tier full) rewrites the core memory, merges the day's memories into fewer
// lasting ones, fades some, turns old minor memories into vague gists and updates relationship summaries.
// It runs while they sleep; if they wake first, the result is applied anyway when it arrives.
//
// Decay (once per game day): strength × daily factor^days by importance; importance × strength < 1 → forgotten.
// Cap 300 active memories. Names of people seen rarely (familiarity < 3) fade.
import { memFromDb } from './index.js';
import { timeLabel } from './retrieve.js';
import { systemPrompt } from '../agents/prompt.js';
import { chatForTool } from '../llm.js';
import { relationLine } from '../social/describe.js';
import { emotionsSummary } from '../emotions/present.js';
import { parseFeeling, applyFeeling, feelingItemSchema } from '../emotions/report.js';

const MIN_HOURS = 12;
const MIN_NEW = 8;
const CORE_MAX_CHARS = 1800;
const ACTIVE_CAP = 300;
const GIST_CANDIDATES = 5;

export function shouldConsolidate(world, c) {
  const last = c.lastConsolidatedAt ?? -Infinity;
  return world.now - last >= MIN_HOURS * 60 || world.memory.countSince(c.id, last) >= MIN_NEW;
}

/** Called from World's onSleepStart hook. Never throws. */
export function onSleepStart(world, c) {
  decayAndFade(world, c);
  if (!shouldConsolidate(world, c)) return;
  const rt = world.runtime(c.id);
  if (rt.consolidating) return;
  rt.consolidating = true;
  consolidate(world, c)
    .catch((err) => world.logEvent('error', { actorId: c.id, message: `consolidation failed: ${err.message}` }))
    .finally(() => { rt.consolidating = false; });
}

export async function consolidate(world, c) {
  const mem = world.memory;
  const since = c.lastConsolidatedAt ?? -Infinity;
  const recent = world.db.prepare(`SELECT * FROM memories WHERE citizen_id = ? AND status = 'active' AND game_time > ? AND kind != 'consolidated' ORDER BY game_time`)
    .all(c.id, Number.isFinite(since) ? since : -1e12).map(memFromDb);
  const gistCands = world.db.prepare(`SELECT * FROM memories WHERE citizen_id = ? AND status = 'active' AND is_gist = 0 AND importance <= 6 AND game_time < ? ORDER BY game_time LIMIT ?`)
    .all(c.id, world.now - 3 * 1440, GIST_CANDIDATES).map(memFromDb);
  const changedRels = mem.relsOf(c.id).filter((r) => r.updatedAt != null && r.updatedAt > (Number.isFinite(since) ? since : -1e12));
  const allowed = new Set([...recent, ...gistCands].map((m) => m.id));
  if (!recent.length && !gistCands.length) {
    c.lastConsolidatedAt = world.now;
    world.saveCitizen(c);
    return null;
  }

  const people = new Map(changedRels.map((r) => [r.otherId, world.citizens.get(r.otherId)]));
  for (const m of recent) for (const id of m.about) if (world.citizens.has(id)) people.set(id, world.citizens.get(id));
  const labels = mem.labelsFor(c, [...people.values()].filter(Boolean));
  const labelOf = new Map([...labels].map(([l, o]) => [o.id, l]));
  const line = (m) => `[#${m.id}] (${timeLabel(world.now, m.gameTime)}) ${mem.resolveNames(c, m.text)}`;

  const feelNow = emotionsSummary(world, c);
  const user = [
    `# YOUR CORE MEMORY (who you are, as you see it)\n${c.coreMemory || '(nothing written yet)'}`,
    `# WHAT HAPPENED SINCE YOU LAST SLEPT\n${recent.map(line).join('\n') || '(nothing new)'}`,
    (c.onMyMind ?? []).length ? `# WHAT WAS ON YOUR MIND\n${c.onMyMind.map((m) => `- ${m.text}`).join('\n')}` : '',
    changedRels.length ? `# PEOPLE WHOSE PLACE IN YOUR LIFE CHANGED TODAY\n${changedRels.filter((r) => world.citizens.has(r.otherId)).map((r) => `- ${labelOf.get(r.otherId) ?? r.otherId}: ${relationLine(world, c, world.citizens.get(r.otherId)).text}`).join('\n')}` : '',
    gistCands.length ? `# OLD, MINOR MEMORIES (already fading)\n${gistCands.map(line).join('\n')}` : '',
    feelNow ? `# HOW YOU FELT GOING TO SLEEP\n${feelNow}` : '',
    `# WHAT NOW\nYou are asleep. Your mind sorts the day. Rewrite your core memory (first person, at most 250 words: who you are now, what matters, your people, what you are working towards). Merge related memories from today into a few lasting ones (list the ids they merge). Let trivial ones fade. Turn the old, minor memories into vague gists. Update what you think of people whose place in your life changed. Under lingering, name the feelings that carry over into tomorrow (up to 3), and under mood_shift say whether the day left you lower (−) or lighter (+) overall. Use only what is listed here. Call consolidate exactly once.`,
  ].filter(Boolean).join('\n\n');

  const labelList = [...labels.keys()];
  const ids = [...allowed];
  const feelLabels = mem.labelsFor(c, mem.knownPeople(c));
  const tools = [{
    type: 'function',
    function: {
      name: 'consolidate',
      description: 'Sort the day into lasting memory.',
      parameters: {
        type: 'object',
        properties: {
          core_memory: { type: 'string', description: 'First person, at most 250 words.' },
          lasting: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                importance: { type: 'integer', minimum: 1, maximum: 10 },
                about: { type: 'array', items: { type: 'string', enum: labelList.length ? labelList : ['nobody'] } },
                merges: { type: 'array', items: { type: 'integer', enum: ids } },
              },
              required: ['text', 'importance', 'merges'],
            },
          },
          fade: { type: 'array', items: { type: 'integer', enum: ids } },
          gists: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer', enum: gistCands.map((m) => m.id).length ? gistCands.map((m) => m.id) : [0] }, text: { type: 'string' } }, required: ['id', 'text'] } },
          relationship_summaries: { type: 'array', items: { type: 'object', properties: { person: { type: 'string', enum: labelList.length ? labelList : ['nobody'] }, summary: { type: 'string' } }, required: ['person', 'summary'] } },
          lingering: { type: 'array', maxItems: 3, items: feelingItemSchema(world, [...mem.labelsFor(c, mem.knownPeople(c)).keys()]), description: 'Feelings that carry into tomorrow.' },
          mood_shift: { type: 'integer', minimum: -2, maximum: 2, description: 'How the day left your mood overall: −2 much lower … +2 much lighter.' },
        },
        required: ['core_memory'],
      },
    },
  }];

  const r = await chatForTool(world.llm, {
    purpose: 'consolidate', tier: 'full', citizenId: c.id, tools,
    messages: [{ role: 'system', content: systemPrompt(world, c) }, { role: 'user', content: user }],
  }, 'consolidate');
  const a = r.toolCalls?.find((t) => t.name === 'consolidate')?.arguments;
  if (!a || '_raw' in a) throw new Error('no usable consolidate call');
  return apply(world, c, a, { allowed, gistIds: new Set(gistCands.map((m) => m.id)), labels, recent, gistCands, feelLabels });
}

function apply(world, c, a, { allowed, gistIds, labels, recent, gistCands, feelLabels }) {
  const mem = world.memory;
  const record = { oldCore: c.coreMemory ?? '', newCore: null, lasting: [], merged: [], faded: [], gists: [], summaries: [], lingering: [], moodShift: 0, attitudes: [] };
  const byLabel = (l) => labels.get(l);
  const ok = (id) => allowed.has(Number(id));

  for (const l of Array.isArray(a.lasting) ? a.lasting : []) {
    if (!l?.text) continue;
    const merges = (Array.isArray(l.merges) ? l.merges : []).map(Number).filter(ok);
    const about = (Array.isArray(l.about) ? l.about : []).map(byLabel).filter(Boolean).map((o) => o.id);
    const mergedFrom = recent.filter((m) => merges.includes(m.id));
    const id = mem.add(c.id, {
      kind: 'consolidated', text: String(l.text).trim(), importance: Math.min(10, Math.max(1, Math.round(Number(l.importance) || 5))),
      about: about.length ? about : [...new Set(mergedFrom.flatMap((m) => m.about))],
      placeId: mergedFrom[0]?.placeId ?? null, source: { merges },
      gameTime: mergedFrom.length ? Math.max(...mergedFrom.map((m) => m.gameTime)) : world.now,
    });
    for (const mid of merges) {
      mem.setStatus(mid, 'merged', id);
      record.merged.push(mid);
    }
    record.lasting.push({ id, text: String(l.text).trim(), merges });
  }
  const fadeSt = world.db.prepare('UPDATE memories SET strength = strength * 0.3 WHERE id = ? AND citizen_id = ?');
  for (const id of (Array.isArray(a.fade) ? a.fade : []).map(Number).filter(ok)) {
    fadeSt.run(id, c.id);
    record.faded.push(id);
  }
  const gistSt = world.db.prepare('UPDATE memories SET text = ?, is_gist = 1 WHERE id = ? AND citizen_id = ?');
  for (const g of Array.isArray(a.gists) ? a.gists : []) {
    const id = Number(g?.id);
    if (!gistIds.has(id) || !g.text) continue;
    const old = gistCands.find((m) => m.id === id)?.text;
    gistSt.run(String(g.text).trim(), id, c.id);
    record.gists.push({ id, old, text: String(g.text).trim() });
  }
  for (const s of Array.isArray(a.relationship_summaries) ? a.relationship_summaries : []) {
    const o = byLabel(s?.person);
    if (!o || !s.summary) continue;
    const before = mem.rel(c.id, o.id)?.summary ?? null;
    mem.upsertRel(c.id, o.id, { summary: String(s.summary).trim().slice(0, 300) });
    record.summaries.push({ person: o.id, before, after: String(s.summary).trim() });
  }
  if (a.core_memory && String(a.core_memory).trim()) {
    c.coreMemory = cutAtSentence(String(a.core_memory).trim(), CORE_MAX_CHARS);
    record.newCore = c.coreMemory;
  }
  // Step 6: feelings that carry over, the night's mood shift (then a pull back towards the personality
  // baseline), and envy / jealousy that lasted most of the day hardening into an attitude with a reason.
  for (const f of (Array.isArray(a.lingering) ? a.lingering : []).slice(0, 3)) {
    const parsed = parseFeeling(world, c, f, feelLabels ?? labels);
    if (applyFeeling(world, c, parsed, 'consolidation')) record.lingering.push(parsed);
  }
  record.attitudes = world.emotions.appraisal.lasting(c);
  record.moodShift = Math.max(-2, Math.min(2, Math.round(Number(a.mood_shift) || 0)));
  const sinceLast = c.lastConsolidatedAt != null ? (world.now - c.lastConsolidatedAt) / 1440 : 1;
  const mood = world.emotions.nightly(c, record.moodShift, sinceLast);
  record.mood = { valence: Math.round(mood.valence * 100) / 100, tension: Math.round(mood.tension * 100) / 100 };
  c.onMyMind = [];
  c.lastConsolidatedAt = world.now;
  world.saveCitizen(c);
  const info = world.db.prepare('INSERT INTO consolidations (citizen_id, game_time, data) VALUES (?, ?, ?)').run(c.id, world.now, JSON.stringify(record));
  world.logEvent('consolidation', {
    actorId: c.id, location: c.location, consolidationId: Number(info.lastInsertRowid),
    lasting: record.lasting.length, merged: record.merged.length, faded: record.faded.length, gists: record.gists.length,
  });
  return record;
}

const DAILY = (importance) => (importance >= 9 ? 0.99 : importance >= 6 ? 0.97 : importance >= 3 ? 0.92 : 0.85);

/** Once per game day: memories decay, rarely-seen names fade. */
export function decayAndFade(world, c) {
  const now = world.now;
  const last = c.lastDecayAt ?? now;
  const days = (now - last) / 1440;
  if (c.lastDecayAt != null && days < 1) return;
  c.lastDecayAt = now;
  world.saveCitizen(c);
  if (days <= 0) return;
  world.relationships.decay(c.id, days); // step 5.5: reasons fade too (the values stay)

  const rows = world.memory.active(c.id);
  const upd = world.db.prepare('UPDATE memories SET strength = ?, status = ? WHERE id = ?');
  const kept = [];
  for (const m of rows) {
    // strongly emotional memories fade at the next slower band (step 6)
    const strength = m.strength * DAILY(m.importance + (Math.abs(m.valence ?? 0) >= 0.5 ? 3 : 0)) ** days;
    const forgotten = m.importance * strength < 1;
    upd.run(strength, forgotten ? 'forgotten' : 'active', m.id);
    if (!forgotten) kept.push({ id: m.id, value: m.importance * strength, strength });
  }
  if (kept.length > ACTIVE_CAP) {
    kept.sort((x, y) => x.value - y.value);
    for (const k of kept.slice(0, kept.length - ACTIVE_CAP)) upd.run(k.strength, 'forgotten', k.id);
  }
  // Names of people you hardly know slip away.
  for (const r of world.memory.relsOf(c.id)) {
    if (!r.nameKnown || r.familiarity >= 3 || r.nameConfidence <= 0) continue;
    const unseenDays = Math.min(days, r.lastSeenAt != null ? (now - r.lastSeenAt) / 1440 : days);
    if (unseenDays <= 0) continue;
    world.memory.upsertRel(c.id, r.otherId, { nameConfidence: Math.max(0, r.nameConfidence - 0.08 * (3 - r.familiarity) * unseenDays), updatedAt: r.updatedAt });
  }
}

function cutAtSentence(s, max) {
  if (s.length <= max) return s;
  const w = s.slice(0, max);
  const end = Math.max(w.lastIndexOf('. '), w.lastIndexOf('! '), w.lastIndexOf('? '));
  return end > max * 0.5 ? w.slice(0, end + 1) : w;
}
