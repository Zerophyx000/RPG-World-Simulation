// Post-conversation reflection, GATED per participant (reflections scale with conversations):
//
//   template  no school call   code writes one short first-person memory, familiarity +0.5
//   light     reflect / light  `remember` with at most 1 memory, changes clamped to ±1
//   full      reflect / full   `remember` with up to 3 memories, changes clamped to ±3
//
// Step A (code rules) → full if it clearly mattered, template if it was clearly small talk.
// Step B otherwise: significance score on the local profile (purpose 'score', structured output),
// or — if 'score' is unavailable — the line-count fallback (<8 lines light, 8+ full).
import { relationSentence } from './words.js';
import { systemPrompt } from '../agents/prompt.js';
import { chatForTool } from '../llm.js';
import { relationLine } from '../social/describe.js';
import { emotionsSummary } from '../emotions/present.js';
import { parseFeeling, applyFeeling, feelingItemSchema, feelingPeople } from '../emotions/report.js';
import { addIntention } from '../agents/intentions.js';
import { findLeaks } from '../social/leak.js';

const FULL = { maxMemories: 3, clamp: 3 };
const LIGHT = { maxMemories: 1, clamp: 1 };

export async function onConversationEnd(world, conv, { reason, leaverId = null }) {
  const lines = conv.lines ?? [];
  if (!lines.length) return;
  const ids = (conv.everParticipants ?? []).filter((id) => {
    const c = world.citizens.get(id);
    return c && c.alive && c.kind === 'citizen';
  });
  await Promise.all(ids.map((id) => reflectOne(world, conv, id, { reason, leaverId }).catch((err) => {
    world.logEvent('error', { actorId: id, message: `reflection failed: ${err.message}` });
  })));
}

async function reflectOne(world, conv, pid, end) {
  const c = world.citizens.get(pid);
  const gate = await choosePath(world, conv, c, end);
  world.logEvent('reflection_gate', { actorId: pid, location: conv.roomId, conversationId: conv.id, citizenId: pid, ...gate });
  const others = (conv.everParticipants ?? []).filter((id) => id !== pid);
  // Every shared conversation makes people a bit more familiar.
  for (const o of others) {
    world.relationships.change(pid, o, { familiarity: 0.5 }, {
      reason: 'We talked today.', source: 'reflection', aggregate: true, evidence: { conversationId: conv.id },
      meta: { lastSeenAt: world.now, lastSeenPlace: conv.roomId },
    });
  }
  if (gate.path === 'template') return templateMemory(world, conv, c, gate.gist);
  return remember(world, conv, c, gate.path === 'full' ? FULL : LIGHT, gate.path);
}

// ---------- gating ----------
async function choosePath(world, conv, c, { reason, leaverId }) {
  const lines = conv.lines;
  const pid = c.id;
  const others = (conv.everParticipants ?? []).filter((id) => id !== pid);
  const spoke = lines.filter((l) => l.speakerId === pid).length;
  const addressed = lines.filter((l) => l.toId === pid).length;
  const flags = conv.flags ?? {};

  const fullBecause = [];
  if ((flags.high ?? []).includes(pid) || (c.onMyMind ?? []).some((m) => m.gameTime > conv.startedAt)) fullBecause.push('something important happened');
  if (others.some((o) => {
    const r = world.memory.rel(pid, o);
    return r && (Math.abs(r.affinity) >= 3 || Math.abs(r.trust) >= 3);
  })) fullBecause.push('strong feelings about someone there');
  if (addressed >= 4) fullBecause.push(`addressed ${addressed} times`);
  // Step 6: a strong feeling (>= 6) about someone who was in it
  if ((c.emotions ?? []).some((e) => e.intensity >= 6 && others.includes(e.target))) fullBecause.push('strong emotion about someone there');
  // Step 5.5: talking with someone you recently caught at something is never small talk.
  if (others.some((o) => world.relationships.events(pid, o, 20).some((e) => e.source === 'signal' && world.now - e.gameTime <= 1440))) fullBecause.push('a warning sign about someone there');
  if (reason === 'cap') fullBecause.push('talked themselves out');
  // step 9.5 (B2.3): two people grieving the same person — their talk matters
  const D = world.deaths;
  if (D && D.knownDead(c).some((dead) => D.griefFor(c, dead) >= 2 && others.some((o) => D.griefFor(world.citizens.get(o) ?? {}, dead) >= 2))) fullBecause.push('shared grief');
  // Step 7B: someone in it was hurt, treated or died: never small talk
  if (world.body?.involvedSince([pid, ...others], conv.startedAt)) fullBecause.push('someone was hurt, treated or died');
  // walked out on mid-exchange (a short greeting that simply ends is not that)
  if (leaverId && leaverId !== pid && lines.length > 3 && lines.slice(-2).some((l) => l.toId === pid)) fullBecause.push('was left mid-exchange');
  if ((flags.learned ?? []).includes(pid)) fullBecause.push('learned something concrete');
  if (fullBecause.length) return { path: 'full', reason: fullBecause[0] };

  if (lines.length <= 3 && spoke <= 1) return { path: 'template', reason: 'small talk' };

  if (world.llm.isAvailable('score')) {
    try {
      const s = await score(world, conv, c);
      const n = s.significance;
      return { path: n <= 3 ? 'template' : n <= 6 ? 'light' : 'full', reason: `score:${n}`, significance: n, gist: s.gist };
    } catch (err) {
      // fall through to the line-count fallback
    }
  }
  return { path: lines.length >= 8 ? 'full' : 'light', reason: 'fallback:lines' };
}

async function score(world, conv, c) {
  const name = (id) => world.citizens.get(id)?.name ?? id;
  const transcript = conv.lines.map((l) => `${name(l.speakerId)}${l.toId ? ` (to ${name(l.toId)})` : ''}: ${l.text}`).join('\n');
  const rels = (conv.everParticipants ?? []).filter((id) => id !== c.id).map((id) => {
    const o = world.citizens.get(id);
    return `- ${name(id)}: ${relationSentence(world.memory.rel(c.id, id), o)}`;
  }).join('\n');
  const r = await world.llm.chat({
    purpose: 'score',
    citizenId: c.id,
    messages: [
      { role: 'system', content: 'You rate how significant a conversation was for ONE of its participants, from 1 (forgettable small talk) to 10 (life-changing). Consider what was at stake for them personally. Answer with JSON only.' },
      { role: 'user', content: `Participant: ${c.name}, ${c.persona.occupation ?? ''}. ${String(c.persona.personality ?? '').split('.')[0]}.\nHow ${c.name} sees the others:\n${rels || '(no one in particular)'}\n\nTranscript:\n${transcript}\n\nReturn {"significance": 1-10, "gist": "one short sentence, third person, what the conversation was about"}.` },
    ],
    responseSchema: {
      name: 'significance',
      schema: {
        type: 'object',
        properties: { significance: { type: 'integer', minimum: 1, maximum: 10 }, gist: { type: 'string' } },
        required: ['significance', 'gist'],
        additionalProperties: false,
      },
    },
  });
  const j = r.json ?? {};
  const n = Math.round(Number(j.significance));
  if (!(n >= 1 && n <= 10)) throw new Error('no usable score');
  return { significance: n, gist: String(j.gist ?? '').trim() };
}

// ---------- template path ----------
function templateMemory(world, conv, c, gist) {
  const mem = world.memory;
  const others = (conv.everParticipants ?? []).filter((id) => id !== c.id);
  const names = listJoin(others.map((id) => mem.nameFor(c, id)));
  const room = world.rooms.get(conv.roomId);
  const where = room ? `at ${room.name}` : '';
  let what;
  if (gist) what = gist.replace(/[.!]+$/, '');
  else {
    const first = conv.lines[0];
    const who = first.speakerId === c.id ? 'I' : mem.nameFor(c, first.speakerId, { start: true });
    const t = first.text.length > 60 ? `${first.text.slice(0, 60)}…` : first.text;
    what = `${who} said: "${t}"`;
  }
  const familiar = others.some((id) => (mem.rel(c.id, id)?.familiarity ?? 0) >= 5);
  mem.add(c.id, {
    kind: 'episodic', text: `I talked briefly with ${names} ${where}: ${what}.`.replace(/\s+/g, ' '),
    importance: familiar ? 3 : 2, about: others, placeId: conv.roomId, source: { conversationId: conv.id, gated: 'template' },
  });
}

// ---------- remember (light / full) ----------
async function remember(world, conv, c, limits, path) {
  const mem = world.memory;
  const others = (conv.everParticipants ?? []).filter((id) => id !== c.id).map((id) => world.citizens.get(id)).filter(Boolean);
  const labels = mem.labelsFor(c, others);           // label -> citizen (names only if known)
  const labelOf = new Map([...labels].map(([l, o]) => [o.id, l]));
  const room = world.rooms.get(conv.roomId);
  const transcript = conv.lines.map((l) => {
    const who = l.speakerId === c.id ? 'You' : labelOf.get(l.speakerId) ?? mem.nameFor(c, l.speakerId, { start: true });
    const to = l.toId ? (l.toId === c.id ? ' (to you)' : ` (to ${labelOf.get(l.toId) ?? mem.nameFor(c, l.toId)})`) : '';
    const thought = l.speakerId === c.id && l.thought ? `\n   (you thought: ${l.thought})` : '';
    return `${who}${to}: "${l.text}"${thought}`;
  }).join('\n');
  const relLines = others.map((o) => `- ${labelOf.get(o.id)}: ${relationLine(world, c, o).text}`).join('\n');
  const onMind = (c.onMyMind ?? []).map((m) => `- ${m.text}`).join('\n');
  const feelNow = emotionsSummary(world, c);
  const seenThings = objectContext(world, conv, c, (id) => labelOf.get(id) ?? mem.nameFor(c, id));
  const user = [
    `# THE CONVERSATION THAT JUST ENDED\nAt ${room?.name ?? 'somewhere'}, with ${[...labels.keys()].join(', ')}.`,
    `Transcript:\n${transcript}`,
    seenThings ? `# WHAT YOU ALSO SAW MEANWHILE\n${seenThings}` : '',
    `# HOW YOU SEE THEM\n${relLines || '(nobody you know)'}`,
    onMind ? `# ON YOUR MIND\n${onMind}` : '',
    feelNow ? `# HOW YOU FEEL RIGHT NOW\n${feelNow}` : '',
    `# WHAT NOW\nTake a private moment to take stock. What will you remember from this conversation, in your own words and from your own point of view? How do you feel about them now? Only what actually happened or was said; don't invent anything. If someone told you about something you don't remember yourself (including things you supposedly did), record it as what they said ("Greta says I promised…", firsthand: false), not as a fact.${limits.maxMemories === 1 ? ' Keep it to the one thing that matters most.' : ''} Under feelings, say what this conversation left you with (up to 3: a sting of envy, shame at an insult, warmth at a kindness…), if anything — emotion, who it is about, stronger or weaker, by how much (1–3), and why. Call remember exactly once.`,
  ].filter(Boolean).join('\n\n');

  const labelList = [...labels.keys()];
  // step 9.5: everyone they know, the dead they know of included (for news and intentions about them)
  // everyone they have met — someone can hear in a conversation that a person they knew has died
  const newsPeople = world.memory.labelsFor(c, world.memory.knownPeople(c, { dead: 'all' }));
  const newsLabels = [...newsPeople.keys()];
  const feelPeople = feelingPeople(world, c);
  const tools = [{
    type: 'function',
    function: {
      name: 'remember',
      description: 'What you take away from the conversation.',
      parameters: {
        type: 'object',
        properties: {
          memories: {
            type: 'array', maxItems: limits.maxMemories,
            description: 'What you will remember, first person, your own words (one or two sentences each).',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                importance: { type: 'integer', minimum: 1, maximum: 10, description: 'How much it matters to you.' },
                about: { type: 'array', items: { type: 'string', enum: labelList }, description: 'Who it is about.' },
                firsthand: { type: 'boolean', description: 'false if it is something you were only TOLD about, not something that happened in front of you.' },
              },
              required: ['text', 'importance'],
            },
          },
          relationships: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                person: { type: 'string', enum: labelList },
                affinity_change: { type: 'integer', minimum: -limits.clamp, maximum: limits.clamp, description: 'How much more (+) or less (−) you like them now.' },
                trust_change: { type: 'integer', minimum: -limits.clamp, maximum: limits.clamp, description: 'How much more (+) or less (−) you trust them now.' },
                reason: { type: 'string', description: 'Why, in a few of your own words, first person: what they did or said that changed how you see them ("He lied to me about the mine entrance.").' },
                summary: { type: 'string', description: 'One or two sentences, your words: what you think of them now.' },
              },
              required: ['person', 'reason'],
            },
          },
          learned_names: { type: 'array', items: { type: 'string', enum: labelList }, description: 'People whose name you learned in this conversation.' },
          feelings: { type: 'array', maxItems: 3, items: feelingItemSchema(world, [...new Set([...labelList, ...feelPeople.keys()])]), description: 'What this conversation left you feeling, if anything.' },
          on_my_mind: { type: 'string', description: 'Optional. Something from this you keep thinking about.' },
          // step 9.5 (A1.3): things said and decided become intentions; (B1.2) news of a death heard here
          promises: { type: 'array', maxItems: 2, description: 'Things YOU said you would do, if any.', items: { type: 'object', properties: { text: { type: 'string' }, to: { type: 'string', enum: labelList } }, required: ['text'] } },
          intentions: { type: 'array', maxItems: 2, description: 'Things you decided during the talk that you mean to do.', items: { type: 'object', properties: { text: { type: 'string' }, about: { type: 'array', items: { type: 'string', enum: newsLabels.length ? newsLabels : ['nobody'] } } }, required: ['text'] } },
          ...(newsLabels.length ? { learned_news: { type: 'array', maxItems: 2, description: 'News about someone you heard here: that they died, are badly hurt, missing or alive.', items: { type: 'object', properties: { person: { type: 'string', enum: newsLabels }, news: { type: 'string', enum: ['died', 'badly_hurt', 'missing', 'found_alive'] }, from: { type: 'string', enum: labelList } }, required: ['person', 'news'] } } } : {}),
        },
        required: ['memories'],
      },
    },
  }];

  const r = await chatForTool(world.llm, {
    purpose: 'reflect', tier: path, citizenId: c.id, tools,
    messages: [{ role: 'system', content: systemPrompt(world, c) }, { role: 'user', content: user }],
  }, 'remember');
  if (!c.alive) return; // step 9.5: they died while reflecting — nothing more is laid down
  const args = r.toolCalls?.find((t) => t.name === 'remember')?.arguments;
  if (!args || '_raw' in args) {
    templateMemory(world, conv, c, null); // no conversation is left without a memory
    return;
  }
  const byLabel = (l) => labels.get(l) ?? others.find((o) => o.name.toLowerCase() === String(l).toLowerCase() || o.id === l);
  const lastOtherSpeaker = [...conv.lines].reverse().find((l) => l.speakerId !== c.id)?.speakerId ?? others[0]?.id ?? null;

  for (const m of (Array.isArray(args.memories) ? args.memories : []).slice(0, limits.maxMemories)) {
    if (!m?.text) continue;
    const about = (Array.isArray(m.about) ? m.about : []).map(byLabel).filter(Boolean).map((o) => o.id);
    const secondhand = m.firsthand === false;
    const id = mem.add(c.id, {
      kind: secondhand ? 'secondhand' : 'episodic',
      text: String(m.text).trim(),
      importance: Math.min(10, Math.max(1, Math.round(Number(m.importance) || 4))),
      about: about.length ? about : others.map((o) => o.id),
      placeId: conv.roomId,
      source: { conversationId: conv.id, gated: path, ...(secondhand ? { toldBy: lastOtherSpeaker } : {}) },
    });
    if (Number(m.importance) >= 7) mem.pushOnMind(c, { text: String(m.text).trim(), importance: Number(m.importance), memoryId: id });
    if (secondhand && about.length >= 2) world.emotions.appraisal.secondhand(c, about);
  }
  for (const rr of Array.isArray(args.relationships) ? args.relationships : []) {
    const o = byLabel(rr?.person);
    if (!o) continue;
    const cl = (v) => Math.max(-limits.clamp, Math.min(limits.clamp, Math.round(Number(v) || 0)));
    const dA = cl(rr.affinity_change);
    const dT = cl(rr.trust_change);
    const summary = rr.summary && String(rr.summary).trim() ? String(rr.summary).trim().slice(0, 300) : null;
    if (dA || dT) {
      // Every change needs a reason; a model that left it out gets its own summary (or the gist of the talk) as one.
      const reason = String(rr.reason ?? '').trim() || summary || 'Something in how we talked changed how I see them.';
      world.relationships.change(c.id, o.id, { affinity: dA, trust: dT }, {
        reason, source: 'reflection', evidence: { conversationId: conv.id }, meta: summary ? { summary } : {},
      });
    } else if (summary) mem.upsertRel(c.id, o.id, { summary });
  }
  for (const l of Array.isArray(args.learned_names) ? args.learned_names : []) {
    const o = byLabel(l);
    if (o) mem.learnName(c.id, o.id, 1);
  }
  if (args.on_my_mind && String(args.on_my_mind).trim()) mem.pushOnMind(c, { text: String(args.on_my_mind).trim(), importance: 6 });
  // Step 6: the feelings the conversation left behind (clamped, known people only); this is how the subtle
  // things come in: envy from praise, shame from an insult, affection from a kindness.
  for (const f of (Array.isArray(args.feelings) ? args.feelings : []).slice(0, 3)) {
    applyFeeling(world, c, parseFeeling(world, c, f, new Map([...feelPeople, ...labels])), 'reflection');
  }
  // step 9.5 (A1.3): promises and decisions become intentions
  for (const p of (Array.isArray(args.promises) ? args.promises : []).slice(0, 2)) {
    const to = byLabel(p?.to);
    addIntention(world, c, { text: p?.text, about: to ? [to.id] : [], source: 'promise' });
  }
  for (const it of (Array.isArray(args.intentions) ? args.intentions : []).slice(0, 2)) {
    const about = (Array.isArray(it?.about) ? it.about : []).map((l) => newsPeople.get(l)?.id).filter(Boolean);
    addIntention(world, c, { text: it?.text, about, source: 'self' });
  }
  // step 9.5 (B1.2): news heard in the conversation (a death is believed or doubted by trust in the teller)
  for (const n of (Array.isArray(args.learned_news) ? args.learned_news : []).slice(0, 2)) {
    const who = newsPeople.get(n?.person);
    const from = byLabel(n?.from) ?? world.citizens.get(lastOtherSpeaker);
    if (!who) continue;
    if (n.news === 'died' && !who.alive) {
      const trust = from ? world.memory.rel(c.id, from.id)?.trust ?? 0 : 0;
      world.deaths.learn(c, who.id, { how: from ? `told:${from.id}` : 'inferred', certainty: trust < 0 ? 'doubted' : 'believed', by: from?.id ?? null });
    } else if (n.news !== 'died') {
      c.knownNews = { ...(c.knownNews ?? {}), [who.id]: { news: n.news, from: from?.id ?? null, at: world.now, certainty: 'believed' } };
    }
  }
  // step 10: a safety net (seen in a GLM run: "Jonas is dead — Anselm says…" in a memory, learned_news left empty). If
  // what they just laid down states a death they haven't registered, and the dead person was named in this very
  // conversation, they learn it from whoever spoke last — their own mind already holds it.
  const ownWords = [...(Array.isArray(args.memories) ? args.memories.map((m) => m?.text) : []), args.on_my_mind].filter(Boolean).join('\n');
  const said = conv.lines.map((l) => l.text).join('\n');
  for (const l of findLeaks(world, ownWords, c.id).filter((x) => x.kind === 'unknownDeath')) {
    const dead = world.citizens.get(l.of);
    if (!dead || dead.alive || world.deaths.knows(c, dead.id) || !new RegExp(`\\b${dead.name.split(/\s+/)[0]}\\b`, 'i').test(said)) continue;
    const from = world.citizens.get(lastOtherSpeaker);
    const trust = from ? world.memory.rel(c.id, from.id)?.trust ?? 0 : 0;
    world.deaths.learn(c, dead.id, { how: from ? `told:${from.id}` : 'inferred', certainty: trust < 0 ? 'doubted' : 'believed', by: from?.id ?? null });
    world.logEvent('learned_from_reflection', { actorId: c.id, deadId: dead.id, from: from?.id ?? null, conversationId: conv.id, text: l.text });
  }
  world.saveCitizen(c);
  world.scheming?.onReflection(c); // step 11: accomplices' commitment, open proposals, maybe a plan (<= 1 a day)
}

function listJoin(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

// Step 5: object actions this participant saw (or did) while the conversation ran, in their own naming.
const SEEN_VERB = { take: 'picked up', put: 'put down', give: 'handed over', conceal: 'hid', use: 'used' };
function objectContext(world, conv, c, nameOf) {
  const O = world.objects;
  if (!O || conv.startedAt == null) return '';
  const rows = world.db.prepare(`SELECT object_id, actor_id, action, witnesses FROM object_history
    WHERE game_time >= ? AND action IN ('take','put','give','conceal','use') ORDER BY id LIMIT 40`).all(conv.startedAt);
  const lines = [];
  for (const r of rows) {
    const o = O.get(r.object_id);
    if (!o) continue;
    const saw = r.actor_id === c.id || JSON.parse(r.witnesses || '[]').includes(c.id);
    if (!saw) continue;
    const who = r.actor_id === c.id ? 'You' : nameOf(r.actor_id);
    lines.push(`- ${who} ${SEEN_VERB[r.action] ?? r.action} ${O.textFor(c, o)}.`);
  }
  return lines.slice(-8).join('\n');
}
