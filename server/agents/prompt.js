// Prompt builder: buildMessages(world, citizen, opts) → OpenAI-style messages. Pure (reads, never writes).
//
// Order matters for the server's prefix cache: the most stable content first.
//   [system] world rules · common knowledge · WHO YOU ARE · WHAT YOU KNOW ABOUT YOURSELF (core memory;
//            only changes at night, so the system prefix is identical all game day)
//   [user]   (urgency line) · RIGHT NOW · WHAT'S HERE · YOU'RE CARRYING · HOW YOU FEEL · YOUR PLAN · ON YOUR MIND · WHO IS HERE ·
//            YOU REMEMBER · PLACES YOU KNOW (with travel times and last known state, step 7A) · CONVERSATION ·
//            WHAT JUST HAPPENED · instruction
//
// People are named only if this citizen knows the name; otherwise they are described by how they look.
// Relationships appear in words, never numbers.
import { traitsToWords } from './traits.js';
import { citizensIn, activeEffects, openExits } from '../world/rooms.js';
import { pronouns } from '../world/citizens.js';
import { isIngPhrase, ingOrQuote } from '../world/actions.js';
import { SOFT_CAP_LINES, TRANSCRIPT_LINES } from '../world/conversations.js';
import { placeLabel, knownWith, servicesText, travelMinutes, knownRoomState, lastSeenPhrase } from '../world/places.js';
import { clockTime, timeOfDay, relativeTime } from '../world/time.js';
import { retrieve, memoryLine } from '../memory/retrieve.js';
import { relationSentence } from '../memory/words.js';
import { planBlock, yesterdayText } from './plan.js';
import { carryingPhrase } from '../world/object-actions.js';
import { ownBody, cuesFor, wearingLine, senses, dropsDetail } from '../body/perceive.js';
import { SLOTS } from '../world/objects.js';
import { relationLine } from '../social/describe.js';
import { feelLines, moodFraming, whoIsHere, hereNotes, orderStimuli, instructionClause } from '../emotions/present.js';
import { FEELING_RULE } from '../emotions/report.js';

export { clockTime, timeOfDay, relativeTime };

const MEMORY_CHAR_BUDGET = 4000; // ON YOUR MIND + YOU REMEMBER ≈ 1,000 tokens

export const WORLD_RULES = `You are a person living in this world, not an assistant. You only know what you have been told here and what you perceive. Never invent people, places or events that are not mentioned; if you don't know something, you don't know it. You speak and act like your character, with their flaws. You are not obligated to be nice, helpful or talkative. Think through the situation privately first: what you notice, how you feel about it, what you want. Then act by calling exactly one tool.

How your world works:
- Time passes in minutes. Walking, working, eating, sleeping and waiting all take time, and other people act while you do.
- You have a body: you get hungry and tired, and you can get hurt. How you feel is described to you; what you do about it is up to you.
- You only know the places listed under PLACES YOU KNOW. Other buildings you can see, but you don't know what they are or what can be had there until you go in or someone tells you. Don't make up places or directions.
- You only know someone's name if you have heard it. People whose name you don't know are described by how they look; don't call them by a name.
- Your memories are what's listed under what you remember, on your mind and what you know about yourself — nothing else. If someone mentions something you have no memory of, you don't remember it. You can admit it, ask, or bluff — but if you bluff, you know you're bluffing. Never invent shared past events.
- You can only talk to people who are in the same place as you. Everyone there hears what you say out loud.
- When you speak, say only your own words, the way your character would say them. Don't describe your own actions inside your speech.
- People talk in short turns: usually one or two sentences. You can always say more on your next turn. Don't give speeches unless the moment truly calls for one.
- Your speech habits are flavor, not a script. Use pet names, catchphrases and verbal tics rarely, the way real people do; most sentences have none.
- You can only touch, take or use things listed under what's here or what you're carrying. You can't produce objects that aren't there. You may suspect hidden things — searching is how you find out.
- You cannot control other people or decide what they do, say or feel.
${FEELING_RULE}
- It is fine to do nothing special, keep to yourself, refuse, lie, or walk away, if that is what your character would do.`;

/**
 * @param {object} opts
 * @param {'full'|'light'|'none'} [opts.tier]
 * @param {'decide'|'plan'} [opts.mode]
 * @param {object} [opts.collect]  filled with { recalled: [memory ids] } (the caller decides whether that counts as recall)
 */
export function buildMessages(world, c, { tier = 'full', mode = 'decide', collect = null } = {}) {
  return [
    { role: 'system', content: systemPrompt(world, c) },
    { role: 'user', content: situationPrompt(world, c, { tier, mode, collect }) },
  ];
}

// ---------- [system] ----------
export function systemPrompt(world, c) {
  const blocks = [`# HOW THIS WORKS\n${WORLD_RULES}`];
  if (world.worldText) blocks.push(`# WHAT EVERYONE AROUND HERE KNOWS\n${world.worldText}`);
  blocks.push(`# WHO YOU ARE\n${whoYouAre(world, c)}`);
  if (c.coreMemory) blocks.push(`# WHAT YOU KNOW ABOUT YOURSELF\n${c.coreMemory}`);
  return blocks.join('\n\n');
}

function whoYouAre(world, c) {
  const p = c.persona;
  const bits = [p.age != null ? `${p.age} years old` : null, p.sex, p.occupation ? `the ${p.occupation}` : null].filter(Boolean);
  const lines = [`You are ${c.name}${bits.length ? `, ${bits.join(', ')}` : ''}.`];
  if (p.appearance) lines.push(`Appearance: ${p.appearance}`);
  const personality = [p.personality, ...traitsToWords(p.traits)].filter(Boolean).join(' ');
  if (personality) lines.push(`Personality: ${personality}`);
  if (p.speechStyle) lines.push(`How you tend to talk (use sparingly): ${p.speechStyle}`);
  if (p.backstory) lines.push(`Your story: ${p.backstory}`);
  if (p.goals.length) lines.push(`What you want:\n${p.goals.map((g) => `- ${g}`).join('\n')}`);
  // Step 5.5: secret goals appear here and NOWHERE else (never in anyone else's prompt, never to the keeper).
  if (p.secretGoals?.length) lines.push(`Your private aims (nobody knows these):\n${p.secretGoals.map((g) => `- ${g}`).join('\n')}`);
  const home = world.rooms.get(c.home);
  lines.push(home ? `Your home: ${home.name}.` : 'You have no home here yet.');
  return lines.join('\n');
}

// ---------- [user] ----------
function situationPrompt(world, c, { tier, mode, collect }) {
  const now = world.now;
  const mem = world.memory;
  const room = world.rooms.get(c.location);
  const feel = world.needs.describe(c);
  const blocks = [];

  // Severe needs go first, so they are not buried under conversation noise. Step 7B: blood and wounds first of all.
  const body = ownBody(world, c);
  const sn = senses(c);
  if (body.urgent) blocks.push(body.urgent);
  else if (feel.urgent) blocks.push(feel.urgent);

  // RIGHT NOW
  // Step 6: mood colours the moment (one framing sentence; the room description itself is never rewritten).
  const framing = moodFraming(world, c);
  const emoNotes = hereNotes(world, c, room);
  const right = [...(framing ? [framing] : []), `It is ${timeOfDay(now)} on day ${Math.floor(now / 1440) + 1} (${clockTime(now)}).`];
  if (room) {
    right.push(`You are in ${room.name}. ${room.description}`.trim());
    const effects = activeEffects(room, now).map((e) => e.text);
    if (effects.length) right.push(`You notice: ${effects.join(' ')}`);
    if (room.affordances.length) right.push(`Things people do here: ${room.affordances.join(', ')}.`);
    const exits = openExits(room, now).filter((e) => world.rooms.has(e.to))
      .map((e) => `${placeLabel(c, world.rooms.get(e.to))} (${e.travelMinutes} min)`);
    if (exits.length) right.push(`From here you can walk to:\n${exits.map((x) => `- ${x}`).join('\n')}`);
    right.push(...emoNotes.rightNow);
    const blocked = (room.blockedExits ?? []).filter((b) => b.until == null || b.until > now)
      .map((b) => `the way to ${placeLabel(c, world.rooms.get(b.to))} is blocked${b.reason ? ` (${b.reason})` : ''}`);
    if (blocked.length) right.push(`Right now ${blocked.join('; ')}.`);
  } else if (c.activity.type === 'moving') {
    right.push(`You are on your way to ${placeLabel(c, world.rooms.get(c.activity.detail?.to))}.`);
  }
  right.push(ownActivity(world, c));
  const marks = (c.marks ?? []).filter((m) => m.until == null || m.until > now).map((m) => m.text);
  if (marks.length) right.push(`About yourself: ${marks.join('; ')}.`);
  if (c.recentActions.length) {
    right.push(`What you did recently:\n${c.recentActions.map((a) => `- (${relativeTime(now - a.gameTime)}) ${mem.resolveNames(c, a.text)}`).join('\n')}`);
  }
  blocks.push(`# RIGHT NOW\n${right.join('\n')}`);

  // WHAT'S HERE / YOU'RE CARRYING (step 5): the surface view, with the handles the object tools use
  if (room) {
    let here = [...world.objects.whatsHere(c, { aliases: true }), ...emoNotes.whatsHere];
    if (sn.concussed) here = here.filter((_l, i) => i < 2 || !dropsDetail(c, i, Math.floor(now / 30))); // a rattled head misses details
    const blindNote = sn.blind ? "You can't see. What you know of this place comes from memory and touch:\n" : '';
    blocks.push(`# WHAT'S HERE\n${blindNote}${here.length ? here.join('\n') : sn.blind ? 'Nothing that you can feel around you.' : 'Nothing worth mentioning.'}`);
  }
  blocks.push(`# YOU'RE CARRYING\n${carryingBlock(world, c)}`);

  // HOW YOU FEEL (only when something is off)
  const emoLines = feelLines(world, c); // step 6: body sensations, never numbers or labels
  if (feel.any || emoLines.length || body.lines.length) {
    const hints = [];
    // step 7A: when a need bites, the nearest place they know that answers it (shortest route from here).
    const nearest = (service) => knownWith(c, service)
      .map((id) => ({ id, mins: travelMinutes(world.rooms, c.location, id, now) }))
      .filter((e) => e.mins != null)
      .sort((a, b) => a.mins - b.mins)[0] ?? null;
    if (feel.idx.hunger >= 2) {
      const food = nearest('food');
      hints.push(food ? `Nearest food you know: ${placeLabel(c, world.rooms.get(food.id))} (${food.mins ? `${food.mins} min` : 'right here'}).` : "You don't know where to find food around here.");
    }
    if (feel.idx.fatigue >= 2) {
      const bed = nearest('bed');
      const state = bed ? knownRoomState(world, c, bed.id).bed : null;
      const word = state === 'broken' ? 'but the bed is broken' : state === 'usable' ? 'bed usable' : null;
      hints.push(bed ? `Nearest bed you know: ${placeLabel(c, world.rooms.get(bed.id))} (${bed.mins ? `${bed.mins} min` : 'right here'}${word ? `, ${word}` : ''}).` : "You don't know anywhere you could sleep properly.");
    }
    blocks.push(`# HOW YOU FEEL\n${[feel.any ? feel.text : null, ...body.lines, ...hints, ...emoLines].filter(Boolean).join('\n')}`);
  }

  // YOUR PLAN
  if (mode === 'plan') {
    const y = yesterdayText(world, c);
    if (y) blocks.push(`# YESTERDAY\n${y}`);
  } else {
    const pb = planBlock(world, c);
    if (pb) blocks.push(`# YOUR PLAN\n${pb}`);
  }

  // YOUR GROUPS (step 5.5)
  const groups = world.groups.block(c);
  if (groups) blocks.push(`# YOUR GROUPS\n${groups}`);
  const invites = world.groups.invitations(c);
  if (invites.length) {
    blocks.push(`# INVITATIONS\n${invites.map((i) => `- ${mem.nameFor(c, i.from, { start: true })} has asked you to join ${pronouns(world.citizens.get(i.from)).obj}: to ${i.purpose.replace(/^to /i, '')}. You can accept or decline.`).join('\n')}`);
  }

  // ON YOUR MIND + YOU REMEMBER share a budget
  let budget = MEMORY_CHAR_BUDGET;
  const onMind = (c.onMyMind ?? []).map((m) => `- ${mem.resolveNames(c, m.text)}`);
  const onMindKept = [];
  for (const l of onMind) {
    if (budget - l.length < 0) break;
    budget -= l.length;
    onMindKept.push(l);
  }
  if (onMindKept.length) blocks.push(`# ON YOUR MIND\n${onMindKept.join('\n')}`);

  // WHO IS HERE
  const others = room ? citizensIn(world.citizens, room.id, { exceptId: c.id }) : [];
  // Step 6: strong feelings focus attention (the target in detail, others compressed) and add what people show.
  if (room) {
    const lines = !others.length ? null : sn.blind ? blindWhoIsHere(world, c, others) : whoIsHere(world, c, others, (o, opts) => visibleLine(world, o, c, opts)).map((l) => `- ${l}`);
    blocks.push(`# WHO IS HERE\n${lines ? lines.join('\n') : 'Nobody else is here.'}`);
  }

  // YOU REMEMBER
  const picked = retrieve(world, c, { presentIds: others.map((o) => o.id), placeId: c.location }, 5);
  const remember = [];
  for (const { memory } of picked) {
    const l = `- ${memoryLine(world, c, { ...memory, text: mem.resolveNames(c, memory.text) })}`;
    if (budget - l.length < 0) break;
    budget -= l.length;
    remember.push(l);
    collect?.recalled?.push(memory.id);
  }
  if (remember.length) blocks.push(`# YOU REMEMBER\n${remember.join('\n')}`);

  // PLACES YOU KNOW
  blocks.push(`# PLACES YOU KNOW\n${placesBlock(world, c)}`);

  // CONVERSATION
  const conv = world.conversations.of(c);
  if (conv) blocks.push(`# CONVERSATION\n${conversationBlock(world, conv, c)}`);

  // WHAT JUST HAPPENED
  const ordered = orderStimuli(world, c, [...c.thinkingInbox, ...c.inbox].sort((a, b) => a.gameTime - b.gameTime));
  let stimuli = ordered.stimuli;
  // in shock the world shrinks to the essentials
  if (sn.shock && stimuli.length > 3) stimuli = [...stimuli].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0)).slice(0, 3).sort((a, b) => a.gameTime - b.gameTime);
  blocks.push(`# WHAT JUST HAPPENED\n${stimuli.length || ordered.lead.length
    ? [...ordered.lead.map((l) => `- ${l}`), ...stimuli.map((s) => `- (${relativeTime(now - s.gameTime)}) ${mem.resolveNames(c, s.text)}`)].join('\n')
    : 'Nothing new has caught your attention.'}`);

  // Instruction (step 6: at intense levels the feeling colours it, e.g. "Your heart is pounding.")
  const clause = instructionClause(world, c);
  if (mode === 'plan') {
    blocks.push('# WHAT NOW\nPlan your day: what you intend to do, roughly when, and where. Think about what you need (food, rest), what you want, and who you need to see. Only use places you know and people you know. Call make_plan exactly once.');
  } else if (tier === 'none') {
    blocks.push(`# WHAT NOW\n${clause ? `${clause} ` : ''}Act on instinct; no need to deliberate. Call exactly one tool. If you speak: one short sentence or two, in your own words.`);
  } else {
    if (conv) {
      // Honest forgetting: GLM tends to accept whatever others claim about the shared past.
      blocks.push("# REMEMBER\nIf someone brings up something you supposedly did, said or promised, it is only true for you if it is under YOU REMEMBER or ON YOUR MIND. If it is not there, you don't remember it: say so, ask, or bluff knowingly — don't just agree.");
    }
    blocks.push(`# WHAT NOW\n${clause ? `${clause} ` : ''}Decide what you do next. Call exactly one tool. You may include a short inner thought.\n`
      + 'If you speak: one or two short sentences, like a real turn in a conversation. Say it in your own words; '
      + "don't reach for your usual pet names or sayings.");
  }
  return blocks.join('\n\n');
}

/** Blind: people are voices. Known and familiar → named by voice; otherwise only "someone". No looks, no expressions. */
function blindWhoIsHere(world, c, others) {
  const mem = world.memory;
  return others.map((o) => {
    const rel = mem.rel(c.id, o.id);
    const known = rel?.nameKnown && rel.nameConfidence >= 0.5 && rel.familiarity >= 0.5;
    const awake = o.activity.type !== 'sleeping' && o.activity.type !== 'collapsed';
    if (!awake) return '- You can hear slow breathing, or nothing at all, from someone near you.';
    return known ? `- ${o.name} (you know ${pronouns(o).poss} voice and step).` : '- Someone is here (you can hear them, but you cannot tell who).';
  });
}

function carryingBlock(world, c) {
  const O = world.objects;
  const items = O.carriedBy(c.id);
  const wearing = wearingLine(world, c); // step 7B: only when something worn is damaged or stained
  const hands = O.handsOf(c.id);
  if (!items.length) return `${hands === 0 ? "You can't use your hands." : hands === 1 ? 'You have one hand free.' : 'Nothing. Your hands are free.'}${wearing ? `\n${wearing}` : ''}`;
  const lines = items.map((o) => `- ${O.textFor(c, o)} [${O.alias(o)}]`);
  if (O.freeSlots(c.id) <= 0) lines.push('Your hands are full.');
  if (wearing) lines.push(wearing);
  return lines.join('\n');
}

function placesBlock(world, c) {
  const now = world.now;
  const home = c.home && world.rooms.has(c.home) && c.knownPlaces?.[c.home] ? c.home : null;
  // step 7A: current room and home first, then by walking time from here.
  const entries = Object.entries(c.knownPlaces ?? {}).filter(([id]) => world.rooms.has(id))
    .map(([id, k]) => ({ id, k, mins: travelMinutes(world.rooms, c.location, id, now) }))
    .sort((a, b) => {
      const rank = (e) => (e.id === c.location ? 0 : e.id === home ? 1 : 2);
      return rank(a) - rank(b) || (a.mins ?? 99) - (b.mins ?? 99) || a.id.localeCompare(b.id);
    })
    .slice(0, 12);
  if (!entries.length) return 'None yet.';
  return entries.map(({ id, k, mins }) => placeLine(world, c, id, k, mins)).join('\n');
}

// step 7A: one place, as this citizen last saw it: how far, what it offers, what has changed, when they looked.
function placeLine(world, c, id, k, mins) {
  const r = world.rooms.get(id);
  const what = k.services.length ? servicesText(k.services) : 'nothing in particular to be had, as far as you know';
  const state = knownRoomState(world, c, id);
  const here = id === c.location;
  const seen = here ? null : lastSeenPhrase(world.now, state.seenAt);
  // Tags in one bracket: where it is from here, then how they know it ('been there' only when no Last seen).
  const tags = [here ? 'you are here' : mins != null ? `${mins} min` : null];
  if (k.source === 'home') tags.push('your home');
  else if (k.source?.startsWith('told:')) tags.push(`${world.memory.nameFor(c, k.source.slice(5), { start: true })} told you about it`);
  else if (k.source === 'visited' && !seen && !here) tags.push('you have been there');
  const bits = [...state.parts];
  if (state.bed && !bits.some((b) => /^bed /.test(b))) bits.push(`bed ${state.bed}`);
  const tagText = tags.filter(Boolean).join(', ');
  return `- ${r.name}${tagText ? ` (${tagText})` : ''}: ${what}${bits.length ? ` — ${bits.join('; ')}` : ''}.${seen ? ` Last seen ${seen}.` : ''}`;
}

function ownActivity(world, c) {
  let a = c.activity;
  let interrupted = false;
  if (a.type === 'thinking') {
    a = a.detail?.interrupted ?? { type: 'idle' };
    interrupted = true;
  }
  const left = a.until != null ? Math.max(0, Math.round(a.until - world.now)) : null;
  const more = left != null ? ` (about ${left} more minute${left === 1 ? '' : 's'})` : '';
  switch (a.type) {
    case 'doing': {
      const what = a.detail?.description ?? 'something';
      const phrase = isIngPhrase(what) ? ingOrQuote(what) : `busy with "${what}"`;
      return interrupted
        ? `You were ${phrase}${more} when something caught your attention. You can carry on or do something else.`
        : `You are ${phrase}${more}.`;
    }
    case 'waiting':
      return interrupted
        ? `You were waiting${a.detail?.reason ? ` (${a.detail.reason})` : ''}${more} when something caught your attention.`
        : `You are waiting${a.detail?.reason ? ` (${a.detail.reason})` : ''}${more}.`;
    case 'talking':
      return 'You are in a conversation.';
    case 'moving':
      return `You are on your way to ${placeLabel(c, world.rooms.get(a.detail?.to))}.`;
    default:
      return 'You are not busy with anything right now.';
  }
}

// How another citizen appears to this viewer: name (if known) or look, the relationship in words, what they do.
function visibleLine(world, o, viewer, { short = false } = {}) {
  const mem = world.memory;
  const rel = mem.rel(viewer.id, o.id);
  const p = o.persona;
  const pr = pronouns(o);
  const Subj = pr.subj[0].toUpperCase() + pr.subj.slice(1);
  const be = pr.subj === 'they' ? 'are' : 'is';
  const seem = pr.subj === 'they' ? 'seem' : 'seems';

  let who;
  if (rel?.nameKnown && rel.nameConfidence >= 0.5) who = o.name + (rel.familiarity >= 2 && p.occupation ? `, the ${p.occupation}` : '');
  else if (rel?.nameKnown && rel.nameConfidence >= 0.2) who = `${cap(mem.nameFor(viewer, o.id).replace(/ \(or so you think\)$/, ''))} — you think ${pr.poss} name is ${o.name}… or something like it`;
  else who = cap(mem.nameFor(viewer, o.id)) + (rel && rel.familiarity > 0.2 ? (rel.nameKnown ? " — you've met before, but the name escapes you" : " — you've met before") : '');

  let a = o.activity;
  if (a.type === 'thinking') a = a.detail?.interrupted ?? { type: 'idle' };
  let doing;
  switch (a.type) {
    case 'doing': {
      const what = a.detail?.description ?? 'something';
      doing = isIngPhrase(what) ? `${Subj} ${be} ${ingOrQuote(what)}.` : `${Subj} ${be} busy with something ("${what}").`;
      break;
    }
    case 'waiting': doing = `${Subj} ${seem} to be waiting.`; break;
    case 'sleeping': doing = a.detail?.quality === 'rough' ? `${Subj} ${be} asleep on the ground.` : `${Subj} ${be} asleep.`; break;
    case 'collapsed': doing = `${Subj} ${be} lying on the ground, unconscious.`; break;
    case 'talking': {
      const conv = world.conversations.of(o);
      const partners = (conv?.participants ?? []).filter((id) => id !== o.id).map((id) => mem.nameFor(viewer, id)).filter(Boolean);
      doing = partners.length ? `${Subj} ${be} talking with ${listJoin(partners)}.` : `${Subj} ${be} in a conversation.`;
      break;
    }
    default: doing = `${Subj} ${be} not doing anything in particular.`;
  }
  const marks = (o.marks ?? []).filter((m) => m.until == null || m.until > world.now).map((m) => m.text);
  const look = [p.appearance || '', marks.length ? `Right now: ${marks.join('; ')}.` : '', cuesFor(world, o)].join(' '); // step 7B: visible injuries and blood
  const carrying = carryingPhrase(world, viewer, o);
  const holds = carrying ? `${Subj} ${be} ${carrying.slice(2)}.` : '';
  // Step 5.5: group tags, the reasons they could name, and wariness towards strangers.
  const line = relationLine(world, viewer, o);
  if (short) return `${who}${line.tags}. ${doing} ${holds}`.replace(/\s+/g, ' ').trim(); // frightened: neutral people shrink
  return `${who}${line.tags}. ${line.text} ${look} ${doing} ${holds}`.replace(/\s+/g, ' ').trim();
}

function conversationBlock(world, conv, c) {
  const mem = world.memory;
  const name = (id, start = false) => (id === c.id ? (start ? 'You' : 'you') : mem.nameFor(c, id, { start }));
  const others = conv.participants.filter((id) => id !== c.id).map((id) => name(id));
  const lines = [`You are in a conversation with ${listJoin(others) || 'nobody (everyone else has left)'}.`];
  const recent = conv.lines.slice(-TRANSCRIPT_LINES);
  if (conv.lines.length > recent.length) lines.push(`(${conv.lines.length - recent.length} earlier lines not shown)`);
  for (const l of recent) {
    // With more than two people it matters who a line was aimed at.
    const to = l.toId && conv.everParticipants.length > 2 ? ` (to ${name(l.toId)})` : '';
    lines.push(`${name(l.speakerId, true)}${to}: "${l.text}"`);
  }
  if (!recent.length) lines.push('Nothing has been said yet.');
  if (conv.lines.length >= SOFT_CAP_LINES) lines.push('The conversation has gone on for a while.');
  return lines.join('\n');
}

function listJoin(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
