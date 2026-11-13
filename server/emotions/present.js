// Present, don't force (step 6, §4): how emotions change what a citizen is SHOWN. Called by the prompt builder.
//
// Every effect has a threshold and only compresses, emphasises, reorders or colours. Nothing here removes
// information the citizen needs to act, removes a tool, or picks an action.
//
//   feelLines        HOW YOU FEEL: body sensations for the top 3 emotions (never numbers), mood, masking
//   moodFraming      one sentence at the top of RIGHT NOW when mood is far from the baseline
//   whoIsHere        anger: the target in detail, others compressed · fear: threats first · jealousy: the pair first
//                    envy: what they have · disgust · shame: who saw · everyone: the cues others show
//   hereNotes        sadness: reminders of the person they miss · fear: the ways out
//   orderStimuli     jealousy: the pair's interactions first · fear: threats first · joy: good things first
//   frameTools       order + a short note on descriptions for the top emotion (the set of tools is unchanged)
//   instructionClause  at intense levels (>= 7)
//   tierEffect       an intense emotion relevant to the trigger RAISES the tier; lowering only with EMOTION_PARAM_EFFECTS
import { openExits } from '../world/rooms.js';
import { placeLabel } from '../world/places.js';
import { pronounsOf } from '../memory/words.js';

const ANGER_FOCUS = 6;
const FEAR_FOCUS = 6;
const SAD_REMIND = 5;
const JEALOUS_FOCUS = 4;
const ENVY_FOCUS = 3; // the plan says 4, but a first pang is 2–4 by formula and should already draw the eye
const DISGUST_FOCUS = 5;
const SHAME_FOCUS = 5;
const JOY_FOCUS = 6;
const INTENSE = 7;

// ---------- HOW YOU FEEL ----------
/** First-person cause → second person, for the prompt ("my lantern" → "your lantern"). */
export function toSecond(text) {
  if (!text) return '';
  return String(text)
    .replace(/\bI'm\b/g, "you're").replace(/\bI've\b/g, "you've").replace(/\bI'd\b/g, "you'd").replace(/\bI'll\b/g, "you'll")
    .replace(/\bI am\b/g, 'you are').replace(/\bI was\b/g, 'you were').replace(/\bI have\b/g, 'you have')
    .replace(/\bmyself\b/gi, 'yourself').replace(/\bmine\b/gi, 'yours').replace(/\bMy\b/g, 'Your').replace(/\bmy\b/g, 'your')
    .replace(/\bme\b/g, 'you').replace(/(^|[.!?]\s+)I\b/g, '$1You').replace(/\bI\b/g, 'you');
}

function aimPhrase(world, c, e, def) {
  if (!e.target || !def.aim) return '';
  const mem = world.memory;
  const about = e.about ? (world.citizens.has(e.about) ? mem.nameFor(c, e.about) : world.objects.get(e.about) ? world.objects.surfaceText(world.objects.get(e.about)) : '') : '';
  return ` ${def.aim.replace('{target}', mem.nameFor(c, e.target)).replace('{aboutEnvy}', about ? ` with ${about}` : '').replace('{about}', about || 'someone you care about')}`;
}

export function feelLines(world, c) {
  const emo = world.emotions;
  const lines = [];
  for (const e of emo.top(c, 3, 1)) {
    const def = emo.types[e.type];
    if (!def) continue;
    const body = def.body[emo.band(e.intensity)] ?? def.body.at(-1);
    const cause = e.cause ? toSecond(world.memory.resolveNames(c, e.cause)).replace(/[.!]+$/, '') : '';
    const masked = emo.isMasked(c, e.type) ? " You're keeping it off your face." : '';
    lines.push(`${body}${aimPhrase(world, c, e, def)}${cause ? ` — ${lowerStart(cause)}` : ''}.${masked}`);
  }
  const m = emo.moodState(c);
  if (m.dir && m.lastingDays >= 2) lines.push(m.dir < 0 ? emo.moodText.lowLasting : emo.moodText.highLasting);
  else if (m.dir) lines.push(m.dir < 0 ? "You're in low spirits." : "You're in good spirits.");
  return lines.filter(Boolean);
}

export function moodFraming(world, c) {
  const emo = world.emotions;
  const m = emo.moodState(c);
  if (m.far) {
    const list = (m.dir < 0 ? emo.moodText.low : emo.moodText.high) ?? [];
    return list[Math.abs(m.diff) >= 3 ? list.length - 1 : 0] ?? null;
  }
  if (m.tense) return emo.moodText.tense?.[0] ?? null;
  return null;
}

// ---------- WHO IS HERE ----------
/**
 * @param line (o, opts) => text   the prompt builder's person line; opts.short drops looks and reasons
 * @returns lines (without the leading "- ")
 */
export function whoIsHere(world, c, others, line) {
  const emo = world.emotions;
  if (!others.length) return [];
  const mem = world.memory;
  const present = new Set(others.map((o) => o.id));
  const angry = emo.of(c).filter((e) => e.type === 'anger' && e.intensity >= ANGER_FOCUS && present.has(e.target)).sort((a, b) => b.intensity - a.intensity)[0];
  const afraid = emo.max(c, 'fear') >= FEAR_FOCUS;
  const fearOf = new Set(emo.of(c).filter((e) => e.type === 'fear' && e.target).map((e) => e.target));
  const jealous = emo.of(c).filter((e) => e.type === 'jealousy' && e.intensity >= JEALOUS_FOCUS);
  const pair = new Set(jealous.flatMap((e) => [e.target, e.about]));
  const shame = emo.strongest(c, 'shame');
  const sawIt = new Set(shame && shame.intensity >= SHAME_FOCUS ? shame.data?.witnesses ?? [] : []);
  const joyful = emo.max(c, 'joy') >= JOY_FOCUS || emo.mood(c).valence >= 2;

  const notes = (o) => {
    const out = [...emo.cuesFor(c, o)];
    const p = pronounsOf(o);
    const envy = emo.strongest(c, 'envy', o.id);
    if (envy && envy.intensity >= ENVY_FOCUS) {
      const obj = envy.about && world.objects.get(envy.about);
      const has = obj && obj.holderId === o.id ? `${world.objects.surfaceText(obj)} ${p.subj} ${p.subj === 'they' ? 'are' : 'is'} carrying` : obj ? world.objects.surfaceText(obj) : 'what you want';
      out.push(`Your eyes keep going to ${has}: ${p.subj} ${p.subj === 'they' ? 'have' : 'has'} it and you don't.`);
    }
    const disgust = emo.strongest(c, 'disgust', o.id);
    if (disgust && disgust.intensity >= DISGUST_FOCUS) out.push(`Everything about ${p.obj} grates on you: the way ${p.subj} stand${p.subj === 'they' ? '' : 's'}, the sound of ${p.poss} voice.`);
    if (sawIt.has(o.id)) out.push(`${cap(p.subj)} saw what you did.`);
    return out.length ? ` ${out.join(' ')}` : '';
  };

  // Order: who the feeling is about comes first.
  const weight = (o) => (angry?.target === o.id ? 100 : 0) + (pair.has(o.id) ? 50 : 0) + (afraid && (fearOf.has(o.id) || world.strangers.isStranger(c, o)) ? 40 : 0)
    + (joyful ? Math.max(0, mem.rel(c.id, o.id)?.affinity ?? 0) : 0);
  const sorted = others.map((o, i) => ({ o, i, w: weight(o) })).sort((a, b) => b.w - a.w || a.i - b.i).map((x) => x.o);

  const out = [];
  if (angry) {
    // The target in detail; everyone else shrinks to one line (still named, so they can still be addressed).
    const t = world.citizens.get(angry.target);
    const lastDid = [...c.thinkingInbox, ...c.inbox].filter((s) => s.sourceId === t.id).at(-1);
    out.push(`${line(t)}${notes(t)}${lastDid ? ` Just now: ${mem.resolveNames(c, lastDid.text)}` : ''} You can hardly look at anything else.`);
    const rest = sorted.filter((o) => o.id !== t.id);
    const brief = (o) => {
      const cue = emo.cuesFor(c, o)[0];
      return cue ? ` (${cue.replace(/\.$/, '').replace(`${mem.nameFor(c, o.id, { start: true })} `, '')})` : '';
    };
    if (rest.length) out.push(`Others are around; you barely register them: ${rest.map((o) => `${mem.nameFor(c, o.id)}${brief(o)}`).join(', ')}.`);
    return out;
  }
  for (const o of sorted) {
    const threat = afraid && (fearOf.has(o.id) || world.strangers.isStranger(c, o));
    // Frightened: threats in full, neutral people compressed.
    out.push(`${line(o, { short: afraid && !threat })}${notes(o)}`);
  }
  if (sawIt.size || (shame && shame.intensity >= SHAME_FOCUS)) out.push('You feel eyes on you.');
  return out;
}

// ---------- extra lines for WHAT'S HERE / RIGHT NOW ----------
export function hereNotes(world, c, room) {
  const emo = world.emotions;
  const out = { rightNow: [], whatsHere: [] };
  if (!room) return out;
  // Fear: where the ways out are.
  if (emo.max(c, 'fear') >= FEAR_FOCUS) {
    const exits = openExits(room, world.now).filter((e) => world.rooms.has(e.to));
    const threat = emo.strongest(c, 'fear');
    const threatRoom = threat?.target ? world.citizens.get(threat.target)?.location : null;
    if (exits.length) {
      out.rightNow.push(`You are very aware of the ways out: ${exits.map((e) => `${placeLabel(c, world.rooms.get(e.to))} (${e.travelMinutes} min${threatRoom && threatRoom === e.to ? ', but that is where the danger is' : ''})`).join('; ')}.`);
    } else out.rightNow.push('There is no way out of here that you can see.');
  }
  // Sadness aimed at someone: their things, their place.
  for (const e of emo.of(c)) {
    if (e.type !== 'sadness' || !e.target || e.intensity < SAD_REMIND) continue;
    const who = world.citizens.get(e.target);
    if (!who || who.location === room.id) continue;
    const name = world.memory.nameFor(c, who.id);
    const things = world.objects.perceiveRoom(c, room.id).listed.filter((it) => it.o.ownerId === who.id).slice(0, 2);
    for (const it of things) out.whatsHere.push(`- (it catches at you) ${world.objects.surfaceText(it.o)}: ${name}'s, still ${world.objects.placementPhrase(it.o) || 'here'}`);
    if (room.owner === who.id || who.home === room.id) out.rightNow.push(`This is ${name}'s place; everything in it speaks of ${pronounsOf(who).obj}.`);
  }
  return out;
}

// ---------- WHAT JUST HAPPENED ----------
/** Reorder (never drop) stimuli; returns { stimuli, lead } where lead are extra lines to put first. */
export function orderStimuli(world, c, stimuli) {
  const emo = world.emotions;
  const lead = [];
  const jealous = emo.of(c).filter((e) => e.type === 'jealousy' && e.intensity >= JEALOUS_FOCUS);
  const afraid = emo.max(c, 'fear') >= FEAR_FOCUS;
  const joyful = emo.max(c, 'joy') >= JOY_FOCUS || emo.mood(c).valence >= 2;
  if (!jealous.length && !afraid && !joyful) return { stimuli, lead };
  const pairs = jealous.map((e) => [e.target, e.about]);
  const involvesPair = (s) => pairs.some(([r, b]) => (s.sourceId === r || s.sourceId === b) && (s.data?.toId === r || s.data?.toId === b || s.data?.objectId || s.kind === 'speech'));
  const fearOf = new Set(emo.of(c).filter((e) => e.type === 'fear' && e.target).map((e) => e.target));
  const rank = (s) => (jealous.length && involvesPair(s) ? 3 : 0) + (afraid && (s.kind === 'director' || s.kind === 'signal' || fearOf.has(s.sourceId)) ? 2 : 0)
    + (joyful && s.kind === 'object' && s.data?.action === 'give' ? 1 : 0);
  const sorted = stimuli.map((s, i) => ({ s, i, r: rank(s) })).sort((a, b) => b.r - a.r || a.i - b.i).map((x) => x.s);
  // The two of them together, here and now: stated plainly (it is true), and first.
  for (const [rivalId, belovedId] of pairs) {
    const rival = world.citizens.get(rivalId);
    const beloved = world.citizens.get(belovedId);
    if (!rival || !beloved || rival.location !== c.location || beloved.location !== c.location) continue;
    const together = rival.conversationId && rival.conversationId === beloved.conversationId;
    lead.push(`(you can't help noticing) ${world.memory.nameFor(c, belovedId, { start: true })} and ${world.memory.nameFor(c, rivalId)} are ${together ? 'talking with each other' : 'both here, not far from each other'}.`);
  }
  return { stimuli: sorted, lead };
}

// ---------- tools: order and notes only ----------
/** Returns a new list with the same tools: emotion-congruent ones first, short notes on descriptions. */
export function frameTools(world, c, tools) {
  const emo = world.emotions;
  const top = emo.top(c, 3, 4).find((e) => emo.toolFraming[e.type]);
  if (!top) return tools;
  const f = emo.toolFraming[top.type];
  const first = f.first ?? [];
  const wronged = top.type === 'guilt' && top.target ? world.citizens.get(top.target) : null;
  const out = tools.map((t) => {
    const name = t.function.name;
    let note = f.notes?.[name];
    if (note && top.type === 'guilt' && !(wronged && wronged.location === c.location)) note = null; // only when the wronged person is here
    if (!note) return t;
    return { ...t, function: { ...t.function, description: `${t.function.description} (${note})` } };
  });
  if (!first.length) return out;
  const rank = (t) => {
    const i = first.indexOf(t.function.name);
    return i < 0 ? first.length : i;
  };
  return out.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map((x) => x.t);
}

export function instructionClause(world, c) {
  const emo = world.emotions;
  const top = emo.top(c, 1, INTENSE)[0];
  return top ? emo.toolFraming[top.type]?.instruction ?? null : null;
}

// ---------- tiers ----------
/**
 * An intense emotion (>= 7) relevant to what triggered the think raises the tier to full: intense moments
 * deserve real thought. Lowering (and temperature) only with EMOTION_PARAM_EFFECTS=true, off by default.
 */
export function tierEffect(world, c, stimuli) {
  const emo = world.emotions;
  const intense = emo.of(c).filter((e) => e.intensity >= INTENSE);
  const out = { raise: false, reason: null, lower: false, params: null };
  if (!intense.length) return out;
  const people = new Set(intense.flatMap((e) => [e.target, e.about]).filter(Boolean));
  const relevant = stimuli.some((s) => (s.importance ?? 0) >= 5 && (people.has(s.sourceId) || people.has(s.data?.toId) || s.kind === 'emotion' || s.kind === 'signal' || s.kind === 'notice'
    || (s.kind === 'director' && intense.some((e) => e.type === 'fear'))));
  if (relevant) {
    out.raise = true;
    out.reason = `intense ${intense[0].type}`;
  }
  if (emo.paramEffects && intense.some((e) => (e.type === 'anger' || e.type === 'fear') && e.intensity >= 8)) {
    out.lower = true;
    out.params = { temperatureDelta: 0.15 };
  }
  return out;
}

/** Top emotions with causes, for reflection and consolidation inputs. */
export function emotionsSummary(world, c, n = 4) {
  const emo = world.emotions;
  const lines = emo.top(c, n, 2).map((e) => {
    const def = emo.types[e.type];
    const body = def.body[emo.band(e.intensity)] ?? '';
    const cause = e.cause ? toSecond(world.memory.resolveNames(c, e.cause)).replace(/[.!]+$/, '') : '';
    return `- ${body}${aimPhrase(world, c, e, def)}${cause ? ` — ${lowerStart(cause)}` : ''}.`;
  });
  const m = emo.moodState(c);
  if (m.dir) lines.push(m.dir < 0 ? (m.lastingDays >= 2 ? `- ${emo.moodText.lowLasting}` : "- You're in low spirits.") : (m.lastingDays >= 2 ? `- ${emo.moodText.highLasting}` : "- You're in good spirits."));
  return lines.join('\n');
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// "Your lantern is gone" → "your lantern is gone" after a dash; names keep their capital.
function lowerStart(s) {
  return /^(You|Your|The|It|There|Something|Everyone|Everything|That|This|A|An|What|Nothing|Nobody|He|She|They|We|His|Her|Their|Someone|No one|One)\b/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}
