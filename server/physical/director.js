// Step 10 §7: the director's levers for physical life — provoke two citizens, hand out a weapon, set something alight,
// start or end a fight, and read the coherence log (reversals with their reasons, plausibility retries). Every lever
// goes through the same write paths as the citizens' own acts (emotions.bump, relationships.change, objects.create,
// fire.ignite, altercations); nothing here decides what anyone does.
import { ref } from '../memory/index.js';
import { citizensIn } from '../world/rooms.js';
import { release } from './acts.js';

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const need = (world, id) => {
  const c = world.citizens.get(id);
  if (!c) throw bad(`unknown citizen "${id}"`);
  return c;
};

export function provoke(world, { a, b, cause = null, amount = 4 }) {
  const A = need(world, a);
  const B = need(world, b);
  const why = String(cause ?? '').trim() || `${ref(B)} has been mocking me behind my back`;
  const delta = Math.max(1, Math.min(8, Number(amount) || 4));
  world.emotions.bump(A, { type: 'anger', target: B.id, delta, cause: why, source: 'director', raw: true });
  world.relationships.change(A.id, B.id, { affinity: -1 }, { reason: why, source: 'director' });
  world.memory.add(A.id, { kind: 'episodic', text: why, importance: 7, about: [B.id], placeId: A.location, source: { director: true } });
  world.memory.pushOnMind(A, { text: why, importance: 7 });
  world.logEvent('director_provoke', { actorId: A.id, targetId: B.id, cause: why, amount: delta });
  return { ok: true, anger: world.emotions.of(A).find((e) => e.type === 'anger' && e.target === B.id)?.intensity ?? null };
}

export function giveWeapon(world, { type = 'knife', to = null, room = null, quality = null }) {
  const t = world.objects.types.get(type);
  if (!t) throw bad(`unknown object type "${type}"`);
  const holder = to ? need(world, to) : null;
  if (!holder && !world.rooms.has(room)) throw bad('give it to someone (to) or put it in a room (room)');
  const id = `${type}_${Math.round(world.now)}_${Math.floor(Math.random() * 1e4).toString(36)}`;
  const def = { id, type, state: t.states[0], ...(holder ? { holder: holder.id } : { room }), data: { quality: quality != null ? Math.max(0, Math.min(1, Number(quality))) : t.weapon?.quality ?? 0.5 } };
  const view = world.objects.create(def, { actorId: 'director', origin: 'director' });
  if (holder) world.perceive([holder.id], { kind: 'director', text: `You have ${world.objects.surfaceText(world.objects.get(id))} in your hands.`, importance: 5, roomId: holder.location });
  return { ok: true, object: view };
}

export function igniteObject(world, { objectId }) {
  const o = world.objects.get(objectId);
  if (!o) throw bad(`unknown object "${objectId}"`);
  const lit = world.physical.fire.ignite(o, { cause: 'the director' });
  if (!lit) throw bad(`${world.objects.surfaceText(o)} does not burn (not flammable, already burning or burnt)`);
  return { ok: true };
}

export function startAltercation(world, { a, b, intent = 'hurt' }) {
  const A = need(world, a);
  const B = need(world, b);
  if (A.location !== B.location) throw bad('they are not in the same place');
  world.physical.consequences.setIntent(A, B, intent);
  const alt = world.altercations.aggression(A, B, { intent });
  world.altercations.save();
  const here = citizensIn(world.citizens, A.location);
  world.perceive(here.map((x) => x.id), (x) => ({
    kind: 'director', text: x.id === B.id ? `${ref(A)} squares up to you, fists clenched.` : x.id === A.id ? `You square up to ${ref(B)}.` : `${ref(A)} squares up to ${ref(B)}.`,
    importance: 8, roomId: A.location, data: { altercation: alt.id, role: x.id === A.id ? 'aggressor' : x.id === B.id ? 'target' : 'bystander', interrupt: x.id === B.id },
  }));
  return { ok: true, altercation: alt.id };
}

export function endAltercation(world, { id = null, citizenId = null }) {
  const alt = id ? world.altercations.get(id) : world.altercations.of(citizenId);
  if (!alt || alt.status !== 'active') throw bad('no active fight');
  for (const p of alt.participants) { const c = world.citizens.get(p.id); if (c?.phys?.restraint && c.phys.restraint.kind !== 'tied') release(world, c, 'the director'); }
  world.altercations.end(alt, 'director');
  return { ok: true };
}

/** Reversals (with the reason given), plausibility retries, refused reversals, and the intents as they changed. */
export function coherenceLog(world, { limit = 100 } = {}) {
  const rows = world.db.prepare("SELECT id, game_time, type, actor_id, data FROM events WHERE type IN ('coherence', 'coherence_retry', 'intent') ORDER BY id DESC LIMIT ?").all(Math.min(500, Number(limit) || 100));
  return rows.map((r) => {
    const d = JSON.parse(r.data);
    const name = (id) => world.citizens.get(id)?.name ?? id;
    return { id: r.id, gameTime: r.game_time, type: r.type, actor: name(r.actor_id), actorId: r.actor_id, kind: d.kind ?? null, action: d.action ?? d.tool ?? null, victim: d.victimId ? name(d.victimId) : d.targetId ? name(d.targetId) : null, reason: d.reason ?? d.message ?? null, intent: d.intent ?? null, from: d.from ?? null };
  });
}

export function crimes(world, { limit = 100 } = {}) {
  const name = (id) => world.citizens.get(id)?.name ?? id;
  return world.db.prepare("SELECT id, game_time, actor_id, location, data FROM events WHERE type = 'crime' ORDER BY id DESC LIMIT ?").all(Math.min(500, Number(limit) || 100)).map((r) => {
    const d = JSON.parse(r.data);
    return { id: r.id, gameTime: r.game_time, kind: d.kind, severity: d.severity, actor: name(r.actor_id), actorId: r.actor_id, victim: d.victimId ? name(d.victimId) : null, victimId: d.victimId ?? null, witnesses: (d.witnesses ?? []).map(name), location: r.location };
  });
}

// ---------- step 11.5 (Part D): forcing the first exchange of a test ----------
const labelFor = (world, viewer, o) => [...world.memory.labelsFor(viewer, [o]).keys()][0] ?? o.name;

/** The director makes A do one act on B, resolved by step 10 like any act (real wounds, real witnesses). `untilHit`:
 *  repeat a missed blow up to that many times. { a, b, action, intent, with (object id), aim, words, untilHit } */
export function forceAct(world, { a, b, action = 'punch', intent = 'hurt', with: withId = null, aim = null, words = null, untilHit = 1 }) {
  const A = need(world, a);
  const B = need(world, b);
  if (A.location !== B.location) throw bad('they are not in the same place');
  const weapon = withId ? world.objects.get(withId) : null;
  if (withId && !weapon) throw bad(`unknown object "${withId}"`);
  let last = null;
  for (let i = 0; i < Math.max(1, Math.min(10, Number(untilHit) || 1)); i++) {
    world.setActivity(A, { type: 'idle' });
    const n = world.db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'physical'").get().n;
    last = world.applyAction(A, { name: 'act_on', arguments: { person: labelFor(world, A, B), action, intent, ...(weapon ? { with: world.objects.alias(weapon) } : {}), ...(aim ? { aim } : {}), ...(words ? { words } : {}) } });
    const ev = world.db.prepare("SELECT data FROM events WHERE type = 'physical' ORDER BY id DESC LIMIT 1").get();
    const hit = world.db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'physical'").get().n > n && JSON.parse(ev?.data ?? '{}').hit !== false;
    if (hit) break;
  }
  world.logEvent('director', { action: 'force_act', a: A.id, b: B.id, act: action, intent });
  return { ok: Boolean(last?.ok ?? last), result: last };
}

/** The director makes A say a line (to B, or to the room), through the ordinary `say`. { a, to, text } */
export function forceSay(world, { a, to = null, text }) {
  const A = need(world, a);
  if (!String(text ?? '').trim()) throw bad('needs "text"');
  const B = to ? need(world, to) : null;
  world.setActivity(A, { type: 'idle' });
  const r = world.applyAction(A, { name: 'say', arguments: { text: String(text).trim(), ...(B ? { to: labelFor(world, A, B) } : {}) } });
  world.logEvent('director', { action: 'force_say', a: A.id, to: B?.id ?? null, text });
  return { ok: Boolean(r?.ok ?? r), result: r };
}
