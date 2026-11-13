// Memory & relationships: the citizens' subjective record of the world.
//
//   memories       first-person episodic / secondhand / consolidated / seed memories (DB, queried on demand)
//   relationships  directed rows (how A sees B), cached in memory, written through. No row = a stranger.
//   names          A only calls B by name if A knows it (name_confidence); otherwise by appearance
//
// Stimulus texts carry name tokens {{c:<id>}} that are resolved PER VIEWER when perceived, so a newcomer
// hears "A tall and stiff-backed man walks in" while a local hears "Bertram walks in".
//
// Never imported by server/observer; the observer sees the world from outside with real names.
import { witness } from './witness.js';

const FAMILIARITY_PER_DAY_CAP = 0.5;
const ON_MY_MIND_MAX = 6;

export const ref = (c) => `{{c:${c.id ?? c}}}`;

export class Memory {
  constructor(world) {
    this.world = world;
    this.db = world.db;
    this.rels = new Map(); // `${a}>${b}` -> row
    this.famGain = new Map(); // `${a}>${b}` -> { day, gained }
    this.overheard = new Set(); // "citizenId|conversationId": bystanders remember a conversation once
    this.stmt = {
      insert: this.db.prepare(`INSERT INTO memories (citizen_id, game_time, kind, text, importance, strength, about, place_id, source, status, is_gist, emotion, valence)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`),
      upsertRel: this.db.prepare(`INSERT INTO relationships (citizen_id, other_id, affinity, trust, familiarity, name_known, name_confidence,
                                    last_seen_at, last_seen_place, summary, updated_at)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                  ON CONFLICT(citizen_id, other_id) DO UPDATE SET affinity = excluded.affinity, trust = excluded.trust,
                                    familiarity = excluded.familiarity, name_known = excluded.name_known, name_confidence = excluded.name_confidence,
                                    last_seen_at = excluded.last_seen_at, last_seen_place = excluded.last_seen_place, summary = excluded.summary,
                                    updated_at = excluded.updated_at`),
    };
  }

  load() {
    this.rels.clear();
    for (const r of this.db.prepare('SELECT * FROM relationships').all()) {
      const row = fromDb(r);
      this.rels.set(`${row.citizenId}>${row.otherId}`, row);
    }
  }

  // ---------- relationships ----------
  rel(a, b) {
    return this.rels.get(`${a}>${b}`) ?? null;
  }

  relsOf(a) {
    const out = [];
    for (const r of this.rels.values()) if (r.citizenId === a) out.push(r);
    return out;
  }

  /**
   * Create or patch a directed relationship row (write-through).
   * Step 5.5: affinity / trust / familiarity only change through world.relationships.change(), which
   * records the reason. Called directly, this only touches names, last-seen and the summary.
   */
  upsertRel(a, b, patch = {}, { values = false } = {}) {
    if (a === b) return null;
    if (!values && ('affinity' in patch || 'trust' in patch || 'familiarity' in patch)) {
      throw new Error('relationship values change only through world.relationships.change() (a reason is required)');
    }
    const now = this.world.now;
    const cur = this.rel(a, b) ?? {
      citizenId: a, otherId: b, affinity: 0, trust: 0, familiarity: 0, nameKnown: false, nameConfidence: 0,
      lastSeenAt: null, lastSeenPlace: null, summary: null, updatedAt: now,
    };
    const next = { ...cur, ...patch, updatedAt: patch.updatedAt ?? now };
    next.affinity = clamp(next.affinity, -5, 5);
    next.trust = clamp(next.trust, -5, 5);
    next.familiarity = clamp(next.familiarity, 0, 10);
    next.nameConfidence = clamp(next.nameConfidence, 0, 1);
    this.rels.set(`${a}>${b}`, next);
    this.stmt.upsertRel.run(a, b, next.affinity, next.trust, next.familiarity, next.nameKnown ? 1 : 0, next.nameConfidence,
      next.lastSeenAt, next.lastSeenPlace, next.summary, next.updatedAt);
    this.world.bus.emit('relationship', { citizenId: a, otherId: b });
    return next;
  }

  /** Familiarity grows with contact, at most +0.5 per game day per pair. */
  addFamiliarity(a, b, amount) {
    const key = `${a}>${b}`;
    const day = Math.floor(this.world.now / 1440);
    const g = this.famGain.get(key);
    const gained = g?.day === day ? g.gained : 0;
    const add = Math.max(0, Math.min(amount, FAMILIARITY_PER_DAY_CAP - gained));
    this.famGain.set(key, { day, gained: gained + add });
    if (add <= 0) return this.rel(a, b);
    return this.world.relationships.change(a, b, { familiarity: add }, {
      reason: 'We crossed paths a few times today.', source: 'witness', aggregate: true,
    })?.row;
  }

  /** a sees b (same room): last seen, a little familiarity, a forgotten-ish name comes back a bit. */
  seen(a, b, placeId) {
    if (a === b) return;
    // Step 5.5: the very first time, how they look to you decides where trust starts.
    if (!this.rel(a, b)) this.world.strangers?.firstImpression(this.world.citizens.get(a), this.world.citizens.get(b), this.world.rooms.get(placeId));
    const r = this.rel(a, b);
    const patch = { lastSeenAt: this.world.now, lastSeenPlace: placeId ?? null };
    if (r?.nameKnown && r.nameConfidence < 1) patch.nameConfidence = Math.min(1, r.nameConfidence + 0.2);
    // Step 6: meeting again the person a grudge or a fear is about stirs it up (not every pass while together).
    const viewer = this.world.citizens.get(a);
    const metAgain = r?.lastSeenAt == null || this.world.now - r.lastSeenAt > 30;
    if (metAgain && viewer?.emotions?.length) this.world.emotions?.ruminate(viewer, b, 'encounter');
    this.upsertRel(a, b, patch);
    this.addFamiliarity(a, b, 0.05);
  }

  /** Everyone in the same room sees each other (called every few game minutes). */
  updateCoPresence() {
    const byRoom = new Map();
    for (const c of this.world.citizens.values()) {
      if (!c.alive || !c.location) continue;
      if (!byRoom.has(c.location)) byRoom.set(c.location, []);
      byRoom.get(c.location).push(c);
    }
    for (const [room, list] of byRoom) {
      if (list.length < 2) continue;
      for (const a of list) for (const b of list) if (a !== b && a.activity.type !== 'sleeping' && a.activity.type !== 'collapsed') this.seen(a.id, b.id, room);
      this.world.signals?.checkProperty(room);
    }
  }

  /** Everyone awake in one room sees each other now (on arrivals; the periodic pass covers the rest). */
  seeRoom(roomId) {
    const list = [...this.world.citizens.values()].filter((c) => c.alive && c.location === roomId);
    if (list.length < 2) return;
    for (const a of list) for (const b of list) if (a !== b && a.activity.type !== 'sleeping' && a.activity.type !== 'collapsed') this.seen(a.id, b.id, roomId);
  }

  // ---------- names ----------
  learnName(viewerId, otherId, confidence = 1) {
    if (viewerId === otherId) return;
    const r = this.rel(viewerId, otherId);
    if (r?.nameKnown && r.nameConfidence >= confidence) return;
    this.upsertRel(viewerId, otherId, { nameKnown: true, nameConfidence: Math.max(confidence, r?.nameConfidence ?? 0) });
  }

  /** After a line is spoken: listeners learn the speaker's name if they said it, and overhear the addressee's. */
  hearSpeech(speaker, text, addressee, listeners) {
    const has = (name) => new RegExp(`\\b${escapeRe(name)}\\b`, 'i').test(text);
    const saysOwn = has(speaker.name);
    const saysAddressee = addressee && has(addressee.name);
    for (const l of listeners) {
      if (saysOwn) this.learnName(l.id, speaker.id, 1);
      if (saysAddressee && l.id !== addressee.id) this.learnName(l.id, addressee.id, 0.6);
    }
  }

  /** How `viewer` refers to `other` in text. */
  nameFor(viewer, otherId, { start = false } = {}) {
    const vId = viewer.id ?? viewer;
    const other = this.world.citizens.get(otherId);
    if (!other) return start ? 'Someone' : 'someone';
    if (vId === otherId) return start ? 'You' : 'you';
    const r = this.rel(vId, otherId);
    if (r?.nameKnown && r.nameConfidence >= 0.5) return other.name;
    if (r?.nameKnown && r.nameConfidence >= 0.2) return `${other.name} (or so you think)`;
    const look = shortLook(other);
    return start ? look[0].toUpperCase() + look.slice(1) : look;
  }

  /** Replace {{c:id}} tokens for this viewer (capitalized at the start of a sentence). */
  resolveNames(viewer, text) {
    if (!text || !text.includes('{{c:')) return text;
    return text.replace(/\{\{c:([\w-]+)\}\}/g, (_m, id, offset, whole) => {
      const before = whole.slice(0, offset);
      const start = offset === 0 || /[.!?:]\s*["“]?$/.test(before) || /^\s*["“]?$/.test(before);
      return this.nameFor(viewer, id, { start });
    });
  }

  /** Labels for tool enums: names when known, otherwise "the tall man"; unique within the list. */
  labelsFor(viewer, others) {
    const seen = new Map();
    const out = new Map(); // label -> citizen
    for (const o of others) {
      const r = this.rel(viewer.id, o.id);
      let label = r?.nameKnown && r.nameConfidence >= 0.2 ? o.name : `the ${shortLook(o).replace(/^an? /, '')}`;
      const n = (seen.get(label) ?? 0) + 1;
      seen.set(label, n);
      if (n > 1) label = `${label} (${n})`;
      out.set(label, o);
    }
    return out;
  }

  /** People this citizen has a row for (they've met or heard of them). */
  knownPeople(c) {
    return this.relsOf(c.id).map((r) => this.world.citizens.get(r.otherId)).filter((o) => o && o.alive);
  }

  // ---------- memories ----------
  add(citizenId, { kind = 'episodic', text, importance, about = [], placeId = null, source = {}, gameTime = null, strength = 1, isGist = false }) {
    // Step 6: what they feel when a memory is laid down colours it. The strongest feeling involving the same
    // people (or stirred up by the same event, i.e. within the last game minute) raises its importance by
    // up to 3 and tags it with that emotion.
    let emotion = null;
    let valence = null;
    const emo = this.world.emotions;
    const who = this.world.citizens.get(citizenId);
    if (emo && who && kind !== 'seed' && (gameTime == null || this.world.now - gameTime < 60)) {
      const e = emo.strongestAbout(who, about) ?? emo.of(who).filter((x) => this.world.now - x.lastBumped <= 1).sort((x, y) => y.intensity - x.intensity)[0];
      if (e && e.intensity >= 2) {
        importance = (Number(importance) || 1) + Math.min(3, e.intensity / 3);
        emotion = e.type;
        valence = Math.round(emo.valenceOf(e.type) * Math.min(1, e.intensity / 10) * 100) / 100;
      }
    }
    const info = this.stmt.insert.run(citizenId, gameTime ?? this.world.now, kind, String(text).slice(0, 600),
      clamp(Number(importance) || 1, 1, 10), clamp(strength, 0, 1), JSON.stringify(about), placeId, JSON.stringify(source), isGist ? 1 : 0, emotion, valence);
    const id = Number(info.lastInsertRowid);
    this.world.bus.emit('memory', { citizenId, id, kind, importance });
    return id;
  }

  /** Push to "on my mind" (capped, keeps the most important). */
  pushOnMind(c, { text, importance, memoryId = null }) {
    c.onMyMind = [...(c.onMyMind ?? []), { text, importance, gameTime: this.world.now, memoryId }]
      .sort((a, b) => b.importance - a.importance || b.gameTime - a.gameTime)
      .slice(0, ON_MY_MIND_MAX);
    this.world.saveCitizen(c);
  }

  active(citizenId) {
    return this.db.prepare(`SELECT * FROM memories WHERE citizen_id = ? AND status = 'active' ORDER BY game_time`).all(citizenId).map(memFromDb);
  }

  all(citizenId, { includeForgotten = true } = {}) {
    return this.db.prepare(`SELECT * FROM memories WHERE citizen_id = ? ${includeForgotten ? '' : "AND status = 'active'"} ORDER BY game_time`)
      .all(citizenId).map(memFromDb);
  }

  countSince(citizenId, t) {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE citizen_id = ? AND game_time > ? AND kind != 'seed'`).get(citizenId, t ?? -1e12).n;
  }

  /** Memories that made it into a decision prompt get a little stronger. */
  recalled(ids) {
    if (!ids?.length) return;
    const st = this.db.prepare('UPDATE memories SET strength = MIN(1, strength + 0.05) WHERE id = ?');
    for (const id of ids) st.run(id);
  }

  setStatus(id, status, mergedInto = null) {
    this.db.prepare('UPDATE memories SET status = ?, merged_into = ? WHERE id = ?').run(status, mergedInto, id);
  }

  // ---------- hooks from World ----------
  /** A stimulus reached an awake citizen: maybe it becomes a memory. */
  onPerceived(c, s) {
    witness(this, c, s);
  }
}

// ---------- helpers ----------
/** "a tall and stiff-backed man": how a stranger looks, from the first clause of their appearance. */
export function shortLook(o) {
  const sex = String(o.persona?.sex ?? '').toLowerCase();
  const noun = sex.startsWith('f') ? 'woman' : sex.startsWith('m') ? 'man' : 'person';
  let first = String(o.persona?.appearance ?? '').split(/[,.;]/)[0].trim().toLowerCase();
  if (first.length > 40) first = first.slice(0, 40).replace(/\s+\S*$/, '');
  if (!first) return `a ${noun} you don't know`;
  const phrase = /\b(woman|man|person|girl|boy|lad)\b/.test(first) ? first : `${first} ${noun}`;
  return `${/^[aeiou]/.test(phrase) ? 'an' : 'a'} ${phrase}`;
}

function fromDb(r) {
  return {
    citizenId: r.citizen_id, otherId: r.other_id, affinity: r.affinity, trust: r.trust, familiarity: r.familiarity,
    nameKnown: Boolean(r.name_known), nameConfidence: r.name_confidence, lastSeenAt: r.last_seen_at,
    lastSeenPlace: r.last_seen_place, summary: r.summary, updatedAt: r.updated_at,
  };
}

export function memFromDb(r) {
  return {
    id: r.id, citizenId: r.citizen_id, gameTime: r.game_time, kind: r.kind, text: r.text, importance: r.importance,
    strength: r.strength, about: safeJson(r.about, []), placeId: r.place_id, source: safeJson(r.source, {}),
    status: r.status, mergedInto: r.merged_into, isGist: Boolean(r.is_gist), emotion: r.emotion ?? null, valence: r.valence ?? null,
  };
}

function safeJson(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function clamp(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
