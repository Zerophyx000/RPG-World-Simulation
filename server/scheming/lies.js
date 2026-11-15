// Step 11 §3: deception. Code always knows the truth; listeners only what they were told.
//
//   record      a speech (or put / give / handle) with `deceive` → a `lies` row: said, truth, why, kind, the resolved
//               check (who, where, from–to), about_ids, heard_by (told / overheard / retold, each with a verdict)
//   claims      every claim heard face to face (true or false) can be judged for an hour: trust_claim believe / doubt /
//               disbelieve → a memory and a relationship event; doubting an honest person is possible and real
//   retelling   someone who heard a lie and repeats something about the same people passes it on (heard_by: retold)
//   tells       a lie said in person may show (low cunning, guilt, fear, low composure, high stakes, someone close;
//               less with practice and with strangers); each listener may notice (familiarity, suspicion, perception;
//               less across the room, in the dark, in their own strong feelings). Nervous truths show too, less often.
//   contradictions (code, no LLM)  witnessed (the listener saw the person elsewhere then), told otherwise (two lies
//               that don't match), physical evidence (an object the person moved elsewhere then, known to the
//               listener) → "That doesn't match: …" (importance 7). Checked when heard, and later every half hour.
//   consequences guilt by honesty and closeness, fear of exposure by stakes (satisfaction for cunning, low-honesty
//               liars); caught → a big trust drop with a concrete reason, anger or hurt; confess → less guilt and fear;
//               accuse / frame → WHAT YOU'VE DONE for days, and a crime event
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { citizensIn } from '../world/rooms.js';
import { ref } from '../memory/index.js';
import { pronouns } from '../world/citizens.js';
import { relativeTime } from '../world/time.js';
import { J, resolvePerson, resolvePlace, resolveWhen, namesIn, whereabouts, trait } from './common.js';
import { isDark } from '../physical/profile.js';

export const LIE_KINDS = ['fact', 'self', 'cover', 'accuse', 'frame', 'other'];
const STAKES = { self: 0.6, fact: 1, other: 1, cover: 1.2, accuse: 1.6, frame: 1.8 };
const CLAIM_MINUTES = 60;
const LATE_CHECK_EVERY = 30;
const TELL_BASE = () => Number(process.env.TELL_BASE_CHANCE ?? 0.25);
const NOTICE_BASE = () => Number(process.env.TELL_NOTICE_BASE ?? 0.4);
let CUES = null;
const cues = () => {
  if (CUES) return CUES;
  try { CUES = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'tells.json'), 'utf8')).cues; } catch { CUES = ["{name} doesn't quite meet your eyes."]; }
  return CUES;
};

export class Lies {
  constructor(world) {
    this.world = world;
    this.rng = Math.random;
    const db = world.db;
    this.lastLate = -Infinity;
    this.q = {
      insert: db.prepare(`INSERT INTO lies (liar_id, game_time, said, truth, why, kind, check_who, check_where, check_from, check_to, about_ids, scheme_id, heard_by, status, event_id, data)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'standing', ?, ?)`),
      get: db.prepare('SELECT * FROM lies WHERE id = ?'),
      save: db.prepare('UPDATE lies SET heard_by = ?, status = ?, data = ? WHERE id = ?'),
      byLiar: db.prepare('SELECT * FROM lies WHERE liar_id = ? ORDER BY id DESC LIMIT ?'),
      standing: db.prepare("SELECT * FROM lies WHERE status = 'standing' AND game_time > ? ORDER BY id"),
      recent: db.prepare('SELECT * FROM lies WHERE game_time > ? ORDER BY id DESC'),
      all: db.prepare('SELECT * FROM lies ORDER BY id DESC LIMIT ?'),
    };
  }

  row(r) {
    return r ? { id: r.id, liarId: r.liar_id, gameTime: r.game_time, said: r.said, truth: r.truth, why: r.why, kind: r.kind, checkWho: r.check_who, checkWhere: r.check_where, checkFrom: r.check_from, checkTo: r.check_to, aboutIds: J(r.about_ids, []), schemeId: r.scheme_id, heardBy: J(r.heard_by, []), status: r.status, eventId: r.event_id, data: J(r.data, {}) } : null;
  }

  get(id) { return this.row(this.q.get.get(id)); }
  save(l) { this.q.save.run(JSON.stringify(l.heardBy), l.status, JSON.stringify(l.data), l.id); this.world.bus.emit('scheming', { what: 'lie', id: l.id }); }
  standingOf(c, limit = 20) { return this.q.byLiar.all(c.id, limit).map((r) => this.row(r)).filter((l) => l.status === 'standing'); }

  // ---------- recording ----------
  /**
   * @param said      the words (or a description of the act)
   * @param deceive   { truth, kind, why, check: { who, where, when }, scheme? }
   * @param hearers   citizens who heard / saw it; addressee: the one it was said to
   */
  record(c, { said, deceive, hearers = [], addressee = null, eventId = null, act = null }) {
    const w = this.world;
    const truth = String(deceive?.truth ?? '').trim().slice(0, 300);
    const why = String(deceive?.why ?? '').trim().slice(0, 200);
    if (!truth) { w.logEvent('deceive_incomplete', { actorId: c.id, said: String(said).slice(0, 120) }); return null; }
    const kind = LIE_KINDS.includes(deceive.kind) ? deceive.kind : 'other';
    const ch = deceive.check && typeof deceive.check === 'object' ? deceive.check : {};
    const who = ch.who ? resolvePerson(w, c, ch.who) : null;
    const where = ch.where ? resolvePlace(w, c, ch.where, { whoId: who?.id ?? null }) : null;
    const when = ch.when ? resolveWhen(w, ch.when) : null;
    const about = [...new Set([...namesIn(w, said, { exceptId: null }), ...(who ? [who.id] : [])])];
    const scheme = w.scheming?.schemes.linkFor(c, deceive.scheme) ?? null;
    const heardBy = hearers.map((o) => ({ citizen_id: o.id, at: w.now, how: !act && (o.id === addressee?.id || (o.conversationId && o.conversationId === c.conversationId)) ? 'told' : act ? 'saw' : 'overheard', from: c.id, verdict: 'unknown', verdict_at: null }));
    const data = { act: act ?? null, contradicted: [], caughtBy: [], resolved: { who: who?.id ?? null, where, when }, raw: ch };
    const info = this.q.insert.run(c.id, w.now, String(said).slice(0, 400), truth, why || null, kind, who?.id ?? null, where, when?.from ?? null, when?.to ?? null, JSON.stringify(about), scheme?.id ?? null, JSON.stringify(heardBy), eventId, JSON.stringify(data));
    const lie = this.get(Number(info.lastInsertRowid));
    c.lyingPractice = (c.lyingPractice ?? 0) + 1;
    w.logEvent('lie', { actorId: c.id, location: c.location, lieId: lie.id, kind, said: lie.said, truth, why, check: { who: who?.id ?? null, where, from: when?.from ?? null, to: when?.to ?? null }, heardBy: heardBy.map((h) => h.citizen_id), schemeId: scheme?.id ?? null, eventId });
    this.#afterLying(c, lie, hearers);
    for (const o of hearers) this.contradiction(lie, o.id);
    w.bus.emit('scheming', { what: 'lie', id: lie.id });
    return lie;
  }

  #afterLying(c, lie, hearers) {
    const w = this.world;
    const honesty = trait(c, 'honesty');
    const cunning = trait(c, 'cunning');
    const close = hearers.some((o) => (w.memory.rel(c.id, o.id)?.affinity ?? 0) >= 2);
    const stakes = STAKES[lie.kind] ?? 1;
    const guilt = Math.max(0, (honesty - 3) / 7) * (close ? 2.5 : 1.5) * Math.min(1.5, stakes);
    if (guilt >= 0.3) w.emotions.bump(c, { type: 'guilt', target: hearers[0]?.id ?? null, delta: Math.round(guilt * 10) / 10, cause: `I lied${hearers[0] ? ` to ${ref(hearers[0])}` : ''}: ${lie.said.slice(0, 60)}`, source: 'deception', raw: true });
    const fear = stakes * (1.2 - cunning / 12);
    if (fear >= 0.5) w.emotions.bump(c, { type: 'fear', target: null, delta: Math.round(fear * 10) / 10, cause: 'that the lie comes out', source: 'deception', raw: true });
    if (honesty <= 3 && cunning >= 7) w.emotions.bump(c, { type: 'pride', target: null, delta: 1, cause: 'they swallowed it', source: 'deception', raw: true });
    // accusing or framing someone falsely is a serious thing done: WHAT YOU'VE DONE for days, and a crime
    if (lie.kind === 'accuse' || lie.kind === 'frame') {
      const victimId = lie.checkWho ?? lie.aboutIds.find((id) => id !== c.id) ?? null;
      c.deeds = [...(c.deeds ?? []), { id: `lie-${lie.id}`, at: w.now, lastAt: w.now, victimId, altId: null, acts: {}, with: [], effects: [], parts: [], intent: 'hurt', serious: true, until: w.now + 3 * 1440, place: c.location, lie: { id: lie.id, kind: lie.kind, said: lie.said, truth: lie.truth, to: hearers.map((o) => o.id) } }].slice(-20);
      w.physical?.consequences.crime(c, victimId ? w.citizens.get(victimId) : null, lie.kind === 'frame' ? 'framing' : 'false_accusation', lie.kind === 'frame' ? 3 : 2, { lieId: lie.id, witnesses: hearers.map((o) => o.id) });
    }
    w.saveCitizen(c);
  }

  // ---------- claims heard face to face, and verdicts on them ----------
  /** Every line said to someone (or in their conversation) is a claim they may judge for an hour. */
  noteClaims(speaker, text, hearers, addressee, lie = null) {
    const w = this.world;
    for (const o of hearers) {
      const toThem = o.id === addressee?.id || (o.conversationId && o.conversationId === speaker.conversationId);
      if (!toThem || o.id === speaker.id) continue;
      o.recentClaims = [...(o.recentClaims ?? []).filter((x) => w.now - x.at < CLAIM_MINUTES), { from: speaker.id, at: w.now, text: String(text).slice(0, 140), lieId: lie?.id ?? null }].slice(-4);
    }
  }

  claimsFor(c) {
    return (c.recentClaims ?? []).filter((x) => this.world.now - x.at < CLAIM_MINUTES && this.world.citizens.get(x.from));
  }

  /** trust_claim: { from, verdict: believe | doubt | disbelieve, why } */
  verdict(c, tc) {
    const w = this.world;
    if (!tc || typeof tc !== 'object') return;
    const from = resolvePerson(w, c, tc.from);
    if (!from) return;
    const claim = this.claimsFor(c).filter((x) => x.from === from.id).at(-1);
    if (!claim) return;
    const v = ['believe', 'doubt', 'disbelieve'].includes(tc.verdict) ? tc.verdict : null;
    if (!v) return;
    const why = String(tc.why ?? '').trim().slice(0, 200);
    claim.verdict = v;
    w.memory.add(c.id, { kind: 'episodic', text: `${ref(from)} told me: "${claim.text}" — ${v === 'believe' ? 'I believed it' : v === 'doubt' ? "I wasn't sure I believed it" : "I didn't believe a word"}${why ? ` (${why})` : ''}.`, importance: v === 'believe' ? 3 : 5, about: [from.id], placeId: c.location, source: { claimFrom: from.id, verdict: v } });
    if (v !== 'believe') w.relationships.change(c.id, from.id, { trust: v === 'doubt' ? -0.3 : -0.8 }, { reason: `${v === 'doubt' ? 'I doubted' : "I didn't believe"} what ${ref(from)} told me: "${claim.text.slice(0, 80)}"${why ? ` — ${why}` : ''}`, source: 'reflection' });
    w.logEvent('trust_claim', { actorId: c.id, from: from.id, verdict: v, why, lieId: claim.lieId, claim: claim.text });
    if (claim.lieId) {
      const lie = this.get(claim.lieId);
      if (lie) {
        const h = lie.heardBy.find((x) => x.citizen_id === c.id);
        if (h) { h.verdict = v === 'believe' ? 'believed' : v === 'doubt' ? 'doubted' : 'disbelieved'; h.verdict_at = w.now; }
        if (v === 'disbelieve' && lie.data.contradicted?.some((x) => x.listener === c.id)) this.caught(lie, c, 'disbelieved, with a contradiction');
        else this.save(lie);
      }
    }
    w.saveCitizen(c);
  }

  // ---------- retelling ----------
  /** A speaker who heard a standing lie repeats something about the same people: the hearers get it, retold. */
  onSpeech(speaker, text, hearers) {
    const w = this.world;
    const mentioned = new Set(namesIn(w, text));
    if (!mentioned.size) return;
    for (const lie of this.q.standing.all(w.now - 7 * 1440).map((r) => this.row(r))) {
      if (lie.liarId === speaker.id) continue;
      const mine = lie.heardBy.find((h) => h.citizen_id === speaker.id && h.verdict !== 'disbelieved');
      if (!mine || !lie.aboutIds.some((id) => mentioned.has(id))) continue;
      let changed = false;
      for (const o of hearers) {
        if (o.id === lie.liarId || lie.heardBy.some((h) => h.citizen_id === o.id)) continue;
        lie.heardBy.push({ citizen_id: o.id, at: w.now, how: 'retold', from: speaker.id, verdict: 'unknown', verdict_at: null });
        changed = true;
        w.logEvent('lie_retold', { actorId: speaker.id, lieId: lie.id, to: o.id });
      }
      if (changed) { this.save(lie); for (const o of hearers) this.contradiction(lie, o.id); }
    }
  }

  // ---------- tells ----------
  /** In person: does the speaker show it, and who notices? → [{ listener, cue }] (perceived as plain observations). */
  tells(c, hearers, { lie = null, nervous = false } = {}) {
    const w = this.world;
    if (!lie && !nervous) return [];
    const cunning = trait(c, 'cunning');
    const emo = (type) => Math.max(0, ...w.emotions.of(c).filter((e) => e.type === type).map((e) => e.intensity)) / 10;
    const composure = w.physical ? (w.emotions.composure?.(c) ?? 0.5) : 0.5;
    const practice = Math.min(0.5, (c.lyingPractice ?? 0) * 0.03);
    const impaired = (c.needs?.fatigue ?? 0) >= 80 || (c.body?.pain ?? 0) >= 5 || c.drunk;
    const close = (o) => (w.memory.rel(c.id, o.id)?.affinity ?? 0) >= 2;
    const stranger = (o) => !(w.memory.rel(c.id, o.id)?.nameKnown);
    const out = [];
    for (const o of hearers) {
      if (o.id === c.id || ['sleeping', 'collapsed'].includes(o.activity.type)) continue;
      let p = TELL_BASE() * (lie ? STAKES[lie.kind] ?? 1 : 0.35);
      p *= 1.6 - cunning / 10;
      p *= 1 + 0.8 * emo('guilt') + 0.8 * emo('fear');
      p *= 1.4 - composure;
      p *= 1 - practice;
      if (impaired) p *= 1.3;
      if (close(o)) p *= 1.3;
      if (stranger(o)) p *= 0.7;
      if (this.rng() >= Math.min(0.9, p)) continue;
      // the listener notices?
      const rel = w.memory.rel(o.id, c.id);
      let n = NOTICE_BASE() * (0.6 + 0.08 * (rel?.familiarity ?? 0)) * (rel && rel.trust < 0 ? 1.3 : 1) * ((o.body?.capacities?.sight ?? 1) * 0.5 + 0.5);
      const cls = w.maps?.distanceClass?.(c.location, c.spot, o.spot) ?? 'same';
      if (cls === 'across') n *= 0.5;
      if (isDark(w, c.location)) n *= 0.4; // in the dark, faces are hard to read
      const ownFeel = Math.max(0, ...w.emotions.of(o).map((e) => e.intensity));
      if (ownFeel >= 7) n *= 0.6;
      if (o.conversationId && o.conversationId !== c.conversationId) n *= 0.6;
      if (this.rng() >= Math.min(0.95, n)) continue;
      const P = pronouns(c);
      const cue = cues()[Math.floor(this.rng() * cues().length)].replace('{name}', ref(c)).replace('{poss}', P.poss).replace('{subj}', P.subj);
      out.push({ listener: o, cue });
    }
    for (const t of out) {
      w.perceive([t.listener.id], { kind: 'action', text: t.cue, importance: 4, sourceId: c.id, roomId: c.location, data: { tell: true } });
      w.logEvent('tell', { actorId: c.id, location: c.location, to: t.listener.id, lieId: lie?.id ?? null, nervousTruth: !lie });
    }
    return out;
  }

  // ---------- contradictions (code) ----------
  /** Does what this listener knows contradict the lie? Fires a stimulus once per listener. → the reason, or null. */
  contradiction(lie, listenerId) {
    const w = this.world;
    if (!lie || lie.status !== 'standing' || listenerId === lie.liarId) return null;
    if ((lie.data.contradicted ?? []).some((x) => x.listener === listenerId)) return null;
    const L = w.citizens.get(listenerId);
    if (!L?.alive) return null;
    const why = this.#witnessed(lie, listenerId) ?? this.#toldOtherwise(lie, listenerId) ?? this.#evidence(lie, listenerId);
    if (!why) return null;
    lie.data.contradicted = [...(lie.data.contradicted ?? []), { listener: listenerId, why, at: w.now }];
    this.save(lie);
    w.perceive([listenerId], { kind: 'system', text: `That doesn't match: ${why}`, importance: 7, sourceId: lie.liarId, roomId: L.location, data: { contradiction: lie.id, about: lie.checkWho } });
    w.memory.add(listenerId, { kind: 'episodic', text: `What ${ref(w.citizens.get(lie.liarId) ?? lie.liarId)} told me doesn't match: ${why}`, importance: 6, about: [lie.liarId, ...(lie.checkWho ? [lie.checkWho] : [])], placeId: L.location, source: { contradiction: lie.id } });
    w.logEvent('contradiction', { actorId: listenerId, lieId: lie.id, liarId: lie.liarId, why });
    return why;
  }

  #witnessed(lie, listenerId) {
    const w = this.world;
    if (!lie.checkWho || lie.checkFrom == null || !lie.checkWhere) return null;
    if (lie.checkWho === listenerId) return null;
    const theirs = whereabouts(w, lie.checkWho, lie.checkFrom, lie.checkTo);
    const mine = whereabouts(w, listenerId, lie.checkFrom, lie.checkTo);
    for (const a of theirs) {
      if (a.roomId === lie.checkWhere) continue;
      for (const b of mine) {
        if (b.roomId !== a.roomId || b.asleep || b.to <= a.from || b.from >= a.to) continue;
        const who = w.citizens.get(lie.checkWho);
        return `you saw ${ref(who)} at ${w.rooms.get(a.roomId)?.name ?? 'somewhere else'} ${relativeTime(w.now - Math.max(a.from, b.from))}.`;
      }
    }
    return null;
  }

  #toldOtherwise(lie, listenerId) {
    const w = this.world;
    if (!lie.checkWho || lie.checkFrom == null || !lie.checkWhere) return null;
    for (const other of this.q.recent.all(w.now - 7 * 1440).map((r) => this.row(r))) {
      if (other.id === lie.id || other.checkWho !== lie.checkWho || !other.checkWhere || other.checkWhere === lie.checkWhere) continue;
      if (other.checkFrom == null || other.checkTo < lie.checkFrom || other.checkFrom > lie.checkTo) continue;
      if (!other.heardBy.some((h) => h.citizen_id === listenerId) && other.liarId !== listenerId) continue;
      const teller = w.citizens.get(other.liarId);
      const whoC = w.citizens.get(lie.checkWho);
      const subj = other.checkWho === other.liarId && other.liarId !== listenerId ? (whoC?.persona?.sex === 'female' ? 'she was' : whoC?.persona?.sex === 'male' ? 'he was' : 'they were') : `${ref(whoC)} was`;
      return `${other.liarId === listenerId ? 'You yourself said' : `${other.liarId === lie.liarId ? 'Earlier ' : ''}${ref(teller)} told you`} ${subj} at ${w.rooms.get(other.checkWhere)?.name ?? 'somewhere else'} then.`;
    }
    return null;
  }

  #evidence(lie, listenerId) {
    const w = this.world;
    if (!lie.checkWho || lie.checkFrom == null) return null;
    const L = w.citizens.get(listenerId);
    const rows = w.db.prepare("SELECT object_id, game_time, after FROM object_history WHERE actor_id = ? AND game_time BETWEEN ? AND ? AND action IN ('take','put','use','give','move','break','damage','ignite')").all(lie.checkWho, lie.checkFrom, lie.checkTo);
    for (const r of rows) {
      const after = J(r.after, {});
      const room = after.room ?? null;
      if (!room || room === lie.checkWhere) continue;
      const known = L.knownObjects?.[r.object_id];
      if (!known || (known.lastSeenAt ?? 0) < r.game_time || known.roomId !== room) continue; // they've seen it there since
      const o = w.objects.get(r.object_id);
      return `you've seen ${o ? w.objects.surfaceText(o) : 'something'} at ${w.rooms.get(room)?.name ?? 'another place'}, moved there ${relativeTime(w.now - r.game_time)} — by ${ref(w.citizens.get(lie.checkWho))}'s hand, by the look of it.`;
    }
    return null;
  }

  // ---------- caught, confessed ----------
  caught(lie, listener, how) {
    const w = this.world;
    if (lie.data.caughtBy?.includes(listener.id)) return;
    lie.data.caughtBy = [...(lie.data.caughtBy ?? []), listener.id];
    lie.status = 'caught';
    this.save(lie);
    const liar = w.citizens.get(lie.liarId);
    const close = (w.memory.rel(listener.id, lie.liarId)?.affinity ?? 0) >= 2;
    w.relationships.change(listener.id, lie.liarId, { trust: -3, affinity: close ? -1.5 : -1 }, { reason: `${ref(liar)} lied to me: "${lie.said.slice(0, 90)}"`, source: 'witness', evidence: { lieId: lie.id } });
    w.emotions.bump(listener, { type: close ? 'sadness' : 'anger', target: lie.liarId, delta: close ? 2.5 : 2, cause: `${ref(liar)} lied to me`, source: 'deception', raw: true });
    w.memory.add(listener.id, { kind: 'episodic', text: `${ref(liar)} lied to me: "${lie.said.slice(0, 120)}"`, importance: 8, about: [lie.liarId], placeId: listener.location, source: { lieId: lie.id, caught: how } });
    w.logEvent('lie_caught', { actorId: listener.id, lieId: lie.id, liarId: lie.liarId, how });
  }

  /** confess: lie_id → confessed; the words were the confession; the liar's guilt and fear ease. */
  confess(c, lieId, hearers) {
    const w = this.world;
    const lie = this.get(Number(lieId));
    if (!lie || lie.liarId !== c.id || lie.status !== 'standing' && lie.status !== 'caught') return null;
    lie.status = 'confessed';
    lie.data.confessedTo = hearers.map((o) => o.id);
    lie.data.confessedAt = w.now;
    this.save(lie);
    for (const e of w.emotions.of(c)) {
      if (e.type === 'guilt') w.emotions.bump(c, { type: 'guilt', target: e.target, delta: -2, cause: 'I owned up', source: 'deception', raw: true });
      if (e.type === 'fear' && /lie comes out|found out/.test(e.cause ?? '')) w.emotions.bump(c, { type: 'fear', target: null, delta: -1.5, cause: 'it is out now', source: 'deception', raw: true });
    }
    for (const o of hearers) w.memory.add(o.id, { kind: 'episodic', text: `${ref(c)} owned up to a lie: "${lie.said.slice(0, 100)}" — the truth: ${lie.truth.slice(0, 120)}`, importance: 7, about: [c.id], placeId: c.location, source: { lieId: lie.id, confessed: true } });
    c.deeds = (c.deeds ?? []).filter((d) => d.lie?.id !== lie.id);
    w.saveCitizen(c);
    w.logEvent('lie_confessed', { actorId: c.id, lieId: lie.id, to: hearers.map((o) => o.id) });
    return lie;
  }

  // ---------- the liar's prompt ----------
  storyLines(c, tier) {
    const w = this.world;
    if (tier === 'none') return [];
    const here = new Set(citizensIn(w.citizens, c.location ?? '', { exceptId: c.id }).map((o) => o.id));
    const conv = w.conversations.of(c);
    const talk = conv ? conv.lines.slice(-6).map((l) => l.text).join(' ') : '';
    const talked = new Set(namesIn(w, talk));
    const lies = this.standingOf(c, 30).filter((l) => l.heardBy.some((h) => here.has(h.citizen_id)) || l.aboutIds.some((id) => here.has(id) || talked.has(id)));
    if (!lies.length) return [];
    const to = (l) => l.heardBy.filter((h) => h.how !== 'retold').map((h) => ref(w.citizens.get(h.citizen_id) ?? h.citizen_id)).slice(0, 3).join(' and ') || 'people';
    if (tier === 'light') {
      const l = lies.find((x) => x.heardBy.some((h) => here.has(h.citizen_id))) ?? lies[0];
      return [`Careful: you told ${to(l)}: "${l.said.slice(0, 100)}"`];
    }
    return lies.slice(0, 3).map((l) => `- You told ${to(l)}: "${l.said.slice(0, 110)}" (The truth: ${l.truth.slice(0, 110)})`);
  }

  // ---------- every game minute: late contradictions ----------
  tick() {
    const w = this.world;
    if (w.now - this.lastLate < LATE_CHECK_EVERY) return;
    this.lastLate = w.now;
    for (const lie of this.q.standing.all(w.now - 7 * 1440).map((r) => this.row(r))) {
      for (const h of lie.heardBy) this.contradiction(lie, h.citizen_id);
    }
  }

  view({ liarId = null, listenerId = null, status = null, limit = 200 } = {}) {
    const name = (id) => this.world.citizens.get(id)?.name ?? id;
    return this.q.all.all(limit).map((r) => this.row(r))
      .filter((l) => (!liarId || l.liarId === liarId) && (!listenerId || l.heardBy.some((h) => h.citizen_id === listenerId)) && (!status || l.status === status))
      .map((l) => ({ ...l, liarName: name(l.liarId), checkWhoName: l.checkWho ? name(l.checkWho) : null, checkWhereName: l.checkWhere ? this.world.rooms.get(l.checkWhere)?.name ?? l.checkWhere : null, heardBy: l.heardBy.map((h) => ({ ...h, name: name(h.citizen_id), fromName: name(h.from) })) }));
  }
}
