// Step 7B: body, injuries, illness and death. World.body is the ONE place that writes conditions.
//
//   world.body.damage(id, { damageType, part, amount, cause, sourceId })   the damage API (accidents, events, weapons)
//   world.body.injure(id, { type, part, severity, cause, ... })            a specific condition (director / tests)
//   world.body.heal / restorePart / setRegen                               hooks for future (RPG) healing
//   world.body.treat(...)                                                  see treat.js
//
// Citizen state (c.body): { vitality, blood, parts (cache: only parts that differ), capacities, status, pain, regen,
// critical, tourniquets… }. Conditions live in the `conditions` table (rows mirrored in memory per citizen).
// Everything here is code: no LLM calls. Bleeding and clotting run every clock tick; healing, infection and the rest
// every 10 game minutes per citizen with something going on.
import { config } from '../config.js';
import { citizensIn } from '../world/rooms.js';
import { ref } from '../memory/index.js';
import { loadBodyContent, bySeverity, clamp } from './content.js';
import { computeBody, stageFor } from './model.js';
import { stepWounds, bleedWord, survivable, appliedDrain } from './bleeding.js';
import { healTick, infectionTick, rollSequelae, isClosed } from './healing.js';
import { applyDamage, makeWound, rollVessel, depthFor } from './damage.js';
import { ensureGarments, wornGarments, garmentsCovering, setBloodied } from './garments.js';
import { killCitizen } from './death.js';
import { collapse, revive } from '../world/actions.js';
import { sizeFactor } from './bleeding.js';
import { dropCarried } from './treat.js';
import { restock } from './supplies.js';
import { activityAccident, moveAccident, exposure } from './accidents.js';
import { loadScenario } from '../world/scenarios.js';

const SLOW_EVERY = 10; // game minutes
const httpError = (status, message) => Object.assign(new Error(message), { status });
const r1 = (v) => Math.round(v * 10) / 10;
const json = (v, f) => {
  try {
    return typeof v === 'string' ? JSON.parse(v) : v ?? f;
  } catch {
    return f;
  }
};

function fromRow(r) {
  return {
    id: r.id, citizenId: r.citizen_id, type: r.type, partId: r.part_id, severity: r.severity, initialSeverity: r.initial_severity,
    bleeding: r.bleeding, geometry: json(r.geometry, {}), clot: r.clot, pain: r.pain, infection: r.infection,
    treatments: json(r.treatments, []), flags: json(r.flags, {}), healing: r.healing, permanent: Boolean(r.permanent),
    curableBy: json(r.curable_by, []), visible: Boolean(r.visible), detectDifficulty: r.detect_difficulty, cause: r.cause,
    sourceId: r.source_id, onsetAt: r.onset_at, resolvedAt: r.resolved_at,
  };
}

export class Body {
  constructor(world) {
    this.world = world;
    this.db = world.db;
    this.content = loadBodyContent();
    this.conds = new Map();     // citizenId -> [condition] (active ones, in memory)
    this.dirty = new Set();     // conditions whose dynamic fields changed since the last flush
    this.pending = new Map();   // citizenId -> [new conditions] (told to the patient and the room once, in afterChange)
    this.dying = new Set();
    this.rng = Math.random;     // tests can swap in a seeded one
    this.stmt = {
      insert: this.db.prepare(`INSERT INTO conditions (citizen_id, type, part_id, severity, initial_severity, bleeding, geometry, clot, pain,
        infection, treatments, flags, healing, permanent, curable_by, visible, detect_difficulty, cause, source_id, onset_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, 0, 0, 0, '[]', ?, 0, ?, ?, ?, ?, ?, ?, ?)`),
      update: this.db.prepare(`UPDATE conditions SET severity = ?, initial_severity = ?, bleeding = ?, geometry = ?, clot = ?, pain = ?, infection = ?,
        treatments = ?, flags = ?, healing = ?, permanent = ?, visible = ?, resolved_at = ? WHERE id = ?`),
    };
  }

  // ---------- boot ----------
  load() {
    this.conds.clear();
    for (const row of this.db.prepare('SELECT * FROM conditions WHERE resolved_at IS NULL ORDER BY id').all()) {
      const cond = fromRow(row);
      if (!this.conds.has(cond.citizenId)) this.conds.set(cond.citizenId, []);
      this.conds.get(cond.citizenId).push(cond);
    }
    for (const c of this.world.citizens.values()) this.ensureState(c);
  }

  /** Make sure a citizen has body state (new worlds, old rows, new citizens): HP becomes vitality, garments are seeded. */
  ensureState(c) {
    if (c.kind !== 'citizen' && c.kind !== 'shadow' && c.kind !== 'avatar') return;
    let fresh = false;
    if (!c.body || typeof c.body !== 'object' || !Number.isFinite(c.body.vitality)) {
      const hp = Number(c.needs?.hp ?? 100);
      const hpMax = Math.max(1, Number(c.needs?.hpMax ?? 100));
      c.body = { vitality: clamp((hp / hpMax) * 100, 0, 100), blood: 100, regen: 1.0 };
      fresh = true;
      // missing hp = "earlier injuries": a generic bruise on a random part
      if (hp < hpMax && c.alive) {
        const part = this.content.resolveParts('torso').filter((id) => !this.content.parts.get(id).internal)[0] ?? 'torso';
        const parts = [...this.content.parts.values()].filter((p) => p.hitWeight > 0);
        const pick = parts[Math.floor(this.rng() * parts.length)]?.id ?? part;
        this.addCondition(c, { type: 'bruise', partId: pick, severity: clamp(Math.round(((hpMax - hp) / hpMax) * 100) / 10, 1, 10), cause: 'earlier injuries', quiet: true });
      }
    }
    const b = c.body;
    b.blood = Number.isFinite(b.blood) ? b.blood : 100;
    b.regen = Number.isFinite(b.regen) ? b.regen : 1;
    b.parts ??= {};
    b.capacities ??= {};
    b.status ??= [];
    b.pain ??= 0;
    b.tourniquets ??= [];
    b.critical ??= null;
    b.windows ??= 0;
    b.sinceSlow ??= 0;
    if (c.alive) ensureGarments(this.world, c);
    // provisional practice (accidents) for worlds from before this step: taken from the scenario content, once
    if (!b.practiceSeeded) {
      b.practiceSeeded = true;
      if (!c.persona?.practiced?.length) {
        try {
          const def = loadScenario(this.world.scenario).citizens?.find((x) => x.id === c.id);
          if (def?.persona?.practiced?.length) c.persona.practiced = [...def.persona.practiced];
        } catch { /* unknown scenario */ }
      }
    }
    this.recompute(c, { quiet: true });
    if (fresh) this.world.saveCitizen(c);
  }

  // ---------- conditions ----------
  active(citizenId) {
    return this.conds.get(citizenId) ?? [];
  }

  /** All conditions of a citizen (including resolved) for the API. */
  allOf(citizenId) {
    return this.db.prepare('SELECT * FROM conditions WHERE citizen_id = ? ORDER BY id').all(citizenId).map((r) => {
      const live = this.conds.get(citizenId)?.find((x) => x.id === r.id);
      return live ?? fromRow(r);
    });
  }

  conditionById(citizenId, id) {
    return this.active(citizenId).find((x) => x.id === Number(id)) ?? null;
  }

  /**
   * THE write path for new conditions. spec: { type, partId, severity, cause, sourceId?, geometry?, flags?, permanent?,
   * curableBy?, quiet? }. Systemic types (fever, chill, anemia) merge into an existing one.
   */
  addCondition(c, spec) {
    const def = this.content.typeDef(spec.type);
    if (!def) throw httpError(400, `unknown condition type "${spec.type}" (${Object.keys(this.content.types).join(', ')})`);
    let partId = def.systemic ? null : spec.partId ?? spec.part ?? null;
    if (!def.systemic) {
      if (!partId || !this.content.parts.has(partId)) throw httpError(400, `${spec.type} needs a body part (e.g. ${[...this.content.parts.keys()].slice(0, 6).join(', ')}…)`);
      if (def.partsOnly && !def.partsOnly.includes(partId)) throw httpError(400, `${spec.type} can only affect ${def.partsOnly.join(', ')}`);
    }
    const severity = clamp(Number(spec.severity) || 1, 0.5, 10);
    const list = this.conds.get(c.id) ?? this.conds.set(c.id, []).get(c.id);
    if (def.systemic) {
      const same = list.find((x) => x.type === spec.type);
      if (same) {
        same.severity = Math.max(same.severity, severity);
        same.initialSeverity = Math.max(same.initialSeverity, same.severity);
        this.#touch(same);
        if (!spec.quiet) this.afterChange(c);
        return same;
      }
    }
    if (partId && this.missingParts(c).has(partId) && spec.type !== 'severed') return null; // nothing left to hurt
    let geometry = spec.geometry ?? {};
    if (!spec.geometry) geometry = this.#defaultGeometry(spec, def, partId, severity);
    const flags = { ...(spec.flags ?? {}) };
    const permanent = Boolean(spec.permanent ?? def.permanent);
    const detect = spec.detectDifficulty ?? Math.max(def.detect ?? 0, geometry.internal ? 7 : 0);
    const info = this.stmt.insert.run(
      c.id, spec.type, partId, severity, severity, JSON.stringify(geometry), JSON.stringify(flags), permanent ? 1 : 0,
      JSON.stringify(spec.curableBy ?? def.curableBy ?? []), (spec.visible ?? def.visible) === false || geometry.internal ? 0 : 1, detect,
      String(spec.cause ?? 'an injury').slice(0, 200), spec.sourceId ?? null, this.world.now,
    );
    const cond = fromRow(this.db.prepare('SELECT * FROM conditions WHERE id = ?').get(Number(info.lastInsertRowid)));
    list.push(cond);
    this.world.logEvent('condition', {
      actorId: c.id, location: c.location, action: 'add', conditionId: cond.id, type: cond.type, part: cond.partId, severity: r1(cond.severity),
      cause: cond.cause, ...(geometry.vessel ? { vessel: geometry.vessel, depth: geometry.depth, length: geometry.length_cm } : {}),
    });
    if (!spec.quiet && !cond.permanent) {
      if (!this.pending.has(c.id)) this.pending.set(c.id, []);
      this.pending.get(c.id).push(cond);
      c.body.lastCause = cond.cause;
    }
    if (!spec.quiet) this.afterChange(c);
    return cond;
  }

  #defaultGeometry(spec, def, partId, severity) {
    const D = this.content.damage;
    if (!def.open && !(spec.type === 'fracture' && spec.compound) && !spec.compound) {
      if (spec.type === 'burn') return { area_cm2: Math.round(severity * 28), depth: severity >= 7 ? 'deep' : 'moderate' };
      return {};
    }
    if (spec.type === 'severed') {
      const v = rollVessel(this.rng, this.content, partId, 'penetrating');
      return { length_cm: 20, depth: 'penetrating', gape: 1, vessel: v === 'capillary' ? 'venous' : v, internal: false };
    }
    const depth = spec.depth ?? (severity <= 2 ? 'superficial' : severity <= 4 ? 'moderate' : severity <= 7 ? 'deep' : depthFor({ ...D, depthByAmount: [[0, 'penetrating']] }, 99, partId, this.content));
    const g = D.geometry[spec.type === 'puncture' ? 'pierce' : 'cut'];
    return {
      length_cm: spec.length ?? Math.round(severity * (spec.type === 'puncture' ? 0.6 : 1.6) * 10) / 10, depth, gape: spec.gape ?? g.gape,
      vessel: spec.vessel ?? rollVessel(this.rng, this.content, partId, depth), internal: false,
    };
  }

  #touch(cond) {
    this.dirty.add(cond);
  }

  markDirty(cond) {
    this.dirty.add(cond);
  }

  save(cond) {
    this.stmt.update.run(
      cond.severity, cond.initialSeverity, cond.bleeding, JSON.stringify(cond.geometry), cond.clot, cond.pain, cond.infection,
      JSON.stringify(cond.treatments), JSON.stringify(cond.flags), cond.healing, cond.permanent ? 1 : 0, cond.visible ? 1 : 0, cond.resolvedAt, cond.id,
    );
    this.dirty.delete(cond);
  }

  flush() {
    for (const cond of [...this.dirty]) this.save(cond);
  }

  resolve(c, cond, reason = 'healed') {
    if (cond.resolvedAt != null) return;
    cond.resolvedAt = this.world.now;
    cond.bleeding = 0;
    this.save(cond);
    const list = this.conds.get(c.id) ?? [];
    this.conds.set(c.id, list.filter((x) => x !== cond));
    this.world.logEvent('condition', { actorId: c.id, location: c.location, action: 'resolve', conditionId: cond.id, type: cond.type, part: cond.partId, reason });
    if (reason === 'healed') {
      for (const s of rollSequelae(this.content, cond, this.rng)) {
        this.addCondition(c, { type: s.type, partId: s.partId, severity: s.severity, cause: `after a ${cond.type}`, permanent: true, sourceId: `cond:${cond.id}`, quiet: true });
      }
    }
  }

  // ---------- the damage API ----------
  damage(citizenId, spec) {
    const c = this.#citizen(citizenId);
    return applyDamage(this, c, spec);
  }

  /** Director / tests: one specific condition, or a damage hit if type is a damage type. */
  injure(citizenId, spec) {
    const c = this.#citizen(citizenId);
    if (!c.alive) throw httpError(400, `${c.name} is dead`);
    const type = String(spec.type ?? spec.damageType ?? '');
    if (['pierce', 'blunt', 'blast'].includes(type) || (type === 'burn' && spec.amount != null) || (type === 'cut' && spec.amount != null)) {
      return this.damage(citizenId, { damageType: type, part: spec.part ?? 'random', amount: spec.amount ?? spec.severity ?? 8, cause: spec.cause });
    }
    const part = spec.part ?? spec.partId;
    const cond = this.addCondition(c, {
      type, partId: part, severity: spec.severity ?? 5, cause: spec.cause ?? 'an injury', sourceId: 'director', flags: spec.flags,
      geometry: spec.geometry, vessel: spec.vessel, depth: spec.depth, length: spec.length, gape: spec.gape, compound: spec.compound,
      permanent: spec.permanent, curableBy: spec.curableBy,
    });
    return { conditions: cond ? [cond] : [], garments: [], parts: [part] };
  }

  // ---------- future healing hooks (RPG step) ----------
  heal(citizenId, { conditionId = null, partId = null, all = false, amount = 3, source = 'director', allowPermanent = false } = {}) {
    const c = this.#citizen(citizenId);
    let list = this.active(c.id);
    if (conditionId != null) list = list.filter((x) => x.id === Number(conditionId));
    else if (partId) list = list.filter((x) => x.partId === partId);
    else if (!all) throw httpError(400, 'heal needs conditionId, partId or all');
    const healed = [];
    for (const cond of [...list]) {
      if (cond.permanent) {
        const tag = String(source);
        if (!allowPermanent || !(cond.curableBy ?? []).includes(tag)) continue;
        this.resolve(c, cond, `cured by ${tag}`);
        healed.push(cond.id);
        continue;
      }
      if (cond.type === 'anemia') continue;
      cond.flags.externalHeal = true;
      cond.severity = Math.max(0, cond.severity - amount);
      cond.healing = clamp(1 - cond.severity / Math.max(0.1, cond.initialSeverity), 0, 1);
      if (cond.severity <= 0.4) this.resolve(c, cond, 'healed');
      else this.#touch(cond);
      healed.push(cond.id);
    }
    this.world.logEvent('body_heal', { actorId: c.id, location: c.location, source, amount, conditions: healed });
    this.afterChange(c);
    return { healed };
  }

  restorePart(citizenId, partId, { source = 'director' } = {}) {
    const c = this.#citizen(citizenId);
    const ids = new Set([partId, ...this.content.descendants(partId)]);
    const gone = this.active(c.id).filter((x) => ids.has(x.partId) && (x.type === 'severed' || x.type === 'organ_damage' && x.severity >= 10));
    for (const cond of gone) this.resolve(c, cond, `restored by ${source}`);
    this.world.logEvent('body_restore', { actorId: c.id, location: c.location, part: partId, source, conditions: gone.map((x) => x.id) });
    this.afterChange(c);
    return { restored: gone.map((x) => x.id) };
  }

  setRegen(citizenId, multiplier, { source = 'director', until = null } = {}) {
    const c = this.#citizen(citizenId);
    c.body.regen = clamp(Number(multiplier) || 1, 0, 10);
    c.body.regenUntil = until;
    this.world.logEvent('body_regen', { actorId: c.id, location: c.location, regen: c.body.regen, source, until });
    this.world.saveCitizen(c);
    return { regen: c.body.regen };
  }

  /** One entry of a director profile: { damageType, part, amount: n | [a, b], count } or { condition, part?, severity, chance, temporary }. */
  applyProfileEntry(c, h, cause, sourceId = null) {
    const range = (v, d) => (Array.isArray(v) ? v[0] + this.rng() * (v[1] - v[0]) : v ?? d);
    if (h.chance != null && this.rng() > h.chance) return [];
    const count = Array.isArray(h.count) ? Math.round(range(h.count, 1)) : h.count ?? 1;
    const out = [];
    for (let i = 0; i < count; i++) {
      if (h.condition) {
        const def = this.content.typeDef(h.condition);
        const part = h.part ?? (def?.partsOnly ? def.partsOnly[Math.floor(this.rng() * def.partsOnly.length)] : null);
        const cond = this.addCondition(c, { type: h.condition, partId: part, severity: range(h.severity, 3), cause, sourceId, flags: h.temporary ? { temporary: true } : {} });
        if (cond) out.push(cond);
      } else {
        out.push(...this.damage(c.id, { damageType: h.damageType ?? 'blunt', part: h.part ?? 'random', amount: range(h.amount, 8), cause, sourceId }).conditions);
      }
    }
    return out;
  }

  kill(citizenId, cause = 'the director') {
    const c = this.#citizen(citizenId);
    return killCitizen(this, c, { cause, reason: 'director' });
  }

  die(c, { cause, reason }) {
    return killCitizen(this, c, { cause: cause ?? this.deathCause(c, reason), reason });
  }

  /** Director revive: vitality 30, conditions stay. */
  reviveCitizen(citizenId) {
    const c = this.#citizen(citizenId);
    if (!c.alive) throw httpError(400, `${c.name} is dead; revive restores the unconscious, not the dead`);
    c.body.vitality = Math.max(c.body.vitality, 30);
    c.body.blood = Math.max(c.body.blood, 55);
    c.body.permanentlyDown = false;
    this.recompute(c);
    if (c.activity.type === 'collapsed') revive(this.world, c, { by: 'director' });
    this.world.saveCitizen(c);
    return { ok: true, vitality: c.body.vitality, blood: c.body.blood };
  }

  #citizen(id) {
    const c = this.world.citizens.get(id);
    if (!c) throw httpError(404, `unknown citizen "${id}"`);
    if (!c.body) this.ensureState(c);
    return c;
  }

  // ---------- derived state ----------
  missingParts(c) {
    const out = new Set();
    for (const cond of this.active(c.id)) {
      if (cond.type !== 'severed' || !cond.partId) continue;
      out.add(cond.partId);
      for (const d of this.content.descendants(cond.partId)) out.add(d);
    }
    return out;
  }

  /** Carried / worn aids that change the numbers. */
  aidsOf(c) {
    const O = this.world.objects;
    const aids = { crutch: false, peg: {}, eyePatch: false, sling: false };
    for (const o of O.carriedBy(c.id)) if (o.typeId === 'crutch') aids.crutch = true;
    const missing = this.missingParts(c);
    for (const o of O.wornBy(c.id)) {
      if (o.typeId === 'peg_leg') for (const side of ['left', 'right']) if (missing.has(`shin_${side}`) || missing.has(`foot_${side}`)) aids.peg[side] = true;
      if (o.typeId === 'eye_patch') aids.eyePatch = true;
      if (o.typeId === 'sling') aids.sling = true;
    }
    return aids;
  }

  /** Recompute (and cache) capacities, status, pain; mirror vitality; react to unconsciousness and vital loss. */
  recompute(c, { quiet = false } = {}) {
    const st = c.body;
    const conds = this.active(c.id);
    const r = computeBody(this.content, { conds, blood: st.blood, vitality: st.vitality, fatigue: c.needs?.fatigue ?? 0, aids: this.aidsOf(c), now: this.world.now });
    const before = st.status ?? [];
    st.parts = r.parts;
    st.capacities = r.capacities;
    st.status = r.status;
    st.pain = r.pain;
    st.stage = r.stage;
    st.fatigueFactor = r.fatigueFactor;
    st.chips = [
      ...(conds.some((x) => x.bleeding > 0.3) ? ['bleeding'] : []),
      ...(conds.some((x) => x.type === 'fracture' && x.severity >= 2) ? ['fracture'] : []),
      ...(conds.some((x) => x.type === 'fever' || x.type === 'infection') ? ['fever'] : []),
      ...(r.status.includes('unconscious') ? ['unconscious'] : []),
    ];
    if (c.needs) {
      c.needs.hp = r1(st.vitality);
      c.needs.hpMax = 100;
    }
    if (!quiet && c.alive) {
      const added = r.status.filter((s) => !before.includes(s));
      const removed = before.filter((s) => !r.status.includes(s));
      if (added.length || removed.length) this.world.logEvent('body_status', { actorId: c.id, location: c.location, added, removed, capacities: r.capacities });
    }
    if (!c.alive) return r;
    for (const id of r.destroyed) if (this.content.parts.get(id)?.vital) return this.#fatal(c, `a fatal wound to the ${this.content.partLabel(id)}`, r);
    for (const id of r.missing) if (this.content.parts.get(id)?.vital) return this.#fatal(c, `losing ${this.content.partLabel(id)}`, r);
    const cons = r.capacities.consciousness;
    if (!quiet || cons < 0.3) {
      if (cons < 0.3 && c.activity.type !== 'collapsed') this.knockOut(c, { reason: 'unconscious' });
      else if (cons >= 0.35 && c.activity.type === 'collapsed' && c.activity.detail?.reason === 'unconscious' && !c.body.permanentlyDown) this.#wakeUp(c);
    }
    return r;
  }

  #fatal(c, cause, r) {
    this.die(c, { cause, reason: 'injury' });
    return r;
  }

  afterChange(c) {
    if (!c.alive) return;
    this.recompute(c);
    this.#tellAboutNew(c);
    this.world.saveCitizen(c);
  }

  /** The new wounds, told once: to the patient as a sensation, to the room as what can be seen (with the feelings that follow). */
  #tellAboutNew(c) {
    const list = this.pending.get(c.id);
    if (!list?.length) return;
    this.pending.delete(c.id);
    const W = this.world;
    const fresh = list.filter((x) => x.resolvedAt == null).sort((a, b) => b.severity - a.severity);
    if (!fresh.length) return;
    const top = fresh.slice(0, 2);
    const severity = top[0].severity;
    W.perceive([c.id], {
      kind: 'body', text: `${top.map((x) => this.woundText(x).feel).filter(Boolean).join(' ')}${fresh.length > 2 ? ' And more besides.' : ''}`.trim(),
      importance: clamp(Math.round(3 + severity * 0.6), 4, 9), roomId: c.location, data: { injury: true },
    });
    if (fresh[0].partId || fresh[0].type) {
      W.memory.add(c.id, { kind: 'episodic', text: `I was hurt: ${fresh[0].cause}. ${this.woundText(fresh[0]).feel}`.trim(), importance: clamp(Math.round(3 + severity * 0.5), 4, 8), placeId: c.location, source: { self: true } });
    }
    const seen = fresh.filter((x) => x.visible && x.partId);
    if (!seen.length || !c.location) return;
    const worst = seen[0];
    const text = `${ref(c)} is hurt: ${this.woundText(worst).look}${seen.length > 1 ? ` (and ${seen.length - 1} more)` : ''}.`;
    const importance = clamp(Math.round(4 + worst.severity * 0.5), 5, 8);
    const witnesses = citizensIn(W.citizens, c.location, { exceptId: c.id });
    W.perceive(witnesses.map((o) => o.id), { kind: 'action', text, importance, sourceId: c.id, roomId: c.location, data: { injury: true } });
    for (const o of witnesses) {
      if (o.activity.type === 'sleeping' || o.activity.type === 'collapsed' || !W.emotions?.appraisal) continue;
      const affinity = W.memory.rel(o.id, c.id)?.affinity ?? 0;
      if (affinity >= 3 || W.groups.shared(o.id, c.id, ['party', 'family', 'household']).length) W.emotions.appraisal.fire(o, 'loved_one_hurt', { other: c.id });
      else if (worst.severity >= 5 || worst.bleeding > 5) W.emotions.appraisal.fire(o, 'saw_blood', { other: c.id });
    }
  }

  /** Moving on a healed-over wound can reopen it (legs when walking; anything when crawling). Keeping still prevents it. */
  /** Working at a hot or sharp thing for `minutes`: maybe an accident. → text for the finish line */
  accidentCheck(c, { object, minutes = 10 } = {}) {
    return activityAccident(this.world, c, object, minutes);
  }

  onMove(c, { crawl = false, toId = null } = {}) {
    if (!c.body) return;
    moveAccident(this.world, c, { crawl, toId });
    const R = this.content.bleeding.rebleed;
    for (const cond of this.active(c.id)) {
      if (!cond.flags?.clotted || cond.geometry?.internal || !cond.geometry?.vessel) continue;
      const limb = this.content.limbOf(cond.partId);
      if (!(limb === 'leg' || crawl)) continue;
      let p = R.perMove * (1 + sizeFactor(this.content.bleeding, cond) * R.sizeMult * 10);
      if (cond.geometry.vessel.endsWith('arterial')) p *= R.arterialMult;
      if (crawl) p *= 1.5;
      if (this.rng() < p) {
        cond.clot = Math.min(cond.clot, R.resetTo);
        delete cond.flags.clotted;
        this.#touch(cond);
        this.world.logEvent('rebleed', { actorId: c.id, location: c.location, conditionId: cond.id, part: cond.partId });
        this.world.perceive([c.id], { kind: 'body', text: `The wound in your ${this.content.partLabel(cond.partId)} has torn open again.`, importance: 6, roomId: c.location });
      }
    }
  }

  /** Did any of these citizens get hurt, treated or die since `since`? (reflection gating) */
  involvedSince(ids, since) {
    if (!ids?.length) return false;
    const q = ids.map(() => '?').join(',');
    return Boolean(this.db.prepare(`SELECT 1 FROM events WHERE game_time >= ? AND type IN ('injury', 'treatment', 'death') AND actor_id IN (${q}) LIMIT 1`).get(since ?? 0, ...ids));
  }

  knockOut(c, { reason = 'unconscious' } = {}) {
    if (c.activity.type === 'collapsed') return;
    if (c.carryingPerson) dropCarried(this.world, c, 'dropped');
    c.body.unconsciousSince = this.world.now;
    collapse(this.world, c, { reason });
  }

  #wakeUp(c) {
    const since = c.body.unconsciousSince ?? this.world.now;
    c.body.unconsciousSince = null;
    revive(this.world, c, { by: null, text: 'You come to. Your head swims; you remember nothing of the time that passed.', body: true });
    // the memory gap (step 4): not a memory of what happened, a note that time was lost
    this.world.memory.add(c.id, { kind: 'episodic', text: c.body.lastCause ? `I blacked out after ${c.body.lastCause}. The next thing I knew, I was coming round.` : 'I blacked out. The next thing I knew, I was coming round.', importance: 5, placeId: c.location, source: { self: true } });
    // a memory gap, not a memory (step 4): a short note so they know time was lost
    this.world.logEvent('wake_unconscious', { actorId: c.id, location: c.location, minutes: Math.round(this.world.now - since) });
  }

  // ---------- the clock ----------
  tick(elapsed, now) {
    const needs = this.world.needs;
    this.#criticalSlowdown();
    if (now - (this.lastRestock ?? -Infinity) >= SLOW_EVERY) { this.lastRestock = now; restock(this.world, now); } // supplies come back on a timer
    if (now - (this.lastExposure ?? now) >= SLOW_EVERY) { // out in the cold and wet (healthy people too)
      const minutes = now - this.lastExposure;
      this.lastExposure = now;
      for (const c of this.world.citizens.values()) if (c.alive && c.body && c.location) exposure(this.world, c, minutes);
    } else if (this.lastExposure == null) this.lastExposure = now;
    for (const c of this.world.citizens.values()) {
      if (!c.alive) continue;
      if (!c.body) this.ensureState(c);
      const st = c.body;
      const conds = this.active(c.id);
      if (!conds.length && st.blood >= 100 && st.vitality >= 100 && !st.critical && (c.needs?.hunger ?? 0) < needs.starvingAt && !st.regenUntil) continue;
      this.#step(c, conds, elapsed, now);
    }
  }

  /** CRITICAL_SLOWDOWN (default 1 = off): slower game time while a critical window is open and someone conscious is present. */
  #criticalSlowdown() {
    const k = config.body.criticalSlowdown;
    let want = 1;
    if (k < 1) {
      for (const c of this.world.citizens.values()) {
        if (!c.alive || !c.body?.critical) continue;
        const aware = (x) => x.alive && !['sleeping', 'collapsed'].includes(x.activity.type);
        if (aware(c) || citizensIn(this.world.citizens, c.location, { exceptId: c.id }).some(aware)) { want = k; break; }
      }
    }
    this.world.clock.setBodyMultiplier(want);
  }

  /** Heavy bleeding in a room leaves a bloodstain that later arrivals see. */
  #bloodstain(c, drain) {
    const st = c.body;
    if (!c.location || drain <= 0) return;
    st.stain = st.stain?.room === c.location ? st.stain : { room: c.location, lost: 0 };
    st.stain.lost += drain;
    if (st.stain.lost < 6) return;
    const room = this.world.rooms.get(c.location);
    if (!room) return;
    const id = `stain-${c.id}`;
    room.effects = (room.effects ?? []).filter((e) => e.until == null || e.until > this.world.now);
    if (room.effects.some((e) => e.id === id)) return;
    // step 8: the map draws it (position = the spot where they bled) and fades it over the three days it lasts
    room.effects.push({ id, text: `A dark bloodstain has soaked into the floor where ${c.name} bled.`, until: this.world.now + 4320, source: 'body', visual: { kind: 'bloodstain', spot: c.spot ?? null, at: this.world.now } });
    this.world.decals?.add({ kind: 'blood', roomId: c.location, spot: c.spot ?? null, intensity: Math.min(1, 0.5 + drain / 20), source: id }); // step 9: a lasting mark on the map
    this.world.saveRoom(room);
    st.stain.lost = 0;
  }

  #activityMult(c) {
    const A = this.content.bleeding.activity;
    switch (c.activity.type) {
      case 'sleeping': case 'collapsed': case 'waiting': return A.resting;
      case 'moving': return A.walking;
      case 'doing': return A.working;
      default: return A.idle;
    }
  }

  #checkPressure(c, conds) {
    for (const cond of conds) {
      const p = cond.flags?.pressure;
      if (!p) continue;
      const by = this.world.citizens.get(p.by);
      const ok = by?.alive && by.location === c.location && by.activity?.detail?.kind === 'pressure' && by.activity?.detail?.conditionId === cond.id && by.activity.type !== 'collapsed';
      if (!ok) {
        delete cond.flags.pressure;
        this.#touch(cond);
      }
    }
  }

  #step(c, conds, elapsed, now) {
    const st = c.body;
    const B = this.content.bleeding;
    this.#checkPressure(c, conds);
    const n = clamp(Math.ceil(elapsed), 1, 60);
    const dt = elapsed / n;
    let last = null;
    for (let i = 0; i < n; i++) {
      const stage = stageFor(B, st.blood);
      const ctx = { now, activity: this.#activityMult(c), stagePenalty: stage.clot, cold: this.isCold(c) || st.shock, tourniquets: st.tourniquets };
      const res = stepWounds(this.content, conds, ctx, dt);
      last = res;
      const drain = this.#criticalWindow(c, res, now, dt);
      const lost = appliedDrain(res.total, dt, drain);
      st.blood = clamp(st.blood - lost, 0, 100);
      if (lost > 0) this.#bloodstain(c, lost);
      if (res.total < 0.2 && st.blood < 100) {
        const fed = (c.needs?.hunger ?? 0) < 50 && ['sleeping', 'waiting', 'idle', 'collapsed'].includes(c.activity.type);
        st.blood = Math.min(100, st.blood + ((fed ? B.regen.restingFed : B.regen.other) * st.regen * dt) / 60);
      }
      this.#vitality(c, conds, dt, stage);
      if (st.blood < B.deathBlood) return this.die(c, { cause: this.deathCause(c, 'blood'), reason: 'blood' });
      if (st.vitality <= 0) return this.die(c, { cause: this.deathCause(c, 'vitality'), reason: 'vitality' });
    }
    // pain, blood loss, anemia and a chill wear on the body: extra fatigue while awake
    const ff = st.fatigueFactor ?? 1;
    if (ff > 1 && c.needs && !['sleeping', 'collapsed'].includes(c.activity.type)) {
      const base = this.world.needs.rate('fatigue', this.world.needs.rateKey(c));
      if (base > 0) c.needs.fatigue = Math.min(100, c.needs.fatigue + (base * (ff - 1) * elapsed) / 60);
    }
    st.criticalLeft = st.critical ? Math.max(0, Math.round((st.critical.until - now) * 10) / 10) : null;
    st.bleedTotal = last ? Math.round(last.total * 10) / 10 : 0;
    st.bleedWounds = last ? last.wounds.filter((w) => w.rate > 0.05).map((w) => ({ id: w.cond.id, rate: Math.round(w.rate * 10) / 10 })) : [];
    for (const cond of conds) if (cond.geometry?.vessel || cond.geometry?.internal) this.#touch(cond);
    st.sinceSlow = (st.sinceSlow ?? 0) + elapsed;
    if (st.regenUntil != null && now >= st.regenUntil) {
      st.regen = 1;
      st.regenUntil = null;
    }
    if (st.sinceSlow >= SLOW_EVERY) {
      const minutes = st.sinceSlow;
      st.sinceSlow = 0;
      this.#slow(c, minutes, now);
    } else {
      this.recompute(c, { quiet: true });
    }
    this.world.dirty.add(c.id);
  }

  /** The critical grace window: returns the drain cap (% per hour) or null. Opens/closes windows and tells people. */
  #criticalWindow(c, res, now, dt) {
    const st = c.body;
    const B = this.content.bleeding;
    const grace = config.body.criticalGraceMinutes;
    if (grace <= 0 || !c.alive) return null;
    const rate = res.total;
    if (rate <= B.critical.survivableRate) {
      if (st.critical) this.#closeWindow(c, 'controlled');
      st.windowSpent = false; // under control: a later re-opening gets a new window
      return null;
    }
    if (st.critical) {
      if (now >= st.critical.until) {
        this.#closeWindow(c, 'expired');
        st.windowSpent = true;
        return null;
      }
      return st.critical.cap;
    }
    if (st.windowSpent) return null;
    const vital = [...this.content.parts.values()].some((p) => p.vital && (this.#destroyedOrMissing(c).has(p.id)));
    if (!survivable(this.content, res.wounds, { vitalDestroyed: vital })) return null;
    const fatal = B.deathBlood;
    const g = st.windows > 0 ? grace / 2 : grace;
    if ((rate * g) / 60 <= st.blood - fatal) return null; // slow enough on its own: no window needed
    st.windows = (st.windows ?? 0) + 1;
    st.critical = { since: now, until: now + g, cap: ((st.blood - fatal) / g) * 60, grace: g, count: st.windows };
    const worst = res.wounds.filter((w) => !w.cond.geometry.internal).sort((a, b) => b.rate - a.rate)[0];
    this.world.logEvent('critical_window', { actorId: c.id, location: c.location, action: 'open', graceMinutes: g, rate: Math.round(rate), worst: worst ? { id: worst.cond.id, part: worst.cond.partId } : null });
    if (worst) {
      worst.cond.flags.critical = true;
      const where = this.content.partLabel(worst.cond.partId);
      const word = bleedWord(B, worst.rate);
      this.world.perceive(citizensIn(this.world.citizens, c.location, { exceptId: c.id }).map((o) => o.id), {
        kind: 'action', text: `${ref(c)}'s ${where} is ${word === 'spurting' || word === 'pulsing' ? word : 'bleeding hard'}: blood won't stop on its own.`,
        importance: 10, sourceId: c.id, roomId: c.location, data: { interrupt: true, critical: true, conditionId: worst.cond.id },
      });
    }
    this.world.perceive([c.id], { kind: 'body', text: worst ? `Blood is pumping out of your ${this.content.partLabel(worst.cond.partId)}. You have minutes.` : 'You are bleeding heavily. You have minutes.', importance: 10, roomId: c.location, data: { interrupt: true, critical: true } });
    return st.critical.cap;
  }

  #closeWindow(c, reason) {
    const st = c.body;
    if (!st.critical) return;
    this.world.logEvent('critical_window', { actorId: c.id, location: c.location, action: 'close', reason });
    for (const cond of this.active(c.id)) if (cond.flags?.critical) delete cond.flags.critical;
    st.critical = null;
  }

  #destroyedOrMissing(c) {
    const r = computeBody(this.content, { conds: this.active(c.id), blood: 100, vitality: 100, fatigue: 0, aids: {}, now: this.world.now });
    return new Set([...r.destroyed, ...r.missing]);
  }

  /** Vitality: slow regeneration against the drains (starvation, organs, shock, fever, critical blood loss). */
  #vitality(c, conds, dt, stage) {
    const st = c.body;
    const hours = dt / 60;
    const needs = this.world.needs;
    const hunger = c.needs?.hunger ?? 0;
    let drain = 0;
    if (hunger >= needs.starvingAt) drain += needs.cfg.hp?.starvationDamagePerHour ?? 6;
    const heart = this.#frac(conds, 'heart');
    const lungs = (this.#frac(conds, 'lung_left') + this.#frac(conds, 'lung_right')) / 2;
    if (heart < 0.5) drain += (0.5 - heart) * 12;
    if (lungs < 0.5) drain += (0.5 - lungs) * 8;
    let fever = 0;
    for (const cond of conds) {
      const def = this.content.typeDef(cond.type);
      const v = def?.vitalityDrain;
      if (cond.type === 'fever') fever = Math.max(fever, cond.severity);
      if (v && cond.severity > v.above) drain += v.perHour * (cond.severity - v.above + 1) * (cond.type === 'fever' ? config.body.illnessRate : 1);
    }
    if (st.vitality < 30 && drain > 0) drain += 1; // shock deepens it
    if (st.blood < 50 && stage.vitalityDrain) drain += stage.vitalityDrain * (1 + (50 - st.blood) / 10);
    const asleep = c.activity.type === 'sleeping' || c.activity.type === 'collapsed';
    const nutrition = hunger >= needs.starvingAt ? 0 : hunger >= 70 ? 0.4 : hunger >= 50 ? 0.8 : 1;
    const regen = (asleep ? 3 : 1) * nutrition * (fever >= 4 ? 0.5 : 1) * st.regen;
    st.vitality = clamp(st.vitality + (regen - drain) * hours, 0, 100);
  }

  #frac(conds, partId) {
    let loss = 0;
    for (const cond of conds) {
      if (cond.partId !== partId) continue;
      const def = this.content.typeDef(cond.type);
      if (cond.type === 'severed' || (def?.destroyAt && cond.severity >= def.destroyAt)) return 0;
      loss += (def?.loss ?? 0) * cond.severity;
    }
    return clamp(1 - loss, 0, 1);
  }

  isCold(c) {
    const room = this.world.rooms.get(c.location);
    if (!room) return false;
    const effects = room.effects ?? [];
    return effects.some((e) => /rain|cold|snow|frost/i.test(`${e.text ?? ''} ${e.type ?? ''}`)) && garmentsCovering(this.world, c.id, 'torso').every((g) => ['torn', 'rags'].includes(g.state)) ;
  }

  /** Every 10 game minutes: healing, infection, fever, anemia, tourniquets, bloodied garments. */
  #slow(c, minutes, now) {
    const st = c.body;
    // an hourly vitality sample for the timeline overlay (only while something is wrong)
    if (now - (st.lastSampleAt ?? -Infinity) >= 60) {
      st.lastSampleAt = now;
      this.world.logEvent('vitality', { actorId: c.id, location: c.location, vitality: Math.round(st.vitality * 10) / 10, blood: Math.round(st.blood * 10) / 10, pain: st.pain ?? 0 });
    }
    const conds = this.active(c.id);
    const needs = this.world.needs;
    const act = c.activity.type;
    const hungerIdx = needs.levelIndex('hunger', c.needs);
    const infected = new Set(conds.filter((x) => x.type === 'infection').map((x) => x.partId));
    const fever = conds.some((x) => x.type === 'fever' && x.severity >= 3);
    const ctx = {
      scale: config.body.healTimeScale, illness: config.body.illnessRate,
      rest: act === 'sleeping' || act === 'collapsed' ? 1.5 : act === 'waiting' ? 1.2 : act === 'moving' || act === 'doing' ? 0.7 : 1.0,
      nutrition: hungerIdx >= 3 ? 0.4 : hungerIdx >= 2 ? 0.8 : 1, fever, anemic: conds.some((x) => x.type === 'anemia'), regen: st.regen,
      moved: act === 'moving', infectedParts: infected,
    };
    const healed = healTick(this.content, conds, ctx, minutes);
    for (const cond of healed.worsened) this.world.perceive([c.id], { kind: 'body', text: `The pain in your ${this.content.partLabel(cond.partId)} gets worse; you should not be walking on it.`, importance: 5, roomId: c.location });
    for (const cond of healed.resolved) this.resolve(c, cond, 'healed');
    for (const cond of this.active(c.id)) this.#touch(cond);

    // infection and fever
    const inf = infectionTick(this.content, this.active(c.id), ctx, minutes, now);
    for (const src of inf.newInfections) {
      src.flags.infected = true;
      this.addCondition(c, { type: 'infection', partId: src.partId, severity: 3, cause: `an infected ${src.type}`, sourceId: `cond:${src.id}`, flags: { age: 0 }, quiet: true });
      this.#touch(src);
    }
    this.#fever(c, inf.feverTarget, minutes);

    // anemia follows the blood level
    const B = this.content.bleeding;
    const anemia = this.active(c.id).find((x) => x.type === 'anemia');
    if (st.blood < B.regen.anemiaBelow && !anemia) this.addCondition(c, { type: 'anemia', severity: clamp(Math.round((B.regen.anemiaBelow - st.blood) / 8), 1, 6), cause: 'blood loss', quiet: true });
    else if (anemia && st.blood > B.regen.anemiaClearAbove) this.resolve(c, anemia, 'recovered');
    else if (anemia) anemia.severity = clamp(Math.round((B.regen.anemiaBelow - st.blood) / 8), 1, 6);

    this.#tourniquets(c, minutes, now);

    // a garment over a bleeding wound gets bloodied
    for (const cond of this.active(c.id)) {
      if (cond.bleeding > 0.5 || (cond.geometry?.vessel && !cond.flags?.clotted && !cond.flags?.stitched)) {
        const g = garmentsCovering(this.world, c.id, cond.partId)[0];
        if (g) setBloodied(this.world, g, true);
      }
    }
    this.afterChange(c);
    this.flush();
  }

  #fever(c, target, minutes) {
    const conds = this.active(c.id);
    const fever = conds.find((x) => x.type === 'fever');
    const hours = minutes / 60;
    if (target != null) {
      if (!fever) this.addCondition(c, { type: 'fever', severity: clamp(target, 2, 10), cause: 'an infected wound', quiet: true });
      else {
        fever.severity = clamp(fever.severity + Math.sign(target - fever.severity) * Math.min(Math.abs(target - fever.severity), 0.4 * hours), 1, 10);
        fever.initialSeverity = Math.max(fever.initialSeverity, fever.severity);
        this.#touch(fever);
      }
    } else if (fever) {
      fever.severity = Math.max(0, fever.severity - 0.25 * hours); // breaks as the infection clears
      fever.flags.herbal = fever.flags.herbal;
      if (fever.severity < 0.8) this.resolve(c, fever, 'healed');
      else this.#touch(fever);
    }
  }

  /** Improvised tourniquets slip; left on for hours they hurt the limb below. */
  #tourniquets(c, minutes, now) {
    const st = c.body;
    if (!st.tourniquets?.length) return;
    for (const t of st.tourniquets) {
      if (t.improvised) t.eff = Math.max(0.2, (t.eff ?? 1) * 0.9 ** (minutes / 60));
      const hours = (now - t.at) / 60;
      if (hours >= 2 && !t.damaged) {
        t.damaged = true;
        const distal = this.content.parts.get(t.part)?.region?.endsWith('_leg') ? `foot_${this.content.parts.get(t.part).side}` : `hand_${this.content.parts.get(t.part)?.side}`;
        this.addCondition(c, { type: 'crush', partId: distal, severity: 4, cause: 'a tourniquet left on too long', quiet: true });
        this.world.perceive([c.id], { kind: 'body', text: 'The limb below the tourniquet has gone numb and cold.', importance: 7, roomId: c.location });
      }
      if (hours >= 6 && !t.lost) {
        t.lost = true;
        const distal = this.content.parts.get(t.part)?.region?.endsWith('_leg') ? `foot_${this.content.parts.get(t.part).side}` : `hand_${this.content.parts.get(t.part)?.side}`;
        this.addCondition(c, { type: 'severed', partId: distal, severity: 8, cause: 'the limb died under a tourniquet', quiet: true, geometry: { length_cm: 4, depth: 'moderate', gape: 0.2, vessel: 'capillary', internal: false } });
      }
    }
  }

  // ---------- views ----------
  deathCause(c, reason) {
    const conds = this.active(c.id);
    const worst = [...conds].filter((x) => x.geometry?.vessel || x.geometry?.internal).sort((a, b) => b.bleeding - a.bleeding)[0];
    if (reason === 'blood') {
      if (worst?.geometry?.internal) return 'internal bleeding';
      return worst ? `bled out from ${/^[aeiou]/.test(worst.type) ? 'an' : 'a'} ${worst.type === 'cut' ? 'gash' : worst.type} in the ${this.content.partLabel(worst.partId)}` : 'blood loss';
    }
    if ((c.needs?.hunger ?? 0) >= this.world.needs.starvingAt) return 'starvation';
    const fever = conds.find((x) => x.type === 'fever');
    if (fever) return 'fever from an infected wound';
    return 'their injuries';
  }

  /** Worst bleeding words for the prompt and the UI. */
  woundText(cond) {
    const def = this.content.typeDef(cond.type);
    return {
      look: bySeverity(def?.surface, cond.severity).replaceAll('{part}', this.content.partLabel(cond.partId)).replaceAll('{their}', 'their'),
      feel: bySeverity(def?.feel, cond.severity).replaceAll('{part}', this.content.partLabel(cond.partId)),
      bleed: cond.bleeding > 0 ? bleedWord(this.content.bleeding, cond.bleeding) : null,
    };
  }

  conditionView(cond) {
    const t = this.woundText(cond);
    return {
      id: cond.id, citizenId: cond.citizenId, type: cond.type, part: cond.partId, partLabel: cond.partId ? this.content.partLabel(cond.partId) : null,
      severity: r1(cond.severity), initialSeverity: r1(cond.initialSeverity), bleeding: cond.bleeding, bleedWord: t.bleed, clot: Math.round(cond.clot * 100) / 100,
      pain: cond.pain, infection: Math.round(cond.infection * 100) / 100, healing: Math.round(cond.healing * 1000) / 1000, permanent: cond.permanent,
      visible: cond.visible, detectDifficulty: cond.detectDifficulty, cause: cond.cause, onsetAt: cond.onsetAt, resolvedAt: cond.resolvedAt,
      flags: cond.flags, treatments: cond.treatments, geometry: cond.geometry, look: t.look, feel: t.feel, curableBy: cond.curableBy,
    };
  }

  /** GET /api/citizens/:id/body */
  view(citizenId) {
    const c = this.#citizen(citizenId);
    const st = c.body;
    const conds = this.active(c.id);
    const parts = [...this.content.parts.values()].map((p) => {
      const cur = st.parts?.[p.id];
      return { id: p.id, label: p.label, parent: p.parent, region: p.region, internal: Boolean(p.internal), vital: Boolean(p.vital), maxHealth: p.maxHealth, health: cur ? cur.health : p.maxHealth, missing: Boolean(cur?.missing) };
    });
    return {
      citizenId: c.id, name: c.name, alive: c.alive, vitality: r1(st.vitality), blood: r1(st.blood), bloodStage: st.stage ?? 'none', pain: st.pain ?? 0,
      regen: st.regen, capacities: st.capacities, status: st.status, parts,
      bleeding: { total: st.bleedTotal ?? 0, wounds: st.bleedWounds ?? [] },
      critical: st.critical ? { ...st.critical, remaining: Math.max(0, Math.round((st.critical.until - this.world.now) * 10) / 10) } : null,
      tourniquets: st.tourniquets ?? [],
      conditions: conds.filter((x) => !x.permanent).map((x) => this.conditionView(x)),
      permanent: conds.filter((x) => x.permanent).map((x) => this.conditionView(x)),
      garments: wornGarments(this.world, c.id).map((g) => ({ id: g.id, type: g.typeId, name: this.world.objects.short(g), state: g.state, bloodied: Boolean(g.data?.bloodied), covers: this.world.objects.type(g)?.covers ?? [] })),
      aids: this.world.objects.wornBy(c.id).filter((o) => this.world.objects.type(o)?.tags?.includes('aid')).map((o) => ({ id: o.id, type: o.typeId })).concat(this.world.objects.carriedBy(c.id).filter((o) => o.typeId === 'crutch').map((o) => ({ id: o.id, type: o.typeId }))),
    };
  }

  conditionsView(citizenId, { all = false } = {}) {
    this.#citizen(citizenId);
    return (all ? this.allOf(citizenId) : this.active(citizenId)).map((x) => this.conditionView(x));
  }

  /** Is anybody bleeding faster than `threshold` %/h (the quiet speed-up never runs then)? */
  anyBleedingOver(threshold = 5) {
    for (const c of this.world.citizens.values()) if (c.alive && (c.body?.bleedTotal ?? 0) > threshold) return true;
    return false;
  }

  /** A critical window is open for this citizen. */
  isCritical(c) {
    return Boolean(c.body?.critical);
  }

  /** Is a critical window open for anyone in the room this citizen is in (patient or bystander)? */
  criticalHere(c) {
    if (c.body?.critical) return true;
    for (const o of citizensIn(this.world.citizens, c.location, { exceptId: c.id })) if (o.body?.critical) return true;
    return false;
  }
}
