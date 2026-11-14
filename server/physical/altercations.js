// Step 10 §3: a fight, tracked like a conversation. Starts with the first aggressive act toward a person; others join by
// acting aggressively toward a participant, or by holding back / defending / caring for one. Ends when one side has
// fled the room, yielded (and the other side stopped), is unconscious or dead, or nobody has acted aggressively for
// 2 game minutes. Persisted in world_state ('altercations'); the recent ended ones stay for the panel and the prompt.
//
//   { id, roomId, startedAt, lastAggressionAt, status: active|ended, endReason, endedAt,
//     participants: [{ id, side: a|b, intent, role: aggressor|target|joined|holder }],
//     exchanges: [{ at, actor, action, target, aim, hit, effects, conditions, with, words }] }
import { getState, setState } from '../db.js';
import { citizensIn } from '../world/rooms.js';
import { ref } from '../memory/index.js';

const COOL_DOWN_MINUTES = 2;
const KEEP_ENDED = 12;
const MAX_EXCHANGES = 60;
export const AGGRESSIVE = ['shove', 'grab', 'slap', 'punch', 'kick', 'strike', 'throw_at', 'snatch', 'pin_down', 'choke', 'tie_up', 'drag'];
export const DEFENSIVE = ['dodge', 'block', 'break_free', 'yield', 'plead', 'pull_away'];
export const CARING = ['embrace', 'hold_hand', 'comfort', 'help_up', 'support', 'hold_back', 'free'];

const down = (c) => !c || !c.alive || ['collapsed', 'unconscious'].includes(c.activity.type) || (c.body?.status ?? []).includes('unconscious');

export class Altercations {
  constructor(world) {
    this.world = world;
    this.list = [];
    this.seq = 0;
  }

  load() {
    const s = getState(this.world.db, 'altercations', null);
    this.list = Array.isArray(s?.list) ? s.list : [];
    this.seq = s?.seq ?? this.list.length;
  }

  save() {
    try { setState(this.world.db, 'altercations', { seq: this.seq, list: this.list }); } catch { /* closed during shutdown */ }
    this.world.bus.emit('altercation', { list: this.view() });
  }

  get(id) {
    return this.list.find((a) => a.id === id) ?? null;
  }

  active() {
    return this.list.filter((a) => a.status === 'active');
  }

  /** The active altercation this citizen takes part in, if any. */
  of(c) {
    const id = typeof c === 'string' ? c : c?.id;
    return this.list.find((a) => a.status === 'active' && a.participants.some((p) => p.id === id)) ?? null;
  }

  part(alt, id) {
    return alt?.participants.find((p) => p.id === id) ?? null;
  }

  /** Someone acts aggressively toward someone: start a fight, or join the one either of them is in. */
  aggression(actor, target, { intent }) {
    const w = this.world;
    let alt = this.of(actor) ?? this.of(target);
    if (alt && alt.roomId !== actor.location) alt = null;
    if (!alt) {
      alt = {
        id: `alt${++this.seq}`, roomId: actor.location, startedAt: w.now, lastAggressionAt: w.now, status: 'active', endReason: null, endedAt: null,
        participants: [
          { id: actor.id, side: 'a', intent: intent ?? 'hurt', role: 'aggressor', since: w.now },
          { id: target.id, side: 'b', intent: 'defend', role: 'target', since: w.now },
        ],
        exchanges: [],
      };
      this.list.push(alt);
      w.logEvent('altercation_start', { actorId: actor.id, location: actor.location, altercationId: alt.id, targetId: target.id, intent: intent ?? 'hurt' });
    } else {
      const tp = this.part(alt, target.id);
      const ap = this.part(alt, actor.id);
      if (!tp) alt.participants.push({ id: target.id, side: ap ? (ap.side === 'a' ? 'b' : 'a') : 'b', intent: 'defend', role: 'target', since: w.now });
      if (!ap) {
        const side = this.part(alt, target.id).side === 'a' ? 'b' : 'a';
        alt.participants.push({ id: actor.id, side, intent: intent ?? 'hurt', role: 'joined', since: w.now });
        w.logEvent('altercation_join', { actorId: actor.id, location: actor.location, altercationId: alt.id, side, against: target.id });
      } else if (intent) ap.intent = intent;
    }
    alt.lastAggressionAt = w.now;
    for (const p of alt.participants) if (p.yielded && p.id === actor.id) p.yielded = null;
    return alt;
  }

  /** Holding back, defending, caring for a participant: joins on that person's side (no new fight). */
  joinSide(c, alt, withId, role = 'holder') {
    if (!alt || this.part(alt, c.id)) return;
    const side = this.part(alt, withId)?.side ?? 'a';
    alt.participants.push({ id: c.id, side, intent: 'defend', role, since: this.world.now });
    this.world.logEvent('altercation_join', { actorId: c.id, location: c.location, altercationId: alt.id, side, with: withId, role });
  }

  record(alt, ex) {
    if (!alt) return;
    alt.exchanges.push({ at: this.world.now, ...ex });
    if (alt.exchanges.length > MAX_EXCHANGES) alt.exchanges.splice(0, alt.exchanges.length - MAX_EXCHANGES);
    this.save();
  }

  yielded(c) {
    const alt = this.of(c);
    const p = this.part(alt, c.id);
    if (p) { p.yielded = this.world.now; this.save(); }
    return alt;
  }

  end(alt, reason) {
    const w = this.world;
    if (!alt || alt.status !== 'active') return;
    alt.status = 'ended';
    alt.endReason = reason;
    alt.endedAt = w.now;
    w.logEvent('altercation_end', { location: alt.roomId, altercationId: alt.id, reason, participants: alt.participants.map((p) => p.id), exchanges: alt.exchanges.length });
    const here = citizensIn(w.citizens, alt.roomId).filter((x) => x.alive && !down(x));
    const text = {
      fled: 'The fight is over: one side has fled.', yielded: 'The fight is over: one side gave up.', unconscious: 'The fight is over; someone lies senseless.',
      dead: 'The fight is over. Someone is not moving.', separated: 'The fight has been broken up.', cooled: 'The fighting has stopped, for now.', director: 'The fight is over.',
    }[reason] ?? 'The fight is over.';
    w.perceive(here.map((x) => x.id), { kind: 'action', text, importance: 6, roomId: alt.roomId, data: { altercationEnd: alt.id } });
    w.physical?.consequences.onAltercationEnd(alt);
    const ended = this.list.filter((a) => a.status === 'ended');
    if (ended.length > KEEP_ENDED) this.list = this.list.filter((a) => a.status === 'active' || ended.slice(-KEEP_ENDED).includes(a));
    this.save();
  }

  /** Every game tick: does any fight end on its own? */
  tick() {
    const w = this.world;
    let changed = false;
    for (const alt of this.active()) {
      const sides = { a: [], b: [] };
      for (const p of alt.participants) {
        const c = w.citizens.get(p.id);
        const present = c && c.location === alt.roomId;
        (sides[p.side] ??= []).push({ p, c, present, down: down(c), dead: !c?.alive, yielded: p.yielded != null });
      }
      const quiet = w.now - alt.lastAggressionAt >= COOL_DOWN_MINUTES;
      let reason = null;
      for (const s of ['a', 'b']) {
        const l = sides[s] ?? [];
        if (!l.length || !l.every((x) => !x.present || x.down || x.yielded)) continue;
        if (l.some((x) => x.dead)) reason = 'dead';
        else if (l.some((x) => x.down)) reason = 'unconscious';
        else if (l.some((x) => !x.present)) reason = 'fled';
        else if (quiet) reason = 'yielded'; // they gave up, and the other side stopped
        if (reason) break;
      }
      // decisions take real time: nobody has cooled down while someone in it hasn't yet answered the last blow
      const answered = alt.participants.every((p) => { const c = w.citizens.get(p.id); return !c || !c.alive || c.location !== alt.roomId || down(c) || ['sleeping', 'collapsed'].includes(c.activity.type) || (c.lastDecisionAt ?? -Infinity) >= alt.lastAggressionAt; });
      const held = alt.participants.some((p) => w.citizens.get(p.id)?.phys?.restraint?.kind === 'held' && alt.participants.find((q) => q.id === w.citizens.get(p.id)?.phys?.restraint?.by)?.role === 'holder');
      if (!reason && quiet && held && answered) reason = 'separated';
      if (!reason && quiet && answered) reason = 'cooled';
      if (reason) { this.end(alt, reason); changed = true; }
    }
    return changed;
  }

  /** For the prompt / panel: short state words for a participant ("bleeding, on the floor"). */
  stateWords(c) {
    const w = this.world;
    const words = [];
    if (!c.alive) return ['not moving'];
    if (down(c)) words.push('senseless');
    const ph = c.phys ?? {};
    if (ph.prone) words.push('on the floor');
    if ((ph.dazedUntil ?? 0) > w.now) words.push('dazed');
    if ((ph.windedUntil ?? 0) > w.now) words.push('winded');
    if (ph.restraint?.kind === 'held') words.push(`held by ${ref(w.citizens.get(ph.restraint.by) ?? ph.restraint.by)}`);
    if (ph.restraint?.kind === 'pinned') words.push(`pinned down by ${ref(w.citizens.get(ph.restraint.by) ?? ph.restraint.by)}`);
    if (ph.restraint?.kind === 'tied') words.push('tied up');
    if ((ph.asphyxia ?? 0) >= 1 && ph.chokedBy) words.push('choking');
    if ((c.body?.chips ?? []).includes('bleeding')) words.push('bleeding');
    const weapon = w.objects.carriedBy(c.id).find((o) => w.objects.type(o)?.weapon || (w.objects.type(o)?.tags ?? []).some((t) => ['weapon', 'blade', 'sharp', 'heavy'].includes(t)));
    if (weapon) words.push(`holding ${w.objects.surfaceText(weapon)}`);
    if (c.phys?.restraint == null && c.alive && (alt => alt && this.part(alt, c.id)?.yielded)(this.of(c))) words.push('has given up');
    return words;
  }

  view() {
    const w = this.world;
    return this.list.map((a) => ({
      ...a,
      participants: a.participants.map((p) => {
        const c = w.citizens.get(p.id);
        return { ...p, name: c?.name ?? p.id, state: c ? this.stateWords(c) : [] };
      }),
      exchanges: a.exchanges.slice(-12),
    }));
  }
}
