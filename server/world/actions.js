// Action resolution: what a validated tool call does to the world, plus timers, arrivals and
// body transitions (sleep, wake, collapse, revive). Called only by World (or modules World calls),
// so World stays the single owner of state.
//
// call = { name, arguments, innerThought?, truncated? }
import { config } from '../config.js';
import { exitTo, citizensIn, activeEffects, activeServices, serviceNames, blockedExit } from './rooms.js';
import { IMPORTANCE } from './perception.js';
import { pronouns } from './citizens.js';
import { learnPlace, placeLabel, findPath, routeHint, servicesText, knows } from './places.js';
import { nowPhrase } from './time.js';
import { CRAWL_FACTOR } from '../body/content.js';
import { startTreatment, finishTreatment, startExamine, finishExamine as finishExaminePerson, refuseTreatment, acceptHelp, startCarry, putDownPerson, dropCarried, carryAlong, carryArrive, washClothes } from '../body/treat.js';
import { ref, plainRef } from '../memory/index.js';
import { fireIntent } from '../physical/handle.js';
import { tendBody, finishTend, keepVigil, endVigil, bury, finishBury, proposeGathering } from '../death/customs.js';
import { follow, followStep, tellNews } from './social-actions.js';
import {
  take, put, give, examine, search, use, finishExamine, finishSearch, finishUse, finishConceal,
  startTargetedDo, finishTargetedDo, carryingPhrase,
} from './object-actions.js';

const RECENT_ACTIONS = 6;
const SLEEP_SAFETY_CAP_MINUTES = 14 * 60;
const WOKE_EARLY_MINUTES = 20; // step A2: back down after this long if nothing urgent happens

export function applyAction(world, c, call) {
  const args = call.arguments ?? {};
  // step 8: before an action that needs proximity, code walks them there (the LLM never picks spots)
  const prox = call.arrived || !config.spots.walking ? null : proximityTarget(world, c, call);
  if (prox) {
    const moving = c.body?.capacities?.moving ?? 1;
    if (moving < 0.05) {
      if (prox.must) return stale(world, c, call, "You can't get over there.");
    } else {
      world.physical?.comingAt(c, call); // step 10: "Kael comes at you" before the blow lands
      return startWalk(world, c, call, prox);
    }
  }
  // step 7B: the body can forbid walking (also for plan steps, which call this too)
  if ((call.name === 'move_to' || call.name === 'travel_to') && (c.body?.capacities?.moving ?? 1) < 0.35) {
    return stale(world, c, call, c.body.capacities.moving < 0.05 ? "You can't move at all." : "You can't walk on those injuries; you could only crawl.");
  }
  // step 10: physical acts on people and things (server/physical/)
  if (['act_on', 'get_up', 'handle', 'force_door'].includes(call.name)) return world.physical.apply(c, call, { stale, logAction, remember, findPerson });
  // step 10: "use the cloth to smother the flames" / "do: beating out the fire" — the free-form path to the fire actions
  if ((call.name === 'use' || call.name === 'do') && world.physical) {
    const fx = fireIntent(world, c, args.object ?? args.target, args.intent ?? args.action);
    if (fx) { const r = world.physical.apply(c, { ...call, ...fx, innerThought: call.innerThought }, { stale, logAction, remember, findPerson }); if (r?.ok) return r; }
  }
  const result = applyBasic(world, c, call);
  // step 10 §5.3: help from the one who hurt you — the victim perceives it with the attack still fresh
  if (result?.ok && ['treat', 'give', 'carry_person', 'feed'].includes(call.name) && world.physical) {
    const here = citizensIn(world.citizens, c.location, { exceptId: c.id });
    let who = findPerson(world, c, here, args.to ?? args.person ?? args.who);
    if (!who && call.name === 'treat') { const m = /\[w(\d+)\]/.exec(String(args.wound ?? '')); who = m ? here.find((o) => world.body.conditionById(o.id, m[1])) : null; }
    if (who) world.physical.consequences.onCare(c, who, call.name, String(args.reason ?? '').trim() || null);
  }
  if (result?.ok && call.name === 'accept_help' && world.physical) {
    const helper = findPerson(world, c, citizensIn(world.citizens, c.location, { exceptId: c.id }), args.person ?? args.from);
    if (helper) world.physical.consequences.onAcceptedHelp(c, helper);
  }
  return result;
}

function applyBasic(world, c, call) {
  const args = call.arguments ?? {};
  switch (call.name) {
    case 'move_to': return moveTo(world, c, call);
    case 'travel_to': return travelTo(world, c, call);
    case 'crawl_to': return crawlTo(world, c, call);   // step 7B
    case 'gesture': return gesture(world, c, call);    // step 7B (mute)
    case 'treat': return startTreatment(world, c, call, { stale, logAction });
    case 'examine_person': return startExamine(world, c, call, { stale, logAction });
    case 'refuse_treatment': return refuseTreatment(world, c, call, { stale, logAction });
    case 'accept_help': return acceptHelp(world, c, call, { stale, logAction });
    case 'carry_person': {
      // step 9.5: a body is carried by lifting it (both hands; travel and effort doubled in startLeg)
      const body = world.objects.resolve(call.arguments.person);
      if (body?.typeId === 'corpse') return take(world, c, { ...call, name: 'take', arguments: { ...call.arguments, object: call.arguments.person } });
      return startCarry(world, c, call, { stale, logAction });
    }
    case 'put_down_person': return putDownPerson(world, c, call, { stale, logAction });
    case 'wash_clothes': return washClothes(world, c, call, { stale, logAction });
    case 'walk': return stale(world, c, call, 'You hesitate, unsure what you meant to do.');
    case 'say': return say(world, c, call);
    case 'tell_about_place': return tellAboutPlace(world, c, call);
    case 'do': return doAction(world, c, call);
    case 'wait': return wait(world, c, call);
    case 'eat': return eat(world, c, call);
    case 'sleep': return sleep(world, c, call);
    case 'feed': return feed(world, c, call);
    case 'leave_conversation': return leaveConversation(world, c, call);
    case 'introduce_yourself': return introduceYourself(world, c, call);
    // step 9.5: follow, news, the dead, gatherings
    case 'follow': return follow(world, c, call, { stale, logAction, findPerson, remember });
    case 'tell_news': return tellNews(world, c, call, { stale, findPerson, say });
    case 'tend_body': return tendBody(world, c, call, { stale, logAction, remember });
    case 'keep_vigil': return keepVigil(world, c, call, { stale, logAction, remember });
    case 'bury': return bury(world, c, call, { stale, logAction, remember });
    case 'propose_gathering': return proposeGathering(world, c, call, { stale, logAction, remember });
    // step 5: objects
    case 'take': return take(world, c, call);
    case 'put': return put(world, c, call);
    case 'give': return give(world, c, call);
    case 'examine': return examine(world, c, call);
    case 'search': return search(world, c, call);
    case 'use': return use(world, c, call);
    // step 5.5: parties
    case 'propose_party': return proposeParty(world, c, call);
    case 'accept_invitation': return acceptInvitation(world, c, call);
    case 'decline_invitation': return declineInvitation(world, c, call);
    case 'leave_group': return leaveGroup(world, c, call);
    // step 6
    case 'hide_feelings': return hideFeelings(world, c, call);
    default:
      return stale(world, c, { name: call.name, arguments: args }, 'You hesitate, unsure what you meant to do.');
  }
}

// ---------- moving ----------
function moveTo(world, c, call) {
  const room = world.rooms.get(c.location);
  const dest = world.rooms.get(call.arguments.destination);
  const why = cantGo(world, room, dest?.id);
  if (why) return stale(world, c, call, why(placeLabel(c, dest)));
  logAction(world, c, call);
  startLeg(world, c, dest.id, null);
  remember(world, c, `You set off from ${room.name} towards ${placeLabel(c, dest)}.`);
  return { ok: true };
}

/** step 7B: crawl_to: one adjacent place, slowly and painfully (only offered when walking is impossible). */
function crawlTo(world, c, call) {
  const room = world.rooms.get(c.location);
  const dest = world.rooms.get(call.arguments.destination);
  const why = cantGo(world, room, dest?.id);
  if (why) return stale(world, c, call, why(placeLabel(c, dest)));
  if ((c.body?.capacities?.moving ?? 1) < 0.05) return stale(world, c, call, "You try to drag yourself along, but your body will not move.");
  logAction(world, c, call, { crawl: true });
  if (c.body) c.body.vitality = Math.max(1, c.body.vitality - 1);
  startLeg(world, c, dest.id, { slow: CRAWL_FACTOR, crawl: true });
  remember(world, c, `You drag yourself out of ${room.name} towards ${placeLabel(c, dest)}.`);
  return { ok: true };
}

/** step 7B: gesture (mute): the others who can see you read it; the one gestured to is addressed. */
function gesture(world, c, call) {
  const text = String(call.arguments.text ?? '').trim().replace(/[.!]+$/, '').slice(0, 80);
  if (!text) return stale(world, c, call, 'You wave your hands, but you cannot think how to show what you mean.');
  const present = citizensIn(world.citizens, c.location, { exceptId: c.id });
  const to = call.arguments.to ? findPerson(world, c, present, call.arguments.to) : null;
  logAction(world, c, call, { toId: to?.id ?? null });
  const watchers = present.filter((o) => o.activity.type !== 'sleeping' && o.activity.type !== 'collapsed' && !(o.body?.status ?? []).includes('blind'));
  world.perceive(watchers.map((o) => o.id), (o) => ({
    kind: 'action', text: `${ref(c)} gestures${to ? ` to ${o.id === to.id ? 'you' : ref(to)}` : ''}: ${text}.`,
    importance: to && o.id === to.id ? 6 : 4, sourceId: c.id, roomId: c.location, data: to && o.id === to.id ? { interrupt: true, addressed: true } : {},
  }));
  remember(world, c, `You gesture: ${text}.`);
  world.setActivity(c, { type: 'waiting', until: world.now + 1, detail: { reason: 'gesturing', minutes: 1 } });
  return { ok: true };
}

/** travel_to: code finds the route (BFS) and walks it room by room. */
function travelTo(world, c, call) {
  const dest = world.rooms.get(call.arguments.destination);
  if (!dest || !knows(c, dest.id)) return stale(world, c, call, "You realise you don't actually know how to get there.");
  if (dest.id === c.location) return stale(world, c, call, `You're already at ${dest.name}.`);
  const path = findPath(world.rooms, c.location, dest.id, world.now);
  if (!path) return stale(world, c, call, `You can't find a way to ${dest.name} from here right now.`);
  logAction(world, c, call, { route: path });
  startLeg(world, c, path[0], { finalDest: dest.id, route: path.slice(1), tripStart: world.now });
  remember(world, c, `You set off for ${dest.name}${path.length > 1 ? ` (by way of ${path.slice(0, -1).map((id) => world.rooms.get(id)?.name).join(', ')})` : ''}.`);
  return { ok: true };
}

// A function (label) => reason text if the exit can't be used now, else null.
function cantGo(world, room, toId) {
  if (!room || !toId) return () => "You can't get there from here.";
  if (!room.exits.some((e) => e.to === toId)) return (label) => `You start to head for ${label}, but you can't get there from here.`;
  const b = blockedExit(room, toId, world.now);
  if (b) return (label) => `The way to ${label} is blocked${b.reason ? `: ${b.reason}` : ''}.`;
  // step 9.5: a barred door keeps everyone outside out; those inside have to unbar it first
  const barred = world.maps.barredBetween?.(room.id, toId);
  if (barred) {
    return barred.insideRoom === room.id
      ? () => `The door is barred; you would have to unbar it first.`
      : () => 'The door is barred from the inside.';
  }
  // step 10: a locked door blocks both ways (its key unlocks it); furniture pushed against it blocks from outside
  const between = world.maps.doorBetween?.(room.id, toId);
  if (between) {
    const { door, insideRoom } = between;
    if (door.state === 'locked') return () => (insideRoom === room.id ? 'The door is locked; you would need its key.' : 'The door is locked.');
    const blocking = world.objects.inRoom(insideRoom).filter((x) => x.data?.barricade === door.id);
    if (blocking.length) {
      return insideRoom === room.id
        ? () => `${blocking.map((x) => world.objects.surfaceText(x)).join(' and ')} ${blocking.length > 1 ? 'are' : 'is'} pushed against the door; you would have to move ${blocking.length > 1 ? 'them' : 'it'} first.`
        : () => "The door won't give: something heavy is pushed against it from the inside.";
    }
  }
  return null;
}

/** One leg of a walk: leave this room, be on the road for the exit's travel time. */
function startLeg(world, c, toId, trip) {
  const room = world.rooms.get(c.location);
  const exit = exitTo(room, toId);
  const dest = world.rooms.get(toId);
  const carryingBody = world.objects.carriedBy(c.id).some((o) => o.typeId === 'corpse'); // step 9.5
  const carrying = Boolean(c.carryingPerson) || carryingBody;
  const minutes = exit.travelMinutes * (trip?.slow ?? 1) * (carrying ? 2 : 1); // step 7B: crawling and carrying take longer
  if (c.carryingPerson) carryAlong(world, c, toId);
  world.body?.onMove(c, { crawl: Boolean(trip?.crawl), toId });
  if (c.conversationId) world.conversations.leave(c, { reason: 'moved' });
  world.objects.snapshotRoom(c, room.id); // the baseline for noticing changes next time
  for (const f of citizensIn(world.citizens, room.id, { exceptId: c.id })) {
    if (f.activity.type === 'waiting' && f.activity.detail?.following === c.id) f.activity.until = Math.min(f.activity.until ?? Infinity, world.now + 1);
  }
  const others = citizensIn(world.citizens, room.id, { exceptId: c.id });
  world.perceive(others.map((o) => o.id), (o) => ({
    kind: 'depart', text: `${ref(c)} leaves for ${placeLabel(o, dest)}${carryingPhrase(world, o, c)}.`, importance: IMPORTANCE.arriveDepart,
    sourceId: c.id, roomId: room.id, data: { to: dest.id },
  }));
  const fromSpot = c.spot ?? null;
  c.spot = null;
  world.hooks.onTripStart?.(c, { kind: 'room', fromRoom: room.id, fromSpot, toRoom: dest.id, toSpot: world.maps.entrySpot(dest.id, room.id), minutes });
  world.setActivity(c, {
    type: 'moving',
    until: world.now + minutes,
    // Stimuli already in the inbox don't count as "something happened on the way".
    detail: { from: room.id, to: dest.id, travelMinutes: minutes, legStart: world.now, fromSpot, seen: c.inbox.map((s) => s.id), ...(trip ?? {}) },
  });
}

export function arrive(world, c) {
  const d = c.activity.detail ?? {};
  const dest = world.rooms.get(d.to) ?? world.rooms.get(d.from) ?? world.rooms.values().next().value;
  const origin = world.rooms.get(d.from);
  c.location = dest.id;
  c.spot = world.maps.entrySpot(dest.id, origin?.id ?? null); // step 8: through the door they came by
  world.hooks.onTrip?.(c, { kind: 'room', fromRoom: origin?.id ?? null, fromSpot: d.fromSpot ?? null, toRoom: dest.id, toSpot: c.spot });
  if (d.crawl && c.needs) c.needs.fatigue = Math.min(100, c.needs.fatigue + 2 * 6.5 * ((d.travelMinutes ?? 0) / 60)); // crawling tires three times as fast
  if (c.carryingPerson) {
    if (c.needs) c.needs.fatigue = Math.min(100, c.needs.fatigue + 6.5 * ((d.travelMinutes ?? 0) / 60)); // carrying someone doubles the effort
    carryArrive(world, c);
  } else if (c.needs && world.objects.carriedBy(c.id).some((o) => o.typeId === 'corpse')) {
    c.needs.fatigue = Math.min(100, c.needs.fatigue + 6.5 * ((d.travelMinutes ?? 0) / 60)); // step 9.5: so does carrying the dead
  }
  learnPlace(c, dest.id, serviceNames(dest, world.now), 'visited', world.now); // being there teaches everything
  world.setActivity(c, { type: 'idle' });
  // Objects: diff what they see against the last time they were here ("fewer flour sacks than this morning").
  const notice = world.objects.arrive(c, dest.id);
  if (notice) world.perceive([c.id], notice);
  // Step 5.5: first impressions of whoever is here, and warning signs (followed, intruder, your property).
  world.memory.seeRoom(dest.id);
  world.signals.onArrive(c, dest.id);
  world.emotions.appraisal.onArrive(c, dest.id); // jealousy (two people alone together), envy (what people carry)

  const others = citizensIn(world.citizens, dest.id, { exceptId: c.id });
  world.perceive(others.map((o) => o.id), (o) => ({
    kind: 'arrive',
    text: origin ? `${ref(c)} walks in from ${placeLabel(o, origin)}${carryingPhrase(world, o, c)}.` : `${ref(c)} walks in${carryingPhrase(world, o, c)}.`,
    importance: IMPORTANCE.arriveDepart, sourceId: c.id, roomId: dest.id, data: { from: origin?.id ?? null },
  }));
  world.logEvent('arrive', { actorId: c.id, location: dest.id, from: origin?.id ?? null, ...(d.finalDest ? { finalDest: d.finalDest } : {}) });

  // Lasting effects (smoke, rubble...) are what make director events real for latecomers.
  const effects = activeEffects(dest, world.now).map((e) => e.text);
  const svc = activeServices(dest, world.now);
  const offers = Object.keys(svc).length ? ` You can see you could get ${servicesText(Object.keys(svc))} here.` : '';

  // Multi-room trip: carry on unless something important (>= 7) happened since this leg started.
  if (d.finalDest && d.finalDest !== dest.id) {
    const seen = new Set(d.seen ?? []);
    const urgent = c.inbox.some((s) => s.importance >= 7 && !seen.has(s.id));
    const next = d.route?.[0];
    const why = next ? cantGo(world, dest, next) : () => 'You lose the way.';
    if (!urgent && next && !why) {
      startLeg(world, c, next, { finalDest: d.finalDest, route: d.route.slice(1), tripStart: d.tripStart });
      return;
    }
    const final = world.rooms.get(d.finalDest);
    world.perceive([c.id], {
      kind: 'arrive',
      text: urgent
        ? `You stop at ${dest.name} on your way to ${final?.name ?? 'where you were going'}.${offers}`
        : `You reach ${dest.name}, but ${why(placeLabel(c, world.rooms.get(next))).replace(/^The/, 'the')}`,
      importance: IMPORTANCE.timer, sourceId: c.id, roomId: dest.id,
    });
    return;
  }
  world.perceive([c.id], {
    kind: 'arrive',
    text: [`You arrive at ${dest.name}.`, dest.description, effects.length ? `You notice: ${effects.join(' ')}` : '', offers.trim()]
      .filter(Boolean).join(' '),
    importance: effects.length ? IMPORTANCE.timer : IMPORTANCE.arriveDepart,
    sourceId: c.id, roomId: dest.id, data: { from: origin?.id ?? null },
  });
  if (c.following) followStep(world, c, { applyAction }); // step 9.5: still following someone: stay close
}

/** Director "move": put a citizen somewhere instantly (not walking). */
export function relocate(world, c, toId, { text = null } = {}) {
  const dest = world.rooms.get(toId);
  if (!dest) return false;
  world.cancelThink(c);
  if (c.conversationId) world.conversations.leave(c, { reason: 'moved' });
  const from = c.location;
  if (from) world.objects.snapshotRoom(c, from);
  if (from) {
    world.perceive(citizensIn(world.citizens, from, { exceptId: c.id }).map((o) => o.id), {
      kind: 'depart', text: `${ref(c)} is suddenly gone.`, importance: 5, sourceId: c.id, roomId: from,
    });
  }
  world.perceive(citizensIn(world.citizens, dest.id, { exceptId: c.id }).map((o) => o.id), {
    kind: 'arrive', text: `${ref(c)} is suddenly here.`, importance: 5, sourceId: c.id, roomId: dest.id,
  });
  c.location = dest.id;
  const before = { room: c.location, spot: c.spot };
  c.spot = world.maps.startSpot(dest.id); // step 8: a director move puts them at the room's default spot
  world.hooks.onTrip?.(c, { kind: 'teleport', fromRoom: before.room ?? null, fromSpot: before.spot ?? null, toRoom: dest.id, toSpot: c.spot });
  learnPlace(c, dest.id, serviceNames(dest, world.now), 'visited', world.now);
  const notice = world.objects.arrive(c, dest.id);
  world.memory.seeRoom(dest.id);
  world.signals.onArrive(c, dest.id, { walked: false });
  const keep = c.activity.type === 'sleeping' || c.activity.type === 'collapsed';
  if (!keep) world.setActivity(c, { type: 'idle' });
  else world.saveCitizen(c);
  world.perceive([c.id], {
    kind: 'director', text: text ?? `You find yourself in ${dest.name}. ${dest.description}`, importance: 6, roomId: dest.id,
  });
  if (notice) world.perceive([c.id], notice);
  return true;
}

// ---------- say / tell_about_place ----------
// opts.released: a held line whose reading floor has passed (so it must not be held again)
function say(world, c, call, { released = false } = {}) {
  const args = call.arguments;
  const text = String(args.text ?? '').trim();
  const room = world.rooms.get(c.location);
  if (!room) return stale(world, c, call, 'You open your mouth, but you are not anywhere anyone could hear you.');
  const present = citizensIn(world.citizens, c.location, { exceptId: c.id });
  let addressee = null;
  if (args.to) {
    addressee = findPerson(world, c, present, args.to);
    if (!addressee) {
      const gone = findByName([...world.citizens.values()], args.to);
      const p = pronouns(gone);
      const who = gone?.name ?? args.to;
      return stale(world, c, call,
        `You turn to speak to ${who}, but ${p.subj} ${p.subj === 'they' ? "aren't" : "isn't"} here any more.`);
    }
    if (!canHear(addressee)) {
      return stale(world, c, call, `You turn to ${ref(addressee)}, but ${pronouns(addressee).subj} ${addressee.activity.type === 'collapsed' ? 'is unconscious' : 'is fast asleep'}.`);
    }
  }

  // Reading floor: the previous line in this conversation is still being "read". Queue this one.
  const target = world.conversations.targetFor(c, addressee);
  if (!released && world.conversations.isFloorBusy(target)) {
    world.conversations.hold(target, c, call);
    world.setActivity(c, { type: 'talking', detail: { conversationId: target.id, held: true } });
    return { ok: true, held: true };
  }

  const volume = ['whisper', 'shout'].includes(args.volume) ? args.volume : 'normal';
  const ev = logAction(world, c, call, { toId: addressee?.id ?? null, ...(volume !== 'normal' ? { volume } : {}) });
  const rec = speak(world, c, text, addressee, present, room, { thought: call.innerThought, eventId: ev.id, volume });
  // Names: listeners learn the speaker's name if they say it, and overhear the addressee's (only those who heard the words).
  const hearers = present.filter((o) => canHear(o) && heardWords(world, c, o, volume, addressee));
  world.memory.hearSpeech(c, text, addressee, hearers);
  world.deaths?.onSpeech(c, text, hearers); // step 9.5: "she's dead — no breath in her" tells whoever hears it
  // step 10: what they now mean toward the one they speak to ("none" lets it go)
  if (addressee && args.intent && world.physical) {
    if (args.intent === 'none') { if (c.intents?.[addressee.id]) { delete c.intents[addressee.id]; world.logEvent('intent', { actorId: c.id, location: c.location, targetId: addressee.id, intent: null }); } }
    else world.physical.consequences.setIntent(c, addressee, args.intent);
  }
  if (call.introduce) for (const o of hearers) world.memory.learnName(o.id, c.id, 1);
  if ((call.teach || call.introduce) && rec?.conv) {
    rec.conv.flags ??= {};
    const learners = call.teach ? (addressee ? [addressee.id] : []) : present.filter(canHear).map((o) => o.id);
    rec.conv.flags.learned = [...new Set([...(rec.conv.flags.learned ?? []), ...learners])];
  }

  // tell_about_place: the listener learns the place once the line is actually spoken.
  if (call.teach && addressee) {
    const changed = learnPlace(addressee, call.teach.placeId, call.teach.services, `told:${c.id}`, world.now);
    world.saveCitizen(addressee);
    if (changed) world.logEvent('learn_place', { actorId: addressee.id, location: room.id, placeId: call.teach.placeId, services: call.teach.services, from: c.id });
  }

  // The speaker waits for an answer if they are in a conversation, otherwise is free again.
  if (c.conversationId) world.setActivity(c, { type: 'talking', detail: { conversationId: c.conversationId } });
  else world.setActivity(c, { type: 'idle' });
  remember(world, c, addressee ? `You said to ${ref(addressee)}: "${text}"` : `You said: "${text}"`);

  if (!present.some(canHear)) {
    world.perceive([c.id], { kind: 'system', text: "No one answers. You're alone here.", importance: 4, roomId: room.id });
  }
  world.conversations.enforceCap(rec?.conv ?? null);
  return { ok: true };
}

/** tell_about_place: a spoken line generated from what the speaker knows; the listener learns it. */
function tellAboutPlace(world, c, call) {
  const { to, place, comment } = call.arguments;
  const room = world.rooms.get(place);
  const known = c.knownPlaces?.[place];
  if (!room || !known) return stale(world, c, call, "You start to explain, but realise you don't really know that place.");
  const services = known.services;
  const parts = [
    `${room.name}: ${services.length ? `you can get ${servicesText(services)} there.` : 'nothing much to be had there, as far as I know.'}`,
    routeHint(world.rooms, c.location, place, world.now),
    comment ? String(comment).trim() : '',
  ].filter(Boolean);
  const text = parts.join(' ');
  return say(world, c, {
    ...call,
    arguments: { to, place, ...(comment ? { comment } : {}), text },
    teach: { placeId: place, services },
  });
}

/** A held line's floor has passed: speak it now (re-validated against the current room). */
export function applyHeldSay(world, held) {
  const c = world.citizens.get(held.citizenId);
  if (!c || !c.alive) return;
  return say(world, c, held.call, { released: true });
}

function canHear(o) {
  return o.activity?.type !== 'sleeping' && o.activity?.type !== 'collapsed';
}

// Records the line in a conversation (if any) and makes everyone in the room perceive it.
/** Do the words reach this listener? (whispers only at the same spot; the addressee always hears) */
function heardWords(world, c, o, volume, addressee) {
  if (addressee && o.id === addressee.id) return true;
  if (volume === 'whisper') return world.maps.distance(c.location, c.spot, o.spot) === 0;
  return true;
}

function speak(world, c, text, addressee, present, room, { thought = null, eventId = null, volume = 'normal' } = {}) {
  const rec = world.conversations.recordLine(c, text, addressee, { thought, eventId, volume });
  const toId = rec?.toId ?? null;
  const target = toId ? world.citizens.get(toId) : null;
  const cutIn = new Set(rec?.cutIn ?? []);
  if (volume === 'shout') shoutNextDoor(world, c, text, room);
  world.perceive(present.map((o) => o.id), (o) => {
    const cls = world.maps.distanceClass(room.id, c.spot, o.spot);
    if (o.id !== toId && volume === 'whisper' && cls !== 'same') {
      // too quiet to hear: they see it happen (near: that it was a whisper; across: only that they are talking)
      return cls === 'near'
        ? { kind: 'action', text: `${ref(c)} whispers something${target ? ` to ${ref(target)}` : ''}.`, importance: 3, sourceId: c.id, roomId: room.id, data: { whisper: true } }
        : { kind: 'action', text: `${ref(c)} is talking quietly${target ? ` with ${ref(target)}` : ''}.`, importance: 2, sourceId: c.id, roomId: room.id, data: { whisper: true } };
    }
    if (o.id === toId) {
      return {
        kind: 'speech', text: `${ref(c)} says to you: "${text}"`, importance: IMPORTANCE.spokenTo,
        sourceId: c.id, roomId: room.id,
        // Explicitly addressed speech may interrupt a think; implicit turns in a conversation only wake.
        data: { addressed: true, wake: true, interrupt: Boolean(addressee), conversationId: rec?.conv.id ?? null },
      };
    }
    const verb = volume === 'shout' ? 'shouts' : volume === 'whisper' ? 'whispers' : 'says';
    return {
      kind: 'speech',
      text: target ? `${ref(c)} ${verb} to ${ref(target)}: "${text}"` : `${ref(c)} ${verb}: "${text}"`,
      importance: Math.max(1, IMPORTANCE.speechInRoom - (volume === 'normal' && cls === 'across' ? 1 : 0)),
      sourceId: c.id, roomId: room.id,
      data: { addressed: false, wake: cutIn.has(o.id), conversationId: rec?.conv.id ?? null, toId },
    };
  });
  return rec;
}

/** A shout carries into the neighbouring rooms, as words from somewhere else. */
function shoutNextDoor(world, c, text, room) {
  for (const exit of room.exits ?? []) {
    const next = world.rooms.get(exit.to);
    if (!next) continue;
    world.perceive(citizensIn(world.citizens, next.id).map((o) => o.id), {
      kind: 'action', text: `${ref(c)} is shouting from ${room.name}: "${text}"`, importance: 7,
      sourceId: c.id, roomId: next.id, data: { shout: true, fromRoom: room.id },
    });
  }
}

// ---------- spots: walking to what an action needs (step 8) ----------
/** → { spot, must } | null: the spot an action has to be done at, when it is not where the citizen stands. */
function proximityTarget(world, c, call) {
  const a = call.arguments ?? {};
  const room = c.location;
  const M = world.maps;
  if (!room || !M.has(room) || !c.spot || !M.spot(room, c.spot)) return null;
  const here = citizensIn(world.citizens, room, { exceptId: c.id });
  const person = (label) => (label ? findPerson(world, c, here, label) : null);
  const obj = (token) => {
    const o = token ? world.objects.resolve(token) : null;
    return o && !o.holderId && o.roomId === room ? o : null;
  };
  let spot = null; let must = true;
  switch (call.name) {
    case 'say': case 'tell_about_place': case 'introduce_yourself': { const p = person(a.to); spot = p?.spot ?? null; must = false; break; }
    case 'give': spot = person(a.to)?.spot ?? null; break;
    case 'feed': spot = person(a.who)?.spot ?? null; break;
    case 'examine_person': case 'carry_person': spot = person(a.person)?.spot ?? null; break;
    case 'treat': {
      const m = /\[w(\d+)\]/.exec(String(a.wound ?? ''));
      const patient = m ? here.find((o) => world.body.conditionById(o.id, m[1])) : null;
      spot = patient && patient !== c ? patient.spot : null;
      break;
    }
    case 'take': case 'use': case 'examine': { const o = obj(a.object); spot = o ? M.objectSpot(o) : null; break; }
    case 'tend_body': case 'keep_vigil': { const o = obj(a.body); spot = o ? M.objectSpot(o) : null; break; } // step 9.5
    case 'follow': case 'tell_news': { const p = person(a.to ?? a.person); spot = p?.spot ?? null; must = false; break; }
    case 'act_on': { if (a.action === 'throw_at' || a.action === 'yield' || a.action === 'plead') return null; const p = person(a.person); spot = p?.spot ?? null; break; } // step 10
    case 'handle': { if (a.action === 'throw' || a.action === 'pour') return null; const o = obj(a.object); spot = o ? M.objectSpot(o) : null; must = false; break; }
    case 'search': { const o = obj(a.target); spot = o ? M.objectSpot(o) : null; break; }
    case 'put': { const o = obj(a.anchor); spot = o ? M.objectSpot(o) : null; break; }
    case 'do': case 'wait': {
      const o = call.name === 'do' ? obj(a.target) : null;
      spot = a.spot && M.spot(room, a.spot) ? a.spot : o ? M.objectSpot(o) : null;
      must = false;
      break;
    }
    case 'eat': spot = activeServices(world.rooms.get(room), world.now).food ? M.serviceSpot(room, 'food') : null; must = false; break;
    case 'sleep': spot = activeServices(world.rooms.get(room), world.now).bed ? M.serviceSpot(room, 'bed') : null; must = false; break;
    default: return null;
  }
  return spot && spot !== c.spot ? { spot, must } : null;
}

function startWalk(world, c, call, { spot }) {
  const room = c.location;
  const minutes = world.maps.walkMinutes(room, c.spot, spot, c.body?.capacities?.moving ?? 1);
  const label = world.maps.label(room, spot) ?? 'there';
  world.logEvent('walk', { actorId: c.id, location: room, from: c.spot, to: spot, minutes: Math.round(minutes * 100) / 100, for: call.name });
  world.hooks.onTripStart?.(c, { kind: 'spot', fromRoom: room, fromSpot: c.spot, toRoom: room, toSpot: spot, minutes });
  world.setActivity(c, {
    type: 'doing', until: world.now + minutes,
    detail: { kind: 'walk', description: `walking over to ${label}`, minutes, fromSpot: c.spot, toSpot: spot, call: { name: call.name, arguments: call.arguments, innerThought: call.innerThought, planned: call.planned, introduce: call.introduce, teach: call.teach, truncated: call.truncated, ...(call.callIds?.length ? { callIds: call.callIds } : {}) } },
  });
  return { ok: true, walking: true };
}

function finishWalk(world, c, a) {
  const d = a.detail;
  const fromSpot = c.spot;
  c.spot = d.toSpot;
  world.hooks.onTrip?.(c, { kind: 'spot', fromRoom: c.location, fromSpot, toRoom: c.location, toSpot: d.toSpot });
  if (c.carryingPerson) { const p = world.citizens.get(c.carryingPerson); if (p) p.spot = d.toSpot; }
  world.setActivity(c, { type: 'idle' });
  // the action now happens, and re-validates as usual (the target may have moved meanwhile)
  if (d.call) applyAction(world, c, { ...d.call, arrived: true });
}

// ---------- do / wait ----------
function doAction(world, c, call) {
  const action = cleanDoing(String(call.arguments.action ?? ''), c);
  const minutes = call.arguments.minutes;
  const cleaned = { ...call, arguments: { ...call.arguments, action } };
  // Optional target object: the keeper may change its state when the work is done (§5.2).
  const tok = call.arguments.target;
  const target = tok ? world.objects.resolve(tok) : null;
  const reachable = target && (target.holderId === c.id || (target.roomId === c.location && world.objects.perceivedIds(c).has(target.id)));
  logAction(world, c, cleaned, reachable ? { objectId: target.id } : {});
  const token = `do${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  world.setActivity(c, {
    type: 'doing', until: world.now + minutes,
    detail: { description: action, minutes, ...(reachable ? { targetId: target.id, token } : {}) },
  });
  if (reachable) startTargetedDo(world, c, target, action, minutes);
  const others = citizensIn(world.citizens, c.location, { exceptId: c.id });
  // Conversation partners waiting for an answer get their turn back (wake), others just see it.
  world.perceive(others.map((o) => o.id), (o) => ({
    kind: 'action', text: `${describeDoing(ref(c), action)}.`, importance: IMPORTANCE.visibleAction,
    sourceId: c.id, roomId: c.location, data: { action, wake: sameConversation(c, o) },
  }));
  remember(world, c, `You started ${ingOrQuote(action)} (planned ${minutes} min).`);
  return { ok: true };
}

function wait(world, c, call) {
  const args = call.arguments;
  const reason = String(args.reason ?? '').trim();
  logAction(world, c, call);
  world.setActivity(c, { type: 'waiting', until: world.now + args.minutes, detail: { reason, minutes: args.minutes } });
  // Silence is an answer too: conversation partners notice and get their turn back.
  const conv = world.conversations.of(c);
  if (conv) {
    world.perceive(conv.participants.filter((id) => id !== c.id), {
      kind: 'action', text: `${ref(c)} says nothing for now.`, importance: 4,
      sourceId: c.id, roomId: c.location, data: { wake: true, conversationId: conv.id },
    });
  }
  remember(world, c, `You decided to wait (${reason || 'no particular reason'}).`);
  return { ok: true };
}

function sameConversation(a, b) {
  return Boolean(a.conversationId && a.conversationId === b.conversationId);
}

// ---------- eat / sleep / feed ----------
function eat(world, c, call) {
  const food = activeServices(world.rooms.get(c.location), world.now).food;
  if (!food) return stale(world, c, call, "You look around for something to eat, but there's nothing to be had here.");
  if (world.stock && !world.stock.take(c.location, 'food')) return stale(world, c, call, 'The shelves are empty. There is nothing left to eat here.'); // step 9.5
  logAction(world, c, call);
  world.setActivity(c, {
    type: 'doing',
    until: world.now + food.minutes,
    detail: { description: `eating ${food.description}`, minutes: food.minutes, kind: 'eat', hungerRelief: food.hungerRelief },
  });
  world.perceive(citizensIn(world.citizens, c.location, { exceptId: c.id }).map((o) => o.id), (o) => ({
    kind: 'action', text: `${ref(c)} sits down and eats.`, importance: IMPORTANCE.visibleAction,
    sourceId: c.id, roomId: c.location, data: { wake: sameConversation(c, o) },
  }));
  remember(world, c, `You sat down to eat ${food.description}.`);
  return { ok: true };
}

/** Hunger relief for a meal: full on completion, partial if it was interrupted. */
export function finishMeal(world, c, activity, { completed }) {
  const d = activity.detail ?? {};
  const total = Math.max(1, (activity.until ?? world.now) - activity.since);
  const frac = completed ? 1 : Math.min(1, Math.max(0, (world.now - activity.since) / total));
  const relief = Math.round((d.hungerRelief ?? 0) * frac * (world.deaths?.mealFactor(c) ?? 1)); // step 9.5: grief takes the appetite
  if (relief <= 0) return 0;
  c.needs.hunger = Math.max(0, c.needs.hunger - relief);
  world.logEvent('meal', { actorId: c.id, location: c.location, relief, completed, hunger: Math.round(c.needs.hunger) });
  return relief;
}

function sleep(world, c, call) {
  const room = world.rooms.get(c.location);
  const bed = activeServices(room, world.now).bed;
  const hours = call.arguments.hours;
  const untilRested = hours ? false : call.arguments.until_rested !== false;
  logAction(world, c, call, { quality: bed ? bed.quality : 'rough' });
  startSleep(world, c, { quality: bed ? bed.quality : 'rough', untilRested, hours, bed: bed?.description ?? null });
  remember(world, c, bed ? `You lay down to sleep (${bed.description}).` : 'You curled up on the cold ground to sleep.');
  return { ok: true };
}

/** Fall asleep (by choice, forced by exhaustion, or by the director). */
export function startSleep(world, c, { quality = 'rough', untilRested = true, hours = null, bed = null, forced = false } = {}) {
  if (c.carryingPerson) dropCarried(world, c, 'dropped');
  landIfWalking(world, c);
  if (c.conversationId) world.conversations.leave(c, { reason: 'left' });
  const until = world.now + (hours ? hours * 60 : SLEEP_SAFETY_CAP_MINUTES);
  world.setActivity(c, { type: 'sleeping', until, detail: { quality, untilRested, hours: hours ?? null, bed, forced, startedAt: world.now } });
  // step A2: no leftover "(still)" noise — pending body reminders die with sleep (a live need speaks again).
  c.inbox = c.inbox.filter((s) => s.kind !== 'body');
  c.wokeEarly = null;
  world.saveCitizen(c);
  const text = forced
    ? `${ref(c)} sways and slumps to the ground, asleep.`
    : quality === 'rough' ? `${ref(c)} curls up on the ground and goes to sleep.` : `${ref(c)} lies down to sleep.`;
  world.perceive(citizensIn(world.citizens, c.location, { exceptId: c.id }).map((o) => o.id), {
    kind: 'action', text, importance: forced ? 6 : IMPORTANCE.visibleAction, sourceId: c.id, roomId: c.location,
  });
  world.hooks.onSleepStart(c);
}

/** Wake up: from being rested, a timer, a jolt (stimulus >= 7) or the director. */
export function wake(world, c, { reason = 'timer', cause = null } = {}) {
  if (c.activity.type !== 'sleeping') return;
  const slept = Math.round(world.now - c.activity.since);
  const startedAt = c.activity.detail?.startedAt ?? c.activity.since; // step A2: when this sleep began
  const sleptQuality = c.activity.detail?.quality ?? null;
  const buffer = c.sleepBuffer ?? [];
  c.sleepBuffer = [];
  world.setActivity(c, { type: 'idle' });
  world.hooks.onWake(c, slept);
  let first = {
    rested: `You wake up rested. ${nowPhrase(world.now)}`,
    timer: `You wake up. ${nowPhrase(world.now)}`,
    jolt: 'You jolt awake!',
    director: `You wake up with a start. ${nowPhrase(world.now)}`,
    // step A2: woken far too soon while still worn out — their body is nowhere near ready.
    woken_early: 'You were only asleep a moment; you can barely keep your eyes open.',
  }[reason] ?? `You wake up. ${nowPhrase(world.now)}`;
  const heard = buffer.length ? ` While you slept you vaguely heard: ${buffer.map((s) => s.text.replace(/[.!]+$/, '')).join('; ')}.` : '';
  const hour = (((world.now % 1440) + 1440) % 1440) / 60;
  const longSleep = slept >= 180; // step 9.5 (A4): the first decision after a real sleep is the waking decision (full)
  if (longSleep) { c.wokeAt = world.now; c.lastSleep = { minutes: slept, quality: sleptQuality, reason, startedAt }; }
  void hour;
  // step A2: woken before an hour of sleep with fatigue at 'exhausted' (80) or worse → flag it; unless
  // something urgent (>= 7) arrives first, the body takes over again after 20 minutes (#updateBodies).
  if (reason !== 'rested' && world.now - startedAt < 60 && c.needs.fatigue >= 80) {
    c.wokeEarly = { at: world.now, until: world.now + WOKE_EARLY_MINUTES };
    first = `${reason === 'jolt' ? 'You jolt awake! ' : ''}You were only asleep a moment; you can barely keep your eyes open.`;
    world.saveCitizen(c);
  }
  world.perceive([c.id], { kind: 'timer', text: first + heard, importance: IMPORTANCE.timer, roomId: c.location, data: { wakeUp: true, longSleep } });
  world.perceive(citizensIn(world.citizens, c.location, { exceptId: c.id }).map((o) => o.id), {
    kind: 'action', text: `${ref(c)} wakes up.`, importance: 3, sourceId: c.id, roomId: c.location,
  });
  world.logEvent('wake', { actorId: c.id, location: c.location, reason, sleptMinutes: slept, cause: cause?.text?.slice(0, 120) ?? null });
  // step A2: the actual sleep length (game minutes) for the log, whatever the old activity said.
  if (c.wokeEarly) world.logEvent('wake', { actorId: c.id, location: c.location, reason: 'woke_early', sleptMinutes: Math.round(world.now - startedAt) });
}

/** hp reached 0 (non-lethal): unconscious until someone feeds them or the director revives them. */
export function collapse(world, c, { reason = 'hp' } = {}) {
  if (c.carryingPerson) dropCarried(world, c, 'dropped');
  world.cancelThink(c);
  landIfWalking(world, c);
  if (c.conversationId) world.conversations.leave(c, { reason: 'left' });
  world.setActivity(c, { type: 'collapsed', detail: { reason } });
  world.perceive(citizensIn(world.citizens, c.location, { exceptId: c.id }).map((o) => o.id), {
    kind: 'action', text: `${ref(c)} collapses and lies still.`, importance: 8, sourceId: c.id, roomId: c.location,
    data: { interrupt: true, collapse: true },
  });
  world.logEvent('collapse', { actorId: c.id, location: c.location, reason, hp: Math.round(c.needs.hp), hunger: Math.round(c.needs.hunger) });
}

export function revive(world, c, { by = null, text = null, body = false } = {}) {
  if (c.activity.type !== 'collapsed' || !c.alive) return false;
  if (!body) {
    // step 7B: the director / a meal brings them round: vitality at least 30 (conditions stay)
    if (c.body) c.body.vitality = Math.max(c.body.vitality, 30);
    if (c.needs) c.needs.hunger = Math.min(c.needs.hunger, 60);
  }
  world.setActivity(c, { type: 'idle' });
  world.perceive([c.id], { kind: 'body', text: text ?? 'You come to, weak and dizzy.', importance: 7, roomId: c.location });
  world.perceive(citizensIn(world.citizens, c.location, { exceptId: c.id }).map((o) => o.id), {
    kind: 'action', text: `${ref(c)} stirs and comes to.`, importance: 5, sourceId: c.id, roomId: c.location,
  });
  world.logEvent('revive', { actorId: c.id, location: c.location, by });
  return true;
}

/** Death (step 7B: see body/death.js: corpse, drops, witnesses, grief). Kept as the one entry point other modules call. */
export function die(world, c, { reason = 'injury', cause = null } = {}) {
  return world.body.die(c, { reason, cause: cause ?? undefined });
}

function feed(world, c, call) {
  const room = world.rooms.get(c.location);
  const food = activeServices(room, world.now).food;
  const target = findPerson(world, c, citizensIn(world.citizens, c.location, { exceptId: c.id }), call.arguments.who);
  if (!food) return stale(world, c, call, "There's nothing here you could feed anyone with.");
  if (!target || target.activity.type !== 'collapsed') return stale(world, c, call, 'You kneel down, but there is nobody here who needs feeding.');
  if (target.activity.detail?.reason === 'unconscious') return stale(world, c, call, `You kneel by ${ref(target)}, but food won't bring ${pronouns(target).obj} round: ${pronouns(target).subj} ${pronouns(target).subj === 'they' ? 'are' : 'is'} out cold from ${pronouns(target).poss ?? 'their'} wounds.`);
  logAction(world, c, call, { targetId: target.id });
  target.needs.hunger = Math.max(0, target.needs.hunger - food.hungerRelief);
  if (target.body) target.body.vitality = Math.max(target.body.vitality, 20);
  world.setActivity(target, { type: 'idle' });
  world.perceive([target.id], {
    kind: 'body', text: `You come to. ${ref(c)} is kneeling beside you, feeding you ${food.description}.`, importance: 8, sourceId: c.id, roomId: room.id,
  });
  world.perceive(citizensIn(world.citizens, c.location, { exceptId: c.id }).filter((o) => o.id !== target.id).map((o) => o.id), {
    kind: 'action', text: `${ref(c)} kneels beside ${ref(target)} and feeds ${pronouns(target).obj}.`, importance: 5, sourceId: c.id, roomId: room.id,
  });
  world.setActivity(c, { type: 'doing', until: world.now + 10, detail: { description: 'feeding someone who collapsed', minutes: 10 } });
  world.logEvent('revive', { actorId: target.id, location: room.id, by: c.id, how: 'feed' });
  remember(world, c, `You fed ${ref(target)}, who had collapsed.`);
  return { ok: true };
}

// ---------- introduce_yourself ----------
function introduceYourself(world, c, call) {
  const addition = String(call.arguments.addition ?? '').trim();
  const text = `I'm ${c.name}.${addition ? ` ${addition}` : ''}`;
  return say(world, c, { ...call, arguments: { ...call.arguments, text }, introduce: true });
}

// ---------- hide_feelings (step 6) ----------
function hideFeelings(world, c, call) {
  const type = call.arguments.emotion || null;
  logAction(world, c, call);
  world.emotions.hide(c, type);
  remember(world, c, type ? 'You schooled your face, so that nobody would see how you feel.' : 'You schooled your face and gave nothing away.');
  world.setActivity(c, c.conversationId && world.conversations.get(c.conversationId) ? { type: 'talking', detail: { conversationId: c.conversationId } } : { type: 'idle' });
  return { ok: true };
}

// ---------- parties (step 5.5) ----------
function proposeParty(world, c, call) {
  const present = citizensIn(world.citizens, c.location, { exceptId: c.id }).filter(canHear);
  const wanted = Array.isArray(call.arguments.people) ? call.arguments.people : [call.arguments.people];
  const invitees = [...new Set(wanted.map((l) => findPerson(world, c, present, l)).filter(Boolean))];
  if (!invitees.length) return stale(world, c, call, 'You look around for them, but the people you meant to ask are not here.');
  const ev = logAction(world, c, call, { invited: invitees.map((o) => o.id) });
  const purpose = world.groups.propose(c, invitees, call.arguments.purpose);
  remember(world, c, `You asked ${invitees.map((o) => ref(o)).join(' and ')} to join you: to ${purpose.replace(/^to /i, '')}.`);
  // Others in the room hear the asking.
  world.perceive(present.filter((o) => !invitees.includes(o)).map((o) => o.id), {
    kind: 'speech', text: `${ref(c)} asks ${invitees.map((o) => ref(o)).join(' and ')} to join ${pronouns(c).obj}: to ${purpose.replace(/^to /i, '')}.`,
    importance: IMPORTANCE.speechInRoom, sourceId: c.id, roomId: c.location, data: { eventId: ev.id },
  });
  if (c.conversationId) world.setActivity(c, { type: 'talking', detail: { conversationId: c.conversationId } });
  else world.setActivity(c, { type: 'waiting', until: world.now + 5, detail: { reason: 'waiting for an answer', minutes: 5 } });
  return { ok: true };
}

function acceptInvitation(world, c, call) {
  const from = findPerson(world, c, [...world.citizens.values()].filter((o) => o.alive), call.arguments.from);
  const r = from ? world.groups.accept(c, from.id) : { ok: false, reason: 'That invitation no longer stands.' };
  if (!r.ok) return stale(world, c, call, r.reason);
  logAction(world, c, call, { fromId: from.id, groupId: r.group.id });
  world.perceive(citizensIn(world.citizens, c.location, { exceptId: c.id }).filter((o) => o.id !== from.id).map((o) => o.id), {
    kind: 'action', text: `${ref(c)} agrees to join ${ref(from)}.`, importance: IMPORTANCE.arriveDepart, sourceId: c.id, roomId: c.location,
  });
  remember(world, c, `You agreed to join ${ref(from)}${r.group.data?.purpose ? `: to ${String(r.group.data.purpose).replace(/^to /i, '')}` : ''}.`);
  world.setActivity(c, c.conversationId ? { type: 'talking', detail: { conversationId: c.conversationId } } : { type: 'idle' });
  return { ok: true };
}

function declineInvitation(world, c, call) {
  const from = findPerson(world, c, [...world.citizens.values()].filter((o) => o.alive), call.arguments.from);
  if (!from || !world.groups.decline(c, from.id)) return stale(world, c, call, 'There is no invitation to turn down any more.');
  const reason = String(call.arguments.reason ?? '').trim();
  remember(world, c, `You turned down ${ref(from)}'s invitation.`);
  // The refusal is spoken to the proposer if they are here.
  if (from.location === c.location && canHear(from)) {
    return say(world, c, { ...call, name: 'say', arguments: { to: from.name, text: reason || 'No. Not this time.' } });
  }
  logAction(world, c, call, { fromId: from.id });
  world.setActivity(c, { type: 'idle' });
  return { ok: true };
}

function leaveGroup(world, c, call) {
  const g = world.groups.get(call.arguments.group);
  if (!g || !world.groups.of(c.id).some((m) => m.group.id === g.id)) return stale(world, c, call, "You aren't part of that any more.");
  const fellows = world.groups.membersOf(g.id).filter((m) => m.citizenId !== c.id).map((m) => m.citizenId);
  logAction(world, c, call, { groupId: g.id });
  world.groups.leave(g.id, c.id);
  const farewell = String(call.arguments.farewell ?? '').trim();
  world.perceive(fellows, (o) => ({
    kind: 'action', importance: 6, sourceId: c.id, roomId: c.location, data: { wake: true },
    text: o.location === c.location && farewell ? `${ref(c)} leaves ${g.name}, saying: "${farewell}"` : `${ref(c)} has left ${g.name}.`,
  }));
  remember(world, c, `You left ${g.name}.`);
  world.setActivity(c, c.conversationId ? { type: 'talking', detail: { conversationId: c.conversationId } } : { type: 'idle' });
  return { ok: true };
}

// ---------- leave_conversation ----------
function leaveConversation(world, c, call) {
  const farewell = String(call.arguments.farewell ?? '').trim();
  const conv = world.conversations.of(c);
  const ev = logAction(world, c, call);
  if (conv && farewell) {
    const room = world.rooms.get(c.location);
    speak(world, c, farewell, null, citizensIn(world.citizens, c.location, { exceptId: c.id }), room,
      { thought: call.innerThought, eventId: ev.id });
  }
  if (conv) world.conversations.leave(c, { reason: 'left' });
  world.setActivity(c, { type: 'idle' });
  remember(world, c, farewell ? `You ended the conversation, saying: "${farewell}"` : 'You stepped out of the conversation.');
  return { ok: true };
}

// ---------- timers ----------
export function resolveTimers(world, now) {
  for (const c of world.citizens.values()) {
    const a = c.activity;
    if (!c.alive || a.until == null || a.until > now) continue;
    if (a.type === 'moving') {
      arrive(world, c);
    } else if (a.type === 'sleeping') {
      wake(world, c, { reason: 'timer' });
    } else if (a.type === 'doing') {
      const what = a.detail?.description ?? 'what you were doing';
      // step 5: object activities finish in their own modules
      if (a.detail?.kind === 'examine') { finishExamine(world, c, a); continue; }
      if (a.detail?.kind === 'search') { finishSearch(world, c, a); continue; }
      if (a.detail?.kind === 'walk') { finishWalk(world, c, a); continue; }
      if (a.detail?.kind === 'treat') { finishTreatment(world, c, a); continue; }
      if (a.detail?.kind === 'examine_person') { finishExaminePerson(world, c, a); continue; }
      if (a.detail?.kind === 'use') { finishUse(world, c, a.detail.token, null); continue; }
      if (a.detail?.kind === 'conceal') { finishConceal(world, c, a.detail.token, null); continue; }
      if (a.detail?.kind === 'tend') { finishTend(world, c, a); continue; }   // step 9.5
      if (a.detail?.kind === 'bury') { finishBury(world, c, a); continue; }
      if (a.detail?.kind && world.physical?.finishes(a.detail.kind)) { world.physical.finish(c, a); continue; } // step 10
      if (a.detail?.kind === 'eat') {
        a.detail.done = true;
        finishMeal(world, c, a, { completed: true });
        world.setActivity(c, { type: 'idle' });
        world.perceive([c.id], { kind: 'timer', text: "You've eaten your fill.", importance: IMPORTANCE.timer, roomId: c.location });
        continue;
      }
      world.stock?.onWork(c, a); // step 9.5: work at a service refills its stock
      const changed = a.detail?.targetId ? finishTargetedDo(world, c, a) : '';
      world.setActivity(c, { type: 'idle' });
      world.perceive([c.id], { kind: 'timer', text: `You finish ${ingOrQuote(what)}.${changed}`, importance: IMPORTANCE.timer, roomId: c.location });
    } else if (a.type === 'waiting') {
      const reason = a.detail?.reason;
      if (a.detail?.kind === 'vigil') {
        endVigil(world, c, a.detail.objectId); // step 9.5
        // step 10 (0.3): the watch was kept in turns — stay, hand over, or go
        const o = world.objects.get(a.detail.objectId);
        const dead = o ? world.citizens.get(o.data?.citizenId) : null;
        world.setActivity(c, { type: 'idle' });
        const hours = Math.max(1, Math.round((a.detail.minutes ?? 180) / 60));
        world.perceive([c.id], {
          kind: 'timer', importance: IMPORTANCE.timer, roomId: c.location, data: { vigilEnd: a.detail.objectId },
          text: `You've kept watch over ${dead ? plainRef(dead) : 'the dead'} for ${hours === 1 ? 'an hour' : `${hours} hours`}. You could stay longer, hand the watch to someone, or go and rest.`,
        });
        continue;
      }
      if (a.detail?.following && c.following?.id === a.detail.following) { if (followStep(world, c, { applyAction })) continue; }
      world.setActivity(c, { type: 'idle' });
      if (a.detail?.silent) { world.scheduler.poke(); continue; } // a short wait while following someone: no stimulus
      world.perceive([c.id], {
        kind: 'timer', text: reason ? `You've waited long enough (${reason}).` : "You've waited long enough.",
        importance: IMPORTANCE.timer, roomId: c.location,
      });
    } else {
      world.setActivity(c, { ...a, until: null });
    }
  }
}

// ---------- helpers ----------

// Someone who drops while on the road ends up at the place they were walking to.
function landIfWalking(world, c) {
  if (c.location || c.activity.type !== 'moving') return;
  const d = c.activity.detail ?? {};
  c.location = world.rooms.has(d.to) ? d.to : d.from;
  learnPlace(c, c.location, serviceNames(world.rooms.get(c.location), world.now), 'visited', world.now);
}

// Execution-time validation failed: no effect, tell the citizen, let them decide again.
export function stale(world, c, call, text) {
  world.setActivity(c, { type: 'idle' });
  world.perceive([c.id], { kind: 'system', text, importance: IMPORTANCE.staleAction, roomId: c.location });
  world.logEvent('action_stale', { actorId: c.id, location: c.location, tool: call.name, args: call.arguments, reason: text });
  return { ok: false, reason: text };
}

export function logAction(world, c, call, extra = {}) {
  const { inner_thought: _ignored, ...shown } = call.arguments ?? {};
  return world.logEvent('action', {
    actorId: c.id, location: c.location, tool: call.name, args: shown,
    thought: call.innerThought || null,
    ...(call.truncated ? { truncated: true } : {}),
    ...(call.planned ? { planned: true } : {}),
    ...(call.callIds?.length ? { callIds: call.callIds } : {}),
    ...extra,
  });
}

export function remember(world, c, text) {
  c.recentActions.push({ gameTime: world.now, text });
  if (c.recentActions.length > RECENT_ACTIONS) c.recentActions.splice(0, c.recentActions.length - RECENT_ACTIONS);
  world.saveCitizen(c);
}

/** Find someone present by the name / id / label (e.g. "the tall man") this citizen used. */
export function findPerson(world, c, list, label) {
  return findByName(list, label) ?? world.memory.labelsFor(c, list).get(String(label ?? '').trim()) ?? null;
}

export function findByName(list, name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return null;
  return list.find((x) => x.name.toLowerCase() === n || x.id.toLowerCase() === n) ?? null;
}

// "kneading dough" reads naturally after "is"/"finish"; anything else is quoted.
export function isIngPhrase(action) {
  return /^\s*\w+ing\b/i.test(action);
}
export function ingOrQuote(action) {
  return isIngPhrase(action) ? action.trim().replace(/[.!]+$/, '') : `"${action.trim()}"`;
}
export function describeDoing(name, action) {
  const a = action.trim().replace(/[.!]+$/, '');
  return isIngPhrase(a) ? `${name} is ${a}` : `${name} is busy: ${a}`;
}

/** Best-effort cleanup of first-person `do` phrases: "I'm checking my sacks" → "checking her sacks". */
export function cleanDoing(action, c) {
  const p = pronouns(c);
  const refl = { she: 'herself', he: 'himself' }[p.subj] ?? 'themselves';
  let t = action.trim().replace(/[.!]+$/, '');
  t = t.replace(/^(i am|i'm|im|i)\s+/i, '');
  t = t.replace(/\bmyself\b/gi, refl).replace(/\bmy\b/gi, p.poss).replace(/\bme\b/gi, p.obj).replace(/\bmine\b/gi, `${p.poss} own`);
  if (/^[A-Z][a-z]+ing\b/.test(t)) t = t[0].toLowerCase() + t.slice(1);
  return t;
}
