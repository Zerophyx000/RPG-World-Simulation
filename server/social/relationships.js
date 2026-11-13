// Trust with reasons (step 5.5).
//
// world.relationships.change() is the ONLY way affinity / trust / familiarity change. Every change is
// stored in relationship_events with a first-person reason and evidence, so citizens can cite why they
// feel the way they do ("you lied to me about the mine") and every grudge can be traced.
//
//   change(a, b, { affinity, trust, familiarity }, { reason, source, evidence, aggregate, set, meta })
//     deltas by default; set: true = absolute targets (seeds, the director's sliders)
//     aggregate: true = one event per pair per game day for that reason (mere encounters), no log spam
//     meta: non-value fields for the row (nameKnown, nameConfidence, summary, lastSeenAt, lastSeenPlace)
//   A change without a reason throws.
//
// Reasons fade (nightly, like memories; big changes fade slowest) but the VALUES stay. When nothing with
// strength >= 0.3 is left the prompt says so honestly: "…though you couldn't say exactly why anymore."
// Several faded reasons are summarised into one 'consolidation' event ("He's let me down more than once.").
import { pronounsOf } from '../memory/words.js';
import { toSecond } from '../emotions/present.js';

export const SOURCES = ['reflection', 'witness', 'signal', 'first_impression', 'group', 'director', 'seed', 'consolidation', 'emotion'];
const MIN_STRENGTH = 0.3;
const ON_MIND_TRUST = 2;
const ENCOUNTER_KEEP_DAYS = 30;

const dailyFactor = (w) => (w >= 4 ? 0.99 : w >= 2 ? 0.97 : w >= 1 ? 0.92 : 0.85);
const weightOf = (e) => Math.abs(e.dTrust) + Math.abs(e.dAffinity) || Number(e.evidence?.weight) || 0;

export class Relationships {
  constructor(world) {
    this.world = world;
    this.db = world.db;
    this.daily = new Map(); // `${a}>${b}|${source}|${reason}|${day}` -> event id (aggregated encounters)
    this.listeners = [];    // (event) => void : strangers' learning, emotions' appraisal
    this.stmt = {
      insert: this.db.prepare(`INSERT INTO relationship_events (citizen_id, other_id, game_time, source, d_affinity, d_trust, d_familiarity, reason, evidence, strength)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0)`),
      bump: this.db.prepare('UPDATE relationship_events SET d_affinity = d_affinity + ?, d_trust = d_trust + ?, d_familiarity = d_familiarity + ?, game_time = ? WHERE id = ?'),
      pair: this.db.prepare('SELECT * FROM relationship_events WHERE citizen_id = ? AND other_id = ? ORDER BY game_time DESC, id DESC LIMIT ?'),
      today: this.db.prepare('SELECT id FROM relationship_events WHERE citizen_id = ? AND other_id = ? AND source = ? AND reason = ? AND game_time >= ? ORDER BY id DESC LIMIT 1'),
    };
  }

  onEvent(fn) {
    this.listeners.push(fn);
  }

  /** THE write path for relationship values. Returns { row, eventId, applied }. */
  change(a, b, deltas = {}, { reason, source = 'witness', evidence = {}, aggregate = false, set = false, meta = {}, quiet = false } = {}) {
    if (a === b) return null;
    const text = String(reason ?? '').trim();
    if (!text) throw new Error(`relationship change ${a}→${b} without a reason`);
    if (!SOURCES.includes(source)) throw new Error(`unknown relationship event source "${source}"`);
    const mem = this.world.memory;
    const cur = mem.rel(a, b);
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const target = (key) => (set && deltas[key] != null && deltas[key] !== '' ? num(deltas[key]) : (cur?.[key] ?? 0) + (set ? 0 : num(deltas[key])));
    const row = mem.upsertRel(a, b, { ...meta, affinity: target('affinity'), trust: target('trust'), familiarity: target('familiarity') }, { values: true });
    // What actually changed, after the clamps.
    const applied = {
      affinity: round(row.affinity - (cur?.affinity ?? 0)),
      trust: round(row.trust - (cur?.trust ?? 0)),
      familiarity: round(row.familiarity - (cur?.familiarity ?? 0)),
    };
    const now = this.world.now;
    let eventId = null;
    if (aggregate) {
      const day = Math.floor(now / 1440);
      const key = `${a}>${b}|${source}|${text}|${day}`;
      eventId = this.daily.get(key) ?? this.stmt.today.get(a, b, source, text, day * 1440)?.id ?? null;
      if (eventId) this.stmt.bump.run(applied.affinity, applied.trust, applied.familiarity, now, eventId);
      if (this.daily.size > 5000) this.daily.clear();
      if (eventId) this.daily.set(key, eventId);
      else {
        eventId = Number(this.stmt.insert.run(a, b, now, source, applied.affinity, applied.trust, applied.familiarity, text.slice(0, 300), JSON.stringify(evidence)).lastInsertRowid);
        this.daily.set(key, eventId);
      }
    } else {
      eventId = Number(this.stmt.insert.run(a, b, now, source, applied.affinity, applied.trust, applied.familiarity, text.slice(0, 300), JSON.stringify(evidence)).lastInsertRowid);
    }
    const ev = { id: eventId, citizenId: a, otherId: b, gameTime: now, source, dAffinity: applied.affinity, dTrust: applied.trust, dFamiliarity: applied.familiarity, reason: text, evidence, before: cur };
    if (!aggregate && !quiet) {
      const c = this.world.citizens.get(a);
      // A real shift in trust stays on their mind (not for seeds and group membership).
      if (c && Math.abs(applied.trust) >= ON_MIND_TRUST && !['seed', 'group', 'director'].includes(source)) {
        mem.pushOnMind(c, { text: mem.resolveNames(c, text), importance: 6 + Math.min(3, Math.abs(applied.trust)) });
        this.world.saveCitizen(c);
      }
      if (Math.abs(applied.trust) + Math.abs(applied.affinity) >= 1 && source !== 'seed') {
        this.world.logEvent('relationship', {
          actorId: a, location: c?.location ?? null, otherId: b, source, dAffinity: applied.affinity, dTrust: applied.trust,
          reason: text, relationshipEventId: eventId,
        });
      }
      for (const fn of this.listeners) {
        try {
          fn(ev);
        } catch (err) {
          console.warn('[relationships] listener failed:', err.message);
        }
      }
    }
    return { row, eventId, applied };
  }

  // ---------- reading ----------
  events(a, b, limit = 100) {
    return this.stmt.pair.all(a, b, limit).map(fromRow);
  }

  /** The reasons a citizen could still name for how they see someone: strongest first, recent first on ties. */
  reasons(a, b, n = 2, { exclude = null } = {}) {
    const list = this.events(a, b, 200)
      .filter((e) => e.strength >= MIN_STRENGTH && weightOf(e) > 0 && e.source !== 'group' && e.reason !== exclude)
      .map((e) => ({ ...e, score: weightOf(e) * e.strength }));
    list.sort((x, y) => y.score - x.score || y.gameTime - x.gameTime);
    // the same sentence twice (a seed and a later summary of it) reads badly
    const seen = new Set();
    const out = [];
    for (const e of list) {
      if (seen.has(e.reason)) continue;
      seen.add(e.reason);
      out.push(e);
      if (out.length >= n) break;
    }
    return out;
  }

  /** Any reason at all still strong enough to name (group ties count: "she's my sister" is a reason). */
  hasNameableReason(a, b) {
    return this.events(a, b, 200).some((e) => e.strength >= MIN_STRENGTH && weightOf(e) > (e.source === 'group' ? 1 : 0));
  }

  /**
   * Prompt text after the relationship sentence: up to two reasons, or the honest
   * "though you couldn't say exactly why anymore" when the stance is clear but the reasons have faded.
   * Returns { text, faded }.
   */
  reasonsText(viewer, other, rel) {
    if (!rel) return { text: '', faded: false };
    const mem = this.world.memory;
    const rs = this.reasons(viewer.id, other.id, 2, { exclude: rel.summary });
    if (rs.length) return { text: rs.map((e) => sentence(toSecond(mem.resolveNames(viewer, e.reason)))).join(' '), faded: false, reasons: rs };
    const clear = Math.abs(rel.trust) >= 2 || Math.abs(rel.affinity) >= 2;
    if (clear && !this.hasNameableReason(viewer.id, other.id)) {
      const p = pronounsOf(other);
      const stance = rel.trust <= -2 ? `You don't trust ${p.obj}` : rel.affinity <= -2 ? `You don't like ${p.obj}`
        : rel.trust >= 2 ? `You trust ${p.obj}` : `You're fond of ${p.obj}`;
      return { text: `${stance}, though you couldn't say exactly why anymore.`, faded: true };
    }
    return { text: '', faded: false };
  }

  // ---------- nightly: fading and summaries ----------
  /** Reasons fade with the same daily factors as memories, keyed by how big the change was. */
  decay(citizenId, days) {
    if (!(days > 0)) return;
    const rows = this.db.prepare('SELECT * FROM relationship_events WHERE citizen_id = ? AND strength > 0.02').all(citizenId).map(fromRow);
    const upd = this.db.prepare('UPDATE relationship_events SET strength = ? WHERE id = ?');
    for (const e of rows) upd.run(Math.max(0, e.strength * dailyFactor(weightOf(e)) ** days), e.id);
    // Mere "we crossed paths" rows carry no reason worth keeping forever.
    this.db.prepare(`DELETE FROM relationship_events WHERE citizen_id = ? AND d_affinity = 0 AND d_trust = 0 AND source IN ('witness', 'reflection')
                     AND game_time < ? AND json_extract(evidence, '$.weight') IS NULL`).run(citizenId, this.world.now - ENCOUNTER_KEEP_DAYS * 1440);
    this.summarizeFaded(citizenId);
  }

  /** Two or more faded reasons about one person become a single compressed, citable one (zero deltas). */
  summarizeFaded(citizenId) {
    const rows = this.db.prepare(`SELECT * FROM relationship_events WHERE citizen_id = ? AND strength < ? AND source NOT IN ('consolidation', 'group')
                                  AND json_extract(evidence, '$.summarized') IS NULL`).all(citizenId, MIN_STRENGTH).map(fromRow).filter((e) => weightOf(e) > 0);
    const by = new Map();
    for (const e of rows) by.set(e.otherId, [...(by.get(e.otherId) ?? []), e]);
    const mark = this.db.prepare("UPDATE relationship_events SET evidence = json_set(evidence, '$.summarized', 1) WHERE id = ?");
    let n = 0;
    for (const [otherId, list] of by) {
      if (list.length < 2) continue;
      const other = this.world.citizens.get(otherId);
      const p = pronounsOf(other);
      const S = p.subj === 'they' ? 'They' : p.subj[0].toUpperCase() + p.subj.slice(1);
      const has = p.subj === 'they' ? "'ve" : "'s";
      const sum = list.reduce((s, e) => s + e.dTrust + e.dAffinity, 0);
      const reason = sum < 0 ? `${S}${has} let me down more than once.` : `${S}${has} been good to me more than once.`;
      const weight = Math.min(4, list.reduce((s, e) => s + weightOf(e), 0) / 2);
      this.stmt.insert.run(citizenId, otherId, this.world.now, 'consolidation', 0, 0, 0, reason, JSON.stringify({ weight, summarizes: list.map((e) => e.id) }));
      for (const e of list) mark.run(e.id);
      n++;
    }
    return n;
  }

  /** Startup check (acceptance 1): no relationship without at least one reason. Repairs with a seed event. */
  consistencyCheck() {
    const missing = this.db.prepare(`SELECT r.citizen_id, r.other_id, r.summary, r.familiarity FROM relationships r
      WHERE (r.affinity != 0 OR r.trust != 0 OR r.familiarity != 0)
        AND NOT EXISTS (SELECT 1 FROM relationship_events e WHERE e.citizen_id = r.citizen_id AND e.other_id = r.other_id)`).all();
    for (const r of missing) {
      const reason = String(r.summary ?? '').trim() || (r.familiarity >= 5 ? "We've known each other for years." : "We've met before.");
      this.stmt.insert.run(r.citizen_id, r.other_id, this.world.now, 'seed', 0, 0, 0, reason.slice(0, 300), '{"repair":true}');
    }
    if (missing.length) console.warn(`[relationships] ${missing.length} relationships had no reason on record; added seed reasons`);
    return missing.length;
  }
}

function fromRow(r) {
  let evidence = {};
  try {
    evidence = JSON.parse(r.evidence);
  } catch { /* keep {} */ }
  return {
    id: r.id, citizenId: r.citizen_id, otherId: r.other_id, gameTime: r.game_time, source: r.source,
    dAffinity: r.d_affinity, dTrust: r.d_trust, dFamiliarity: r.d_familiarity, reason: r.reason, evidence, strength: r.strength,
  };
}

function sentence(s) {
  const t = String(s).trim();
  return /[.!?…"]$/.test(t) ? t : `${t}.`;
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}
