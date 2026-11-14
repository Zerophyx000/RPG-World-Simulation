// Step 9.5: follow (A1.1, an ordinary tool now that day plans are gone) and tell_news (B5.2).
//
// follow(person): an ongoing "following X" activity — a silent short wait while X is here, a walk after X when X leaves.
//   It ends when the citizen decides otherwise (any decision clears c.following), when X goes somewhere they can't
//   follow (or dies), or on any stimulus that triggers a decision (the scheduler wakes the follower as usual).
// tell_news(to, person, news, how_much?): spoken as a conversation line; the listeners (everyone who hears it) learn
//   the news — a death through world.deaths (believed, or doubted when they distrust the speaker), other news into
//   c.knownNews. Both sides think the next decision through (tier full).
import { citizensIn } from './rooms.js';
import { ref } from '../memory/index.js';
import { pronouns } from './citizens.js';

const FOLLOW_LOOK = 3; // game minutes between looks while staying close

export function follow(world, c, call, { stale, logAction, findPerson, remember }) {
  const here = citizensIn(world.citizens, c.location, { exceptId: c.id });
  const o = findPerson(world, c, here, call.arguments.person);
  if (!o) return stale(world, c, call, 'The person you meant to follow is not here.');
  logAction(world, c, call, { targetId: o.id });
  c.following = { id: o.id, since: world.now };
  world.perceive([o.id], (x) => ({ kind: 'action', text: `${ref(c)} falls in beside you, keeping close.`, importance: 4, sourceId: c.id, roomId: c.location }));
  remember(world, c, `You started following ${ref(o)}.`);
  stayClose(world, c, o);
  return { ok: true };
}

function stayClose(world, c, o) {
  world.setActivity(c, { type: 'waiting', until: world.now + FOLLOW_LOOK, detail: { reason: `staying close to ${world.memory.nameFor(c, o.id)}`, minutes: FOLLOW_LOOK, silent: true, following: o.id } });
}

/** A follower's look-around ended (silent wait) or they arrived: stay close, go after them, or give up. */
export function followStep(world, c, { applyAction }) {
  const f = c.following;
  if (!f) return false;
  const o = world.citizens.get(f.id);
  const lost = (why) => {
    c.following = null;
    world.setActivity(c, { type: 'idle' });
    world.perceive([c.id], { kind: 'timer', text: why, importance: 6, roomId: c.location });
    world.saveCitizen(c);
    return true;
  };
  if (!o || !o.alive) return lost(`You can't follow ${o ? ref(o) : 'them'} any more.`);
  if (o.location === c.location && o.activity.type !== 'moving') { stayClose(world, c, o); return true; }
  const dest = o.location ?? o.activity?.detail?.to ?? null;
  if (!dest || !world.rooms.has(dest)) return lost(`You lose sight of ${ref(o)}.`);
  if (dest === c.location) { stayClose(world, c, o); return true; }
  const adjacent = world.rooms.get(c.location)?.exits.some((e) => e.to === dest);
  const r = applyAction(world, c, { name: adjacent ? 'move_to' : 'travel_to', arguments: { destination: dest }, planned: true, following: o.id });
  if (!r?.ok) return lost(`${ref(o)} went where you can't follow.`);
  return true;
}

// ---------- tell_news ----------
const NEWS_TEXT = {
  died: (n, p) => `${n} is dead.`,
  badly_hurt: (n, p) => `${n} is badly hurt.`,
  missing: (n, p) => `${n} is missing — nobody knows where ${p.subj} is.`,
  found_alive: (n, p) => `${n} is alive.`,
};

export function tellNews(world, c, call, { stale, findPerson, say }) {
  const here = citizensIn(world.citizens, c.location, { exceptId: c.id });
  const to = findPerson(world, c, here, call.arguments.to);
  if (!to) return stale(world, c, call, 'The person you meant to tell is not here any more.');
  const known = world.memory.labelsFor(c, [...world.citizens.values()].filter((o) => o.id !== c.id));
  const subject = known.get(call.arguments.person) ?? [...world.citizens.values()].find((o) => o.name.toLowerCase() === String(call.arguments.person).toLowerCase());
  if (!subject) return stale(world, c, call, "You can't think who you meant.");
  const news = call.arguments.news;
  if (news === 'died' && !world.deaths.knows(c, subject.id)) return stale(world, c, call, `You don't actually know that ${world.memory.nameFor(c, subject.id)} is dead.`);
  const name = to.id === subject.id ? 'You' : (world.memory.rel(c.id, subject.id)?.nameKnown ? subject.name : 'Someone');
  const extra = String(call.arguments.how_much ?? '').trim().slice(0, 160);
  const text = `${(NEWS_TEXT[news] ?? NEWS_TEXT.died)(name, pronouns(subject))}${extra ? ` ${extra}` : ''}`;
  const volume = call.arguments.volume === 'whisper' ? 'whisper' : 'normal';
  // spoken as an ordinary line (a conversation turn), at the chosen volume
  const r = say(world, c, { ...call, name: 'say', arguments: { to: call.arguments.to, text, volume, inner_thought: call.arguments.inner_thought, ...(call.arguments.deceive ? { deceive: call.arguments.deceive } : {}) }, news: { person: subject.id, news } }); // step 11: a lie in the news is still a lie
  if (!r?.ok) return r;
  const listeners = volume === 'whisper' ? [to] : here.filter((o) => !['sleeping', 'collapsed'].includes(o.activity.type));
  const where = news === 'died' ? world.deaths.entry(c, subject.id)?.where ?? null : null;
  const told = where && extra && world.rooms.get(where) && new RegExp(world.rooms.get(where).name.replace(/^the /i, ''), 'i').test(extra) ? where : null;
  for (const o of listeners) {
    if (o.id === subject.id) continue;
    const trust = world.memory.rel(o.id, c.id)?.trust ?? 0;
    const certainty = trust < 0 ? 'doubted' : 'believed';
    if (news === 'died') world.deaths.learn(o, subject.id, { how: `told:${c.id}`, certainty, where: told, by: c.id });
    else {
      o.knownNews = { ...(o.knownNews ?? {}), [subject.id]: { news, from: c.id, at: world.now, certainty } };
      if (news === 'found_alive' && o.knownDeaths?.[subject.id]) delete o.knownDeaths[subject.id];
    }
    o.fullNextUntil = world.now + 30;
    if (news === 'died' && !told && certainty !== 'certain') {
      world.perceive([o.id], { kind: 'system', text: `If you want to be sure, you could go and see for yourself.`, importance: 3, roomId: o.location });
    }
    world.saveCitizen(o);
  }
  c.fullNextUntil = world.now + 30;
  c.knownNews = { ...(c.knownNews ?? {}), [subject.id]: { news, from: c.id, at: world.now, certainty: 'certain' } };
  world.logEvent('news', { actorId: c.id, location: c.location, to: to.id, person: subject.id, news, heardBy: listeners.map((o) => o.id) });
  world.saveCitizen(c);
  return r;
}
