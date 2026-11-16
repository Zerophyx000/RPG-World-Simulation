// Step 10: what physical acts put into a citizen's prompt (read only; names as ref tokens, resolved by the caller).
//
//   ALTERCATION     who's involved, sides, each one's visible state, the last exchanges, and their OWN intent
//   WHAT YOU'VE DONE  the actor's deeds (consequences.deedLines), 6 game hours — 3 days when serious
//   body lines      lying on the floor, held, pinned, tied, choking, dazed, winded, soaked, smoke
//   darkness        a night room with no light: little to be seen
import { ref } from '../memory/index.js';
import { pronouns } from '../world/citizens.js';
import { AGGRESSIVE } from './altercations.js';
import { isDark } from './profile.js';

const EX_VERB = {
  shove: 'shoves', grab: 'grabs', slap: 'slaps', punch: 'punches', kick: 'kicks', strike: 'hits', throw_at: 'throws something at', snatch: 'snatches from', pin_down: 'pins down',
  choke: 'chokes', tie_up: 'ties up', drag: 'drags', dodge: 'dodges', block: 'blocks', break_free: 'breaks free of', yield: 'gives up to', plead: 'pleads with', pull_away: 'pulls away from',
  embrace: 'holds', hold_hand: 'holds the hand of', comfort: 'comforts', help_up: 'helps up', support: 'supports', hold_back: 'holds back', free: 'unties',
};

const EX_YOU = {
  shove: 'shove', grab: 'grab', slap: 'slap', punch: 'punch', kick: 'kick', strike: 'hit', throw_at: 'throw something at', snatch: 'snatch from', pin_down: 'pin down',
  choke: 'choke', tie_up: 'tie up', drag: 'drag', dodge: 'dodge', block: 'block', break_free: 'break free of', yield: 'give up to', plead: 'plead with', pull_away: 'pull away from',
  embrace: 'hold', hold_hand: 'hold the hand of', comfort: 'comfort', help_up: 'help up', support: 'support', hold_back: 'hold back', free: 'untie',
};

export function altercationBlock(world, c) {
  const alt = world.altercations?.of(c);
  if (!alt) return null;
  const A = world.altercations;
  const mine = A.part(alt, c.id);
  const who = (p) => {
    const o = world.citizens.get(p.id);
    if (!o) return null;
    const st = A.stateWords(o);
    return `${ref(o)}${st.length ? ` (${st.join(', ')})` : ''}`;
  };
  const lines = [];
  const mySide = alt.participants.filter((p) => p.side === mine.side && p.id !== c.id).map(who).filter(Boolean);
  const other = alt.participants.filter((p) => p.side !== mine.side).map(who).filter(Boolean);
  const myState = A.stateWords(c).filter((s) => !/^holding/.test(s));
  lines.push(`A fight in ${world.rooms.get(alt.roomId)?.name ?? 'here'}, ${Math.max(1, Math.round(world.now - alt.startedAt))} minute${Math.round(world.now - alt.startedAt) > 1 ? 's' : ''} so far.`);
  lines.push(`Against you: ${other.join(', ') || 'nobody now'}.${mySide.length ? ` With you: ${mySide.join(', ')}.` : ''}`);
  if (myState.length) lines.push(`You: ${myState.join(', ')}.`);
  const recent = alt.exchanges.slice(-5);
  if (recent.length) {
    lines.push('Just now:');
    for (const e of recent) {
      const actor = e.actor === c.id ? 'You' : ref(world.citizens.get(e.actor) ?? e.actor);
      const target = e.target === c.id ? 'you' : ref(world.citizens.get(e.target) ?? e.target);
      const verb = e.actor === c.id ? EX_YOU[e.action] ?? e.action.replace('_', ' ') : EX_VERB[e.action] ?? e.action;
      const res = AGGRESSIVE.includes(e.action) ? (e.hit ? (e.effects?.length ? ` — ${e.effects.filter((f) => f !== 'woken').join(', ')}` : ' — it lands') : ' — and misses') : '';
      lines.push(`- ${actor} ${verb} ${target}${res}${e.words ? `: "${e.words}"` : ''}`);
    }
  }
  // their own intent toward the one(s) they fight
  for (const p of alt.participants.filter((x) => x.side !== mine.side)) {
    const l = world.physical.consequences.intentLine(c, p.id);
    if (l) lines.push(l);
  }
  const yieldedFoe = alt.participants.find((p) => p.side !== mine.side && p.yielded);
  if (yieldedFoe) lines.push(`${ref(world.citizens.get(yieldedFoe.id) ?? yieldedFoe.id)} has given up. Going on would be beating someone who yielded.`);
  return lines.join('\n');
}

export function deedsBlock(world, c) {
  const lines = world.physical?.consequences.deedLines(c) ?? [];
  // an intent toward someone outside any fight right now
  const alt = world.altercations?.of(c);
  for (const id of Object.keys(c.intents ?? {})) {
    if (alt?.participants.some((p) => p.id === id)) continue;
    const l = world.physical.consequences.intentLine(c, id);
    if (l && (c.deeds ?? []).some((d) => d.victimId === id && d.until > world.now)) lines.push(`- ${l}`);
  }
  return lines.length ? lines.join('\n') : null;
}

/** Plain lines about their own body's physical situation (for the top of HOW YOU FEEL). */
export function physLines(world, c) {
  const p = c.phys ?? {};
  const now = world.now;
  const out = [];
  const r = p.restraint;
  if (r?.kind === 'tied') out.push('Your hands are tied; you can hardly move.');
  else if (r?.kind === 'pinned') out.push(`${ref(world.citizens.get(r.by) ?? r.by)} has you pinned to the floor.`);
  else if (r?.kind === 'held') out.push(`${ref(world.citizens.get(r.by) ?? r.by)} has hold of you${r.caring ? ', holding you back' : ''}.`);
  if ((p.asphyxia ?? 0) >= 1 && p.chokedBy) out.push(`You can't breathe — ${ref(world.citizens.get(p.chokedBy) ?? p.chokedBy)}'s hands are at your throat.`);
  if (p.prone && !r) out.push("You're on the floor.");
  if ((p.dazedUntil ?? -Infinity) > now) out.push('Your head is ringing; the room swims.');
  if ((p.windedUntil ?? -Infinity) > now) out.push("You're winded; you can barely draw breath.");
  if ((p.wetUntil ?? -Infinity) > now) out.push("You're soaked through and cold.");
  if ((p.smoke ?? 0) >= 1) out.push((p.smoke ?? 0) >= 3 ? 'The smoke is choking you; you are close to passing out.' : 'Smoke burns in your throat.');
  if (p.touchedBy && p.touchedBy.until > now) {
    const o = world.citizens.get(p.touchedBy.id);
    if (o) out.push(`${ref(o)} ${p.touchedBy.kind === 'embrace' ? 'has an arm around you' : p.touchedBy.kind === 'hold_hand' ? 'is holding your hand' : 'has a hand on you'}${p.touchedBy.welcome === false ? ', and you don\'t want it' : ''}.`);
  }
  return out;
}

export function darkLine(world, c) {
  return isDark(world, c.location) ? "It is dark in here; with no light you can make out only shapes." : null;
}

/** "You're wary of him since he attacked you." — for WHO IS HERE. */
export function waryNote(world, c, o) {
  const w = c.wary?.[o.id];
  if (!w) return null;
  return `you've been wary of ${pronouns(o).obj} since ${pronouns(o).subj} ${w.why} you`;
}
