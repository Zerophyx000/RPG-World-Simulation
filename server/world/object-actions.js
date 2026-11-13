// Object tools (step 5): take, put (openly or concealed), give, examine, search, use, and the
// targeted `do`. Every change goes through world.objects.change(); nothing here creates an object.
//
// Citizens refer to objects by their alias ("flour_sack#k2p0") from WHAT'S HERE / YOU'RE CARRYING.
// Execution-time validation as in step 2: if the thing is no longer where they thought, nothing happens
// and they are told why.
//
// Async keeper calls (use, conceal, targeted do) run while the citizen is `doing`. If the keeper hasn't
// answered when the activity's timer runs out, the code fallback decides (keeper/index.js).
import { citizensIn } from './rooms.js';
import { IMPORTANCE } from './perception.js';
import { ref } from '../memory/index.js';
import { cap } from './objects.js';
import { keeperUse, keeperConceal, fallbackUse, fallbackConceal } from '../keeper/index.js';
import { stale, logAction, remember, findPerson } from './actions.js';

const KEEPER_WAIT_MINUTES = 10;   // a use / conceal waits at most this long for the keeper
const SEARCH_MINUTES = { sparse: 5, normal: 10, rich: 15 };
const MAX_SEARCH_MINUTES = 20;

// ---------- helpers ----------
/** The object behind a token, if this citizen can reach it now (carried, or perceived in the room). */
function reach(world, c, token, { carried = true, here = true } = {}) {
  const O = world.objects;
  const o = O.resolve(token);
  if (!o) return null;
  if (carried && o.holderId === c.id) return o;
  if (here && c.location && o.roomId === c.location && O.perceivedIds(c).has(o.id)) return o;
  return null;
}

function goneText(world, c, token, verb = 'reach for') {
  const o = world.objects.resolve(token);
  return o ? `You ${verb} ${world.objects.short(o)}, but it's not there any more.` : `You ${verb} it, but there's nothing like that here.`;
}

/** After a quick object action: back to the conversation if in one, else free. */
function settle(world, c) {
  if (c.conversationId && world.conversations.get(c.conversationId)) world.setActivity(c, { type: 'talking', detail: { conversationId: c.conversationId } });
  else world.setActivity(c, { type: 'idle' });
}

/** Keeper texts use {actor}; the actor's real name is swapped for a per-viewer token too. */
function actorText(text, c) {
  if (!text) return null;
  let t = String(text).replace(/\{actor\}/gi, ref(c));
  if (c.name) t = t.replace(new RegExp(`\\b${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), ref(c));
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function relPhrase(world, relation, anchor) {
  if (!anchor || relation === 'floor') return 'down';
  const word = { on: 'on', in: 'into', behind: 'behind', under: 'under', beside: 'next to' }[relation] ?? relation;
  return `${word} ${world.objects.short(anchor)}`;
}

function others(world, c) {
  return citizensIn(world.citizens, c.location, { exceptId: c.id }).map((o) => o.id);
}

function listJoin(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** ", carrying a flour sack" for arrival / departure / WHO IS HERE. */
export function carryingPhrase(world, viewer, c) {
  const items = world.objects.carriedBy(c.id);
  return items.length ? `, carrying ${listJoin(items.map((o) => world.objects.textFor(viewer, o)))}` : '';
}

// ---------- take / put / give ----------
export function take(world, c, call) {
  const O = world.objects;
  const o = reach(world, c, call.arguments.object, { carried: false });
  if (!o) return stale(world, c, call, goneText(world, c, call.arguments.object));
  const type = O.type(o);
  if (!type.portable) return stale(world, c, call, `You can't carry ${O.short(o)} around.`);
  if (O.around(o.id, 'in').length) return stale(world, c, call, `${cap(O.short(o))} has things in it; you'd have to empty it first.`);
  if (type.size > O.freeSlots(c.id)) return stale(world, c, call, O.slotsUsed(c.id) ? 'Your hands are full.' : `${cap(O.short(o))} is too big to pick up with your hands full.`);
  const p = o.placement ?? {};
  const anchorOf = p.of ? O.get(p.of) : null;
  const fromWord = { on: 'from', in: 'out of', behind: 'from behind', under: 'from under', beside: 'from beside' }[p.relation];
  const from = anchorOf && fromWord ? `${fromWord} ${O.short(anchorOf)}` : '';
  logAction(world, c, call, { objectId: o.id });
  O.change(o.id, { holderId: c.id }, {
    actorId: c.id, action: 'take', text: `${c.name} takes ${O.label(o)}`,
    perceive: (v) => `${ref(c)} picks up ${O.textFor(v, o)}${from ? ` ${from}` : ''}.`,
  });
  // Step 6: taking what isn't yours in front of others is shaming (and gnaws at the conscientious).
  world.emotions.onOwnActSeen(c, o, O.history(o.id, 1)[0]?.witnesses ?? [], 'take');
  remember(world, c, `You picked up ${O.textFor(c, o)}.`);
  settle(world, c);
  return { ok: true };
}

export function put(world, c, call) {
  const O = world.objects;
  const args = call.arguments;
  const o = reach(world, c, args.object, { here: false });
  if (!o) return stale(world, c, call, "You aren't holding that any more.");
  let anchor = null;
  if (args.anchor) {
    anchor = reach(world, c, args.anchor, { carried: false });
    if (!anchor) return stale(world, c, call, goneText(world, c, args.anchor, 'turn to'));
    if (anchor.id === o.id) anchor = null;
  }
  if (args.conceal) return startConceal(world, c, call, o, anchor, args.relation);

  let relation = anchor ? (args.relation && args.relation !== 'floor' ? args.relation : 'on') : 'floor';
  if (relation === 'on' && ['door', 'shutters'].includes(anchor?.typeId)) relation = 'beside'; // nothing rests "on" a door
  if (relation === 'in') {
    if (!O.type(anchor).container) relation = 'on';
    else if (O.isClosed(anchor)) return stale(world, c, call, `${cap(O.short(anchor))} is closed.`);
  }
  logAction(world, c, call, { objectId: o.id, anchorId: anchor?.id ?? null });
  O.change(o.id, { roomId: c.location, placement: { relation, of: anchor?.id ?? null }, visibility: 'obvious', searchDifficulty: 0 }, {
    actorId: c.id, action: 'put', text: `${c.name} puts ${O.label(o)} ${relPhrase(world, relation, anchor)}`,
    perceive: (v) => `${ref(c)} puts ${O.textFor(v, o)} ${relPhrase(world, relation, anchor)}.`,
  });
  remember(world, c, `You put ${O.textFor(c, o)} ${relPhrase(world, relation, anchor)}.`);
  settle(world, c);
  return { ok: true };
}

export function give(world, c, call) {
  const O = world.objects;
  const o = reach(world, c, call.arguments.object, { here: false });
  if (!o) return stale(world, c, call, "You aren't holding that any more.");
  const present = citizensIn(world.citizens, c.location, { exceptId: c.id });
  const to = findPerson(world, c, present, call.arguments.to);
  if (!to) return stale(world, c, call, 'You hold it out, but the person you meant is not here any more.');
  if (to.activity.type === 'sleeping' || to.activity.type === 'collapsed') return stale(world, c, call, `You hold it out to ${ref(to)}, but nobody takes it.`);
  if (O.type(o).size > O.freeSlots(to.id)) {
    world.perceive([to.id], { kind: 'object', text: `${ref(c)} tries to hand you ${O.textFor(to, o)}, but your hands are full.`, importance: 5, sourceId: c.id, roomId: c.location, data: { wake: true } });
    return stale(world, c, call, `You hold out ${O.short(o)}, but ${ref(to)} has no free hands.`);
  }
  logAction(world, c, call, { objectId: o.id, toId: to.id });
  O.change(o.id, { holderId: to.id }, {
    actorId: c.id, action: 'give', text: `${c.name} gives ${O.label(o)} to ${to.name}`,
    perceive: (v) => (v.id === to.id
      ? { text: `${ref(c)} hands you ${O.textFor(v, o)}.`, importance: 6, data: { wake: true, addressed: true } }
      : `${ref(c)} hands ${O.textFor(v, o)} to ${ref(to)}.`),
  });
  remember(world, c, `You gave ${O.textFor(c, o)} to ${ref(to)}.`);
  settle(world, c);
  return { ok: true };
}

// ---------- concealment (put ..., conceal: true) ----------
function startConceal(world, c, call, o, anchor, relation) {
  const O = world.objects;
  if (!O.type(o).concealable) return stale(world, c, call, `There's no way to hide ${O.short(o)} here.`);
  const token = `cn${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const hint = anchor ? { relation: relation && relation !== 'floor' ? relation : 'behind', of: anchor.id } : null;
  logAction(world, c, call, { objectId: o.id, anchorId: anchor?.id ?? null, conceal: true });
  world.setActivity(c, {
    type: 'doing', until: world.now + KEEPER_WAIT_MINUTES,
    detail: { description: `tucking ${O.surfaceText(o)} away`, minutes: KEEPER_WAIT_MINUTES, kind: 'conceal', objectId: o.id, token, hint },
  });
  const hintText = hint ? `${hint.relation} ${O.short(anchor)}` : null;
  keeperConceal(world, { obj: o, actor: c, hint: hintText })
    .then((p) => finishConceal(world, c, token, p))
    .catch((err) => console.warn('[keeper] conceal failed:', err.message));
  return { ok: true };
}

/** Apply a concealment (keeper proposal or fallback) if the citizen is still at it. */
export function finishConceal(world, c, token, p = null) {
  const a = c.activity;
  if (a.type !== 'doing' || a.detail?.kind !== 'conceal' || a.detail.token !== token || a.detail.done) return;
  a.detail.done = true;
  const O = world.objects;
  const o = O.get(a.detail.objectId);
  if (!o || o.holderId !== c.id) return stale(world, c, { name: 'put', arguments: { object: a.detail.objectId } }, "You aren't holding it any more.");
  const anchors = O.inRoom(c.location).filter((x) => x.id !== o.id && !O.effectivelyHidden(x));
  if (!p || (p.of && !anchors.some((x) => x.id === p.of))) p = { ...fallbackConceal(world, o, anchors, a.detail.hint), source: 'fallback' };
  const anchor = p.of ? O.get(p.of) : null;
  const where = anchor ? `${p.relation} ${O.short(anchor)}` : 'in a corner';
  const view = O.change(o.id, {
    roomId: c.location, placement: { relation: anchor ? p.relation : 'floor', of: anchor?.id ?? null },
    visibility: p.visibility, searchDifficulty: p.searchDifficulty,
  }, {
    actorId: c.id, action: 'conceal', text: `${c.name} hides ${O.label(o)} ${where}`,
    extra: { keeper: p.source, difficulty: p.searchDifficulty },
    perceive: (v) => actorText(p.perceivedText, c) ?? `${ref(c)} pushes ${O.textFor(v, o)} ${where}.`,
  });
  if (anchor && p.clue) {
    O.change(anchor.id, { data: { clue: { text: p.clue, for: o.id } } }, { actorId: 'keeper', action: 'edit', notify: false, roomId: c.location });
  }
  // Step 5.5: hiding things in somebody else's home is a warning sign for whoever saw it.
  const seenBy = O.history(o.id, 1)[0]?.witnesses ?? [];
  if (seenBy.length) world.signals.onConceal(c, c.location, seenBy, o);
  world.emotions?.onOwnActSeen?.(c, o, seenBy, 'conceal');
  remember(world, c, `You hid ${O.textFor(c, o)} ${where}.`);
  settle(world, c);
  return view;
}

// ---------- examine ----------
export function examine(world, c, call) {
  const O = world.objects;
  const o = reach(world, c, call.arguments.object);
  if (!o) return stale(world, c, call, goneText(world, c, call.arguments.object, 'look for'));
  const minutes = 1 + Math.floor(Math.random() * 3); // 1–3
  logAction(world, c, call, { objectId: o.id });
  world.setActivity(c, {
    type: 'doing', until: world.now + minutes,
    detail: { description: `looking closely at ${O.short(o)}`, minutes, kind: 'examine', objectId: o.id },
  });
  world.perceive(others(world, c), (v) => ({
    kind: 'action', text: `${ref(c)} looks closely at ${o.holderId === c.id ? O.textFor(v, o) : O.short(o)}.`, importance: IMPORTANCE.visibleAction,
    sourceId: c.id, roomId: c.location, data: { objectId: o.id },
  }));
  return { ok: true };
}

export function finishExamine(world, c, a) {
  const O = world.objects;
  const o = reach(world, c, a.detail.objectId);
  world.setActivity(c, { type: 'idle' });
  if (!o) {
    world.perceive([c.id], { kind: 'system', text: 'You look up, but what you were looking at is gone.', importance: IMPORTANCE.staleAction, roomId: c.location });
    return;
  }
  const parts = [`You look closely at ${O.short(o)}: ${O.examineText(o)}`];
  const type = O.type(o);
  if (type.container) {
    if (O.isClosed(o)) parts.push(`It is ${o.state}; you can't see inside.`);
    else {
      const inside = O.around(o.id, 'in');
      parts.push(inside.length ? `Inside: ${listJoin(inside.map((x) => O.textFor(c, x)))}.` : 'It is empty.');
      for (const x of inside) O.learn(c, x);
    }
  }
  // Noticeable things close to it come to light; hidden ones (behind / under) need a search.
  const near = O.around(o.id).filter((x) => x.placement.relation !== 'in' && O.surfaceTier(x) === 'noticeable' && !c.knownObjects?.[x.id]);
  if (near.length) parts.push(`Close by you also notice ${listJoin(near.map((x) => `${O.textFor(c, x)} ${O.placementPhrase(x)}`))}.`);
  for (const x of near) O.learn(c, x);
  O.learn(c, o, { touched: true });
  world.logEvent('examine', { actorId: c.id, location: c.location, objectId: o.id, noticed: near.map((x) => x.id) });
  world.perceive([c.id], { kind: 'timer', text: parts.join(' '), importance: IMPORTANCE.timer, roomId: c.location, data: { objectId: o.id } });
  remember(world, c, `You examined ${O.short(o)}.`);
}

// ---------- search ----------
export function search(world, c, call) {
  const O = world.objects;
  const room = world.rooms.get(c.location);
  let target = null;
  if (call.arguments.target) {
    target = reach(world, c, call.arguments.target);
    if (!target) return stale(world, c, call, goneText(world, c, call.arguments.target, 'turn to'));
  }
  const base = SEARCH_MINUTES[room.detail] ?? 10;
  const minutes = Math.min(MAX_SEARCH_MINUTES, target ? Math.max(5, Math.round(base / 2)) : base + (O.inRoom(room.id).length > 12 ? 5 : 0));
  logAction(world, c, call, { targetId: target?.id ?? null });
  world.setActivity(c, {
    type: 'doing', until: world.now + minutes,
    detail: { description: target ? `searching around ${O.short(target)}` : 'searching the place', minutes, kind: 'search', targetId: target?.id ?? null },
  });
  world.perceive(others(world, c), {
    kind: 'action', importance: 4, sourceId: c.id, roomId: c.location, data: { search: true },
    text: target ? `${ref(c)} is poking around ${O.short(target)}.` : `${ref(c)} is searching the place, poking into corners.`,
  });
  return { ok: true };
}

/** Roll for every hidden thing in scope (§4.2). Found things become known. */
export function finishSearch(world, c, a) {
  const O = world.objects;
  world.setActivity(c, { type: 'idle' });
  const roomId = c.location;
  const targetId = a.detail.targetId ?? null;
  const target = targetId ? O.get(targetId) : null;
  if (targetId && (!target || (target.roomId !== roomId && target.holderId !== c.id))) {
    world.perceive([c.id], { kind: 'system', text: 'What you were searching around is gone.', importance: IMPORTANCE.staleAction, roomId });
    return;
  }
  const seen = O.perceivedIds(c, roomId);
  let scope = targetId ? O.around(targetId) : O.inRoom(roomId);
  if (targetId) scope = [...scope, ...scope.flatMap((x) => O.around(x.id, 'in'))]; // and what's inside things there
  const consc = Number(c.persona?.traits?.conscientiousness ?? 0.5);
  const repeats = c.searchCounts?.[roomId] ?? 0;
  const found = [];
  const rolls = [];
  for (const o of scope) {
    if (o.id === targetId || seen.has(o.id) || o.roomId !== roomId) continue;
    const anchor = o.placement?.relation === 'in' && O.get(o.placement.of);
    if (anchor && anchor.state === 'locked') continue; // locked away: a search doesn't open locks
    const tier = O.surfaceTier(o);
    if (tier === 'noticeable' || (tier === 'obvious')) {
      found.push(o);
      continue;
    }
    const d = o.searchDifficulty ?? 0;
    const chance = Math.min(0.95, Math.max(0.05, 0.85 - 0.08 * d + 0.1 * consc + 0.05 * repeats + (targetId ? 0.2 : 0)));
    const hit = Math.random() < chance;
    rolls.push({ id: o.id, difficulty: d, chance: Math.round(chance * 100) / 100, hit });
    if (hit) found.push(o);
  }
  c.searchCounts ??= {};
  c.searchCounts[roomId] = repeats + 1;
  for (const o of found) O.learn(c, o, { touched: true }); // just found: always on their list for a while
  world.saveCitizen(c);
  world.logEvent('search', { actorId: c.id, location: roomId, targetId, found: found.map((o) => o.id), rolls });

  const where = target ? `around ${O.short(target)}` : 'the place';
  if (!found.length) {
    world.perceive([c.id], { kind: 'timer', text: `You search ${where} but find nothing unusual.`, importance: IMPORTANCE.timer, roomId });
    remember(world, c, `You searched ${where} and found nothing.`);
    return;
  }
  const lines = found.map((o) => {
    const at = O.placementPhrase(o);
    return `${at ? `${cap(at.replace(/^by /, 'beside '))} you find` : 'You find'} ${O.textFor(c, o)}.`;
  });
  const owned = found.some((o) => o.ownerId);
  world.perceive([c.id], {
    kind: 'notice', text: lines.join(' '), importance: owned ? 7 : 5, roomId,
    data: { personal: true, objectIds: found.map((o) => o.id), found: true },
  });
  remember(world, c, `You searched ${where} and found ${listJoin(found.map((o) => O.textFor(c, o)))}.`);
}

// ---------- use ----------
export function use(world, c, call) {
  const O = world.objects;
  const o = reach(world, c, call.arguments.object);
  if (!o) return stale(world, c, call, goneText(world, c, call.arguments.object));
  const intent = String(call.arguments.intent ?? '').trim().replace(/[.!]+$/, '');
  const token = `us${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  logAction(world, c, call, { objectId: o.id });
  const verb = intent.replace(/^(i |to )/i, '').replace(/\bit\b/i, O.short(o));
  world.setActivity(c, {
    type: 'doing', until: world.now + KEEPER_WAIT_MINUTES,
    detail: { description: `trying to ${verb}`, minutes: KEEPER_WAIT_MINUTES, kind: 'use', objectId: o.id, intent, token },
  });
  keeperUse(world, { obj: o, actor: c, intent })
    .then((p) => finishUse(world, c, token, p))
    .catch((err) => console.warn('[keeper] use failed:', err.message));
  return { ok: true };
}

/** Apply a use (keeper proposal or, when the timer runs out first, the keyword fallback). */
export function finishUse(world, c, token, p = null) {
  const a = c.activity;
  if (a.type !== 'doing' || a.detail?.kind !== 'use' || a.detail.token !== token || a.detail.done) return;
  a.detail.done = true;
  const O = world.objects;
  const o = reach(world, c, a.detail.objectId);
  const call = { name: 'use', arguments: { object: a.detail.objectId, intent: a.detail.intent } };
  if (!o) return stale(world, c, call, 'You turn back to it, but it is gone.');
  if (!p) p = { ...fallbackUse(world, o, a.detail.intent), source: 'fallback' };
  const type = O.type(o);
  // Re-check against the state NOW (it may have changed while the keeper thought).
  if (p.accept && p.newState && !(type.transitions[o.state] ?? []).includes(p.newState)) {
    world.logEvent('keeper', { actorId: c.id, location: c.location, objectId: o.id, verdict: 'stale', proposal: { newState: p.newState }, state: o.state });
    p = { accept: false, rejectText: `${cap(O.short(o))} is ${o.state} now; that doesn't work.`, source: p.source };
  }
  if (!p.accept) {
    world.logEvent('object', { actorId: c.id, location: c.location, objectId: o.id, objectName: O.label(o), action: 'use_rejected', intent: a.detail.intent, reason: p.rejectText ?? null, keeper: p.source });
    return stale(world, c, call, p.rejectText || `You try, but ${O.short(o)} won't do that.`);
  }
  const seen = actorText(p.perceivedText, c) ?? `${ref(c)} ${a.detail.intent}.`;
  if (p.newState) {
    O.change(o.id, { state: p.newState, surfaceText: p.surfaceText ?? null }, {
      actorId: c.id, action: 'use', text: `${c.name}: ${a.detail.intent} → ${p.newState}`,
      extra: { intent: a.detail.intent, keeper: p.source }, perceive: () => seen,
    });
  } else {
    world.logEvent('object', { actorId: c.id, location: c.location, objectId: o.id, objectName: O.label(o), action: 'use', intent: a.detail.intent, keeper: p.source, witnesses: others(world, c), text: `${c.name}: ${a.detail.intent}` });
    world.perceive(others(world, c), { kind: 'action', text: seen, importance: IMPORTANCE.visibleAction, sourceId: c.id, roomId: c.location, data: { objectId: o.id } });
    O.learn(c, o, { touched: true });
  }
  const after = p.newState ? ` ${cap(O.short(o))} is now ${p.newState}.` : '';
  remember(world, c, `You ${a.detail.intent.replace(/^(i |to )/i, '')}.${after}`);
  world.setActivity(c, { type: 'idle' });
  world.perceive([c.id], { kind: 'timer', text: `You ${a.detail.intent.replace(/^(i |to )/i, '')}.${after}`, importance: 4, roomId: c.location, data: { objectId: o.id } });
}

// ---------- targeted do ----------
/** Called by doAction when `target` is given: ask the keeper now, apply at the end of the activity. */
export function startTargetedDo(world, c, target, action, minutes) {
  const token = c.activity.detail?.token;
  keeperUse(world, { obj: target, actor: c, intent: action, doAction: action, minutes })
    .then((p) => {
      const a = c.activity;
      if (a.type !== 'doing' || a.detail?.token !== token) return;
      a.detail.keeper = { accept: p.accept, newState: p.newState, surfaceText: p.surfaceText, perceivedText: p.perceivedText, source: p.source };
      world.saveCitizen(c);
    })
    .catch((err) => console.warn('[keeper] do failed:', err.message));
}

/** End of a targeted do: apply the keeper's proposed state change if it is still valid. Returns a suffix for the finish text. */
export function finishTargetedDo(world, c, a) {
  const O = world.objects;
  const k = a.detail?.keeper;
  const o = a.detail?.targetId ? reach(world, c, a.detail.targetId) : null;
  if (!o) return '';
  O.learn(c, o, { touched: true });
  if (!k?.accept || !k.newState) return '';
  if (!(O.type(o).transitions[o.state] ?? []).includes(k.newState)) {
    world.logEvent('keeper', { actorId: c.id, location: c.location, objectId: o.id, verdict: 'stale', proposal: { newState: k.newState }, state: o.state });
    return '';
  }
  O.change(o.id, { state: k.newState, surfaceText: k.surfaceText ?? null }, {
    actorId: c.id, action: 'use', text: `${c.name}: ${a.detail.description} → ${k.newState}`, extra: { via: 'do', keeper: k.source },
    perceive: () => actorText(k.perceivedText, c) ?? `${ref(c)} finishes with ${O.short(o)}.`,
  });
  return ` ${cap(O.short(o))} is now ${k.newState}.`;
}
