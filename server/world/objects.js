// Objects: the ground truth of what is in each room (step 5).
//
// TYPES are content (content/object-types.json, loaded on every boot): what an object CAN be.
// INSTANCES are state (table `objects`): where it is, how it is, who owns it. Content instances
// (content/objects.json + content/scenarios/<id>/objects.json) are inserted ONCE per id and never
// overwritten, so a live world keeps its moved, broken and hidden things across deploys.
//
// Hard rules
//   - Citizens never create objects. origin is 'content' | 'director' | 'code', never 'citizen'.
//     The only INSERT lives in #insert(), reached from seeding and director/code paths.
//   - objects.change() is the ONLY write path for an existing object: it validates, writes, appends
//     object_history, works out the witnesses and sends them the perception.
//   - Exactly one of roomId / holderId is set (asserted after every change and checked on boot).
//
// Two views
//   true view     everything here (code, keeper, director UI, observer)
//   surface view  perceiveRoom(c, roomId): what this citizen notices. obvious = always; noticeable = if
//                 known, familiar with the room (5+ visits), a seeded 40% per visit, or after examine/search;
//                 hidden (or behind/under something, or inside a closed container) = only if they know it's there.
//
// Citizen data (no migration): carrying (mirror of holderId), knownObjects, roomSnapshots (last 20 rooms),
// roomVisits, searchCounts, missingNoted.
import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_DIR } from './scenarios.js';
import { citizensIn } from './rooms.js';
import { relativeTime } from './time.js';

export const RELATIONS = ['floor', 'on', 'in', 'behind', 'under', 'beside'];
export const VISIBILITIES = ['obvious', 'noticeable', 'hidden'];
export const ORIGINS = ['content', 'director', 'code'];
export const SLOTS = 2;
export const DETAIL_LIMIT = { sparse: 5, normal: 8, rich: 12 };
export const BROKEN_STATES = new Set(['broken', 'smashed', 'torn', 'wrecked', 'shattered', 'cut']);
const CLOSED_STATES = new Set(['closed', 'locked']);
const SNAPSHOT_ROOMS = 20;
const NOTICE_CHANCE = 0.4;
const FAMILIAR_VISITS = 5;
const RECENT_TOUCH_MINUTES = 24 * 60;
const MISSING_RENOTICE_MINUTES = 12 * 60;
const RELATION_WORD = { on: 'on', in: 'in', behind: 'behind', under: 'under', beside: 'by' };

// Witnessed importance per action (§3.1); the perceiver's own object raises it to 7.
const ACTION_IMPORTANCE = { take: 4, put: 4, give: 4, conceal: 6, use: 3, state: 3, move: 4, reveal: 4 };
const OWN_OBJECT_IMPORTANCE = 7;

export class Objects {
  constructor(world) {
    this.world = world;
    this.db = world.db;
    this.types = new Map();
    this.byId = new Map();
    this.stmt = {
      insert: this.db.prepare(`INSERT INTO objects (id, type_id, name, room_id, holder_id, placement, state, visibility,
                                 search_difficulty, owner_id, surface_text, true_text, origin, data, updated_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      update: this.db.prepare(`UPDATE objects SET type_id = ?, name = ?, room_id = ?, holder_id = ?, placement = ?, state = ?,
                                 visibility = ?, search_difficulty = ?, owner_id = ?, surface_text = ?, true_text = ?, data = ?, updated_at = ?
                               WHERE id = ?`),
      history: this.db.prepare(`INSERT INTO object_history (object_id, game_time, actor_id, action, before, after, witnesses)
                                VALUES (?, ?, ?, ?, ?, ?, ?)`),
    };
  }

  // ---------- boot ----------
  /** Types from content, seed new content instances, load everything, check the location invariant. */
  load(scenario) {
    this.types = loadTypes();
    this.byId.clear();
    for (const row of this.db.prepare('SELECT * FROM objects').all()) this.byId.set(row.id, fromRow(row));
    const seeded = this.seed(scenario);
    const fixed = this.checkInvariant({ repair: true });
    for (const o of this.byId.values()) if (!this.types.has(o.typeId)) console.warn(`[objects] ${o.id}: unknown type "${o.typeId}"`);
    this.#syncCarrying();
    return { seeded, fixed, total: this.byId.size };
  }

  /** Content definitions (shared + scenario), by id. */
  contentDefs(scenario = this.world.scenario) {
    const out = new Map();
    const files = [path.join(CONTENT_DIR, 'objects.json'), path.join(CONTENT_DIR, 'scenarios', String(scenario ?? ''), 'objects.json')];
    for (const f of files) {
      if (!fs.existsSync(f)) continue;
      let list;
      try {
        list = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch (err) {
        console.warn(`[objects] ${path.relative(CONTENT_DIR, f)} unreadable: ${err.message}`);
        continue;
      }
      for (const d of Array.isArray(list) ? list : []) if (d?.id) out.set(String(d.id), d);
    }
    return out;
  }

  /** Insert content instances whose id doesn't exist yet. Never overwrites: existing objects are state. */
  seed(scenario) {
    const defs = this.contentDefs(scenario);
    let n = 0;
    const pending = [...defs.values()].filter((d) => !this.byId.has(String(d.id)));
    // Anchors first, so `placement.of` can be checked against objects that already exist.
    pending.sort((a, b) => (a.placement?.of ? 1 : 0) - (b.placement?.of ? 1 : 0));
    this.db.exec('BEGIN');
    try {
      for (const d of pending) {
        const o = this.#fromDef(d, { strict: false });
        if (!o) continue;
        this.#insert(o, { actorId: 'code', action: 'seed' });
        n++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw new Error(`Seeding objects failed, nothing was inserted: ${err.message}`);
    }
    if (n) {
      console.log(`[content] seeded ${n} objects`);
      // Owners know where their own things are; regulars know their own home.
      for (const d of pending) {
        const o = this.byId.get(String(d.id));
        const owner = o?.ownerId && this.world.citizens.get(o.ownerId);
        if (owner) this.learn(owner, o, { touched: false });
      }
      for (const c of this.world.citizens.values()) {
        c.roomVisits ??= {};
        if (c.home && !(c.roomVisits[c.home] >= FAMILIAR_VISITS)) c.roomVisits[c.home] = FAMILIAR_VISITS;
        this.world.saveCitizen(c);
      }
    }
    return n;
  }

  // Normalize a content / director definition into an instance (not yet stored).
  #fromDef(d, { strict = true, origin = 'content' } = {}) {
    const fail = (msg) => {
      if (strict) throw httpError(400, msg);
      console.warn(`[objects] skipping ${d?.id}: ${msg}`);
      return null;
    };
    const id = String(d.id ?? '').trim();
    if (!/^[a-z0-9_-]{1,60}$/.test(id)) return fail('id must be 1–60 chars of a-z, 0-9, _ or -');
    if (this.byId.has(id)) return fail(`object "${id}" already exists`);
    const type = this.types.get(d.type ?? d.typeId);
    if (!type) return fail(`unknown type "${d.type ?? d.typeId}"`);
    const holderId = d.holder ?? d.holderId ?? null;
    const roomId = holderId ? null : d.room ?? d.roomId ?? null;
    if (holderId && !this.world.citizens.has(holderId)) return fail(`unknown holder "${holderId}"`);
    if (!holderId && !this.world.rooms.has(roomId)) return fail(`unknown room "${roomId}"`);
    const state = d.state ?? type.states[0];
    if (!type.states.includes(state)) return fail(`state "${state}" is not one of ${type.states.join(', ')}`);
    const visibility = VISIBILITIES.includes(d.visibility) ? d.visibility : 'obvious';
    let placement = holderId ? (d.placement?.relation === 'worn' ? { relation: 'worn', of: null } : {}) : normPlacement(d.placement);
    if (placement.of) {
      const anchor = this.byId.get(placement.of);
      const why = this.#anchorProblem({ id, roomId }, placement, anchor);
      if (why) {
        if (strict) return fail(why);
        console.warn(`[objects] ${id}: ${why}; placed on the floor`);
        placement = { relation: 'floor', of: null };
      }
    }
    const owner = d.owner ?? d.ownerId ?? null;
    return {
      id, typeId: type.id, name: d.name ? String(d.name) : null, roomId, holderId, placement, state, visibility,
      searchDifficulty: clampInt(d.difficulty ?? d.searchDifficulty, 0, 10, visibility === 'hidden' ? 4 : 0),
      ownerId: owner && this.world.citizens.has(owner) ? owner : null,
      surfaceText: d.surfaceText ? String(d.surfaceText).slice(0, 160) : null,
      trueText: d.trueText ? String(d.trueText).slice(0, 400) : null,
      origin: ORIGINS.includes(origin) ? origin : 'code',
      data: { ...(d.data ?? {}), ...(d.short ? { short: String(d.short) } : {}), home: roomId, arrivedAt: this.world.now },
      updatedAt: this.world.now,
    };
  }

  // THE insert. Only seeding, director creation and code paths reach it; never a citizen action.
  #insert(o, { actorId, action }) {
    if (o.origin === 'citizen' || !ORIGINS.includes(o.origin)) throw new Error(`objects can't have origin "${o.origin}"`);
    assertLocation(o);
    this.stmt.insert.run(o.id, o.typeId, o.name, o.roomId, o.holderId, JSON.stringify(o.placement), o.state, o.visibility,
      o.searchDifficulty, o.ownerId, o.surfaceText, o.trueText, o.origin, JSON.stringify(o.data), o.updatedAt);
    this.byId.set(o.id, o);
    this.stmt.history.run(o.id, this.world.now, actorId, action, '{}', JSON.stringify(snap(o)), '[]');
  }

  /** Director / code: create an instance (origin 'director' or 'code'). */
  create(def, { actorId = 'director', origin = 'director', action = 'create' } = {}) {
    if (origin === 'citizen') throw httpError(400, 'citizens never create objects');
    const o = this.#fromDef(def, { strict: true, origin });
    this.#insert(o, { actorId, action });
    if (o.ownerId) this.learn(this.world.citizens.get(o.ownerId), o, { touched: false });
    this.#syncCarrying();
    this.#announce(o, { action: 'create', actorId, witnesses: [] });
    return this.view(o);
  }

  /** Dev tool: put one object back to its content definition (through change()). */
  reset(id) {
    const o = this.byId.get(id);
    if (!o) throw httpError(404, `unknown object "${id}"`);
    const d = this.contentDefs().get(id);
    if (!d) throw httpError(400, `"${id}" has no content definition`);
    const type = this.types.get(d.type ?? d.typeId);
    const holderId = d.holder ?? d.holderId ?? null;
    return this.change(id, {
      typeId: type?.id ?? o.typeId,
      name: d.name ?? null,
      ...(holderId ? { holderId } : { roomId: d.room ?? d.roomId, placement: normPlacement(d.placement) }),
      state: d.state ?? type?.states[0] ?? o.state,
      visibility: VISIBILITIES.includes(d.visibility) ? d.visibility : 'obvious',
      searchDifficulty: clampInt(d.difficulty ?? d.searchDifficulty, 0, 10, d.visibility === 'hidden' ? 4 : 0),
      ownerId: d.owner ?? null,
      surfaceText: d.surfaceText ?? null,
      trueText: d.trueText ?? null,
    }, { actorId: 'director', action: 'reset' });
  }

  // ---------- lookups ----------
  get(id) {
    return this.byId.get(id) ?? null;
  }

  /**
   * The handle citizens use in prompts and tool enums: "flour_sack#k2p0". Stable, but says nothing about
   * whose it is (real ids like "greta_key" would leak ownership).
   */
  alias(o) {
    return `${o.typeId}#${Math.floor(hash01(`alias|${o.id}`) * 1679616).toString(36).padStart(4, '0')}`;
  }

  /** An alias (or a real id) back to the object. */
  resolve(token) {
    const t = String(token ?? '').trim();
    if (!t) return null;
    if (this.byId.has(t)) return this.byId.get(t);
    for (const o of this.byId.values()) if (this.alias(o) === t) return o;
    return null;
  }

  type(o) {
    return this.types.get(o?.typeId) ?? null;
  }

  inRoom(roomId) {
    const out = [];
    for (const o of this.byId.values()) if (o.roomId === roomId) out.push(o);
    return out;
  }

  /** What they hold in their hands (worn garments and aids don't use hands). */
  carriedBy(citizenId) {
    const out = [];
    for (const o of this.byId.values()) if (o.holderId === citizenId && o.placement?.relation !== 'worn') out.push(o);
    return out;
  }

  /** step 7B: what they wear (garments, splints, slings, a peg leg…). */
  wornBy(citizenId) {
    const out = [];
    for (const o of this.byId.values()) if (o.holderId === citizenId && o.placement?.relation === 'worn') out.push(o);
    return out;
  }

  slotsUsed(citizenId) {
    return this.carriedBy(citizenId).reduce((n, o) => n + (this.type(o)?.size ?? 1), 0);
  }

  /** step 7B: how many hands they can use (0-2), from the body's manipulation capacities. */
  handsOf(citizenId) {
    const cap = this.world.citizens.get(citizenId)?.body?.capacities;
    if (!cap) return SLOTS;
    return (cap.manipulationLeft >= 0.2 ? 1 : 0) + (cap.manipulationRight >= 0.2 ? 1 : 0);
  }

  freeSlots(citizenId) {
    return Math.max(0, this.handsOf(citizenId) - this.slotsUsed(citizenId));
  }

  /** Objects placed relative to this one (on / in / behind / under / beside it). */
  around(id, relation = null) {
    const out = [];
    for (const o of this.byId.values()) if (o.placement?.of === id && (!relation || o.placement.relation === relation)) out.push(o);
    return out;
  }

  isClosed(o) {
    return Boolean(this.type(o)?.container) && CLOSED_STATES.has(o.state);
  }

  /** Hidden for surface purposes: its own visibility, or behind/under something, or inside a closed container. */
  effectivelyHidden(o, depth = 0) {
    if (o.visibility === 'hidden') return true;
    const p = o.placement ?? {};
    if (p.relation === 'behind' || p.relation === 'under') return true;
    if (p.of && depth < 5) {
      const anchor = this.byId.get(p.of);
      if (anchor && p.relation === 'in' && this.isClosed(anchor)) return true;
      if (anchor && this.effectivelyHidden(anchor, depth + 1)) return true;
    }
    return false;
  }

  surfaceTier(o) {
    return this.effectivelyHidden(o) ? 'hidden' : o.visibility;
  }

  // ---------- the single write path ----------
  /**
   * Change an object. patch: { roomId | holderId, placement, state, visibility, searchDifficulty, ownerId,
   *   surfaceText, trueText, name, typeId, data }.
   * opts: { actorId, action, perceive?: (viewer) => text|null, importance?, roomId? (where it was witnessed),
   *         notify? (false = record witnesses but send no stimulus), text? (neutral sentence for the event log),
   *         extra? (event data) }
   */
  change(id, patch, { actorId = 'code', action = 'state', perceive = null, importance = null, roomId = null, notify = true, text = null, extra = {} } = {}) {
    const o = this.byId.get(id);
    if (!o) throw httpError(404, `unknown object "${id}"`);
    const before = snap(o);
    const next = { ...o, placement: { ...o.placement }, data: { ...o.data } };

    if (patch.typeId !== undefined) {
      if (!this.types.has(patch.typeId)) throw httpError(400, `unknown type "${patch.typeId}"`);
      next.typeId = patch.typeId;
    }
    const type = this.types.get(next.typeId);
    if (patch.holderId !== undefined && patch.holderId !== null) {
      if (!this.world.citizens.has(patch.holderId)) throw httpError(400, `unknown citizen "${patch.holderId}"`);
      next.holderId = patch.holderId;
      next.roomId = null;
      next.placement = patch.placement?.relation === 'worn' ? { relation: 'worn', of: null } : {}; // step 7B: worn, not carried
    } else if (patch.roomId !== undefined && patch.roomId !== null) {
      if (!this.world.rooms.has(patch.roomId)) throw httpError(400, `unknown room "${patch.roomId}"`);
      next.roomId = patch.roomId;
      next.holderId = null;
      next.placement = normPlacement(patch.placement ?? { relation: 'floor' });
      if (next.placement.relation === 'worn') next.placement = { relation: 'floor', of: null };
    } else if (patch.placement !== undefined) {
      if (!next.roomId) throw httpError(400, 'a carried object has no placement');
      next.placement = normPlacement(patch.placement);
    }
    if (next.placement?.of) {
      const why = this.#anchorProblem(next, next.placement, this.byId.get(next.placement.of));
      if (why) throw httpError(400, why);
    }
    if (patch.state !== undefined) {
      if (!type?.states.includes(patch.state)) throw httpError(400, `"${patch.state}" is not a state of ${type?.name ?? next.typeId} (${type?.states.join(', ')})`);
      next.state = patch.state;
    }
    if (patch.visibility !== undefined) {
      if (!VISIBILITIES.includes(patch.visibility)) throw httpError(400, `visibility must be one of ${VISIBILITIES.join(', ')}`);
      next.visibility = patch.visibility;
    }
    if (patch.searchDifficulty !== undefined) next.searchDifficulty = clampInt(patch.searchDifficulty, 0, 10, next.searchDifficulty);
    if (patch.ownerId !== undefined) {
      if (patch.ownerId && !this.world.citizens.has(patch.ownerId)) throw httpError(400, `unknown citizen "${patch.ownerId}"`);
      next.ownerId = patch.ownerId || null;
    }
    if (patch.surfaceText !== undefined) next.surfaceText = patch.surfaceText ? String(patch.surfaceText).trim().slice(0, 160) : null;
    if (patch.trueText !== undefined) next.trueText = patch.trueText ? String(patch.trueText).trim().slice(0, 400) : null;
    if (patch.name !== undefined) next.name = patch.name ? String(patch.name).trim().slice(0, 80) : null;
    if (patch.data && typeof patch.data === 'object') Object.assign(next.data, patch.data);
    if (next.roomId !== o.roomId && next.roomId) next.data.arrivedAt = this.world.now;
    next.updatedAt = this.world.now;
    assertLocation(next);
    if (next.holderId && next.placement?.relation !== 'worn' && (next.holderId !== o.holderId || o.placement?.relation === 'worn')) {
      const cap = this.freeSlots(next.holderId);
      if ((type?.size ?? 1) > cap) throw httpError(400, `${this.world.citizens.get(next.holderId)?.name ?? next.holderId} has no free hands for that`);
      if (!type?.portable && actorId !== 'director') throw httpError(400, `${type?.name ?? 'that'} can't be carried`);
    }

    // Commit.
    Object.assign(o, next);
    this.#write(o);
    // A hiding place's tell-tale sign goes when the hidden thing is moved away.
    const oldAnchor = before.placement?.of && before.placement.of !== o.placement?.of ? this.byId.get(before.placement.of) : null;
    if (oldAnchor?.data?.clue?.for === o.id) {
      oldAnchor.data = { ...oldAnchor.data, clue: null };
      this.#write(oldAnchor);
    }
    // Things resting on / beside it stay in the room when it leaves; things inside a container move with it.
    if (before.room && o.roomId !== before.room) this.#settleAround(o, before.room, actorId);
    else if (o.holderId && before.room) this.#settleAround(o, before.room, actorId);

    // Witnesses: a citizen's action is seen by everyone awake in their room (no stealth in this step).
    // A director / code change has no visible actor: only people in the room where the object now is
    // see the RESULT, and only if it isn't hidden (a silent teleport into a hiding place stays unknown).
    const actor = this.world.citizens.get(actorId) ?? null;
    const holderRoom = this.world.citizens.get(o.holderId)?.location ?? null;
    const where = roomId ?? actor?.location ?? (actor ? null : o.roomId ?? holderRoom) ?? before.room ?? null;
    const awakeIn = (r) => (r ? citizensIn(this.world.citizens, r).filter((x) => x.activity.type !== 'sleeping' && x.activity.type !== 'collapsed') : []);
    let awake = awakeIn(where);
    if (!actor && (where !== (o.roomId ?? holderRoom) || this.effectivelyHidden(o))) awake = notify && perceive ? awake : [];
    const witnesses = awake.filter((x) => x.id !== actorId).map((x) => x.id);
    this.stmt.history.run(o.id, this.world.now, actorId, action, JSON.stringify(before), JSON.stringify(snap(o)), JSON.stringify(witnesses));

    // Everyone who saw it (and the actor) now knows where it is.
    for (const x of awake) this.learn(x, o, { touched: x.id === actorId, roomId: where });
    if (actor && !awake.includes(actor)) this.learn(actor, o, { touched: true, roomId: where });
    this.#syncCarrying();

    if (notify && perceive && witnesses.length) {
      const base = importance ?? ACTION_IMPORTANCE[action] ?? 4;
      const broke = before.state !== o.state && BROKEN_STATES.has(o.state);
      this.world.perceive(witnesses, (viewer) => {
        const r = perceive(viewer);
        if (!r) return null;
        const t = typeof r === 'string' ? r : r.text;
        const own = o.ownerId === viewer.id;
        let imp = typeof r === 'object' && r.importance ? r.importance : base;
        if (action === 'use' && broke) imp = Math.max(imp, 6);
        if (own && ['take', 'put', 'give', 'conceal', 'use', 'move'].includes(action)) imp = Math.max(imp, OWN_OBJECT_IMPORTANCE);
        return {
          kind: 'object', text: t, importance: imp, sourceId: actor ? actor.id : null, roomId: where,
          data: { objectId: o.id, action, ownObject: own, wake: Boolean(actor?.conversationId && actor.conversationId === viewer.conversationId), ...(typeof r === 'object' ? r.data ?? {} : {}) },
        };
      });
    }
    this.#announce(o, { action, actorId, witnesses, before, location: where, text, extra });
    return this.view(o);
  }

  #write(o) {
    assertLocation(o);
    this.stmt.update.run(o.typeId, o.name, o.roomId, o.holderId, JSON.stringify(o.placement ?? {}), o.state, o.visibility,
      o.searchDifficulty, o.ownerId, o.surfaceText, o.trueText, JSON.stringify(o.data ?? {}), o.updatedAt, o.id);
  }

  // Anything placed relative to an object that left the room: contents of a container follow it into
  // another room; everything else stays behind on the floor.
  #settleAround(o, oldRoom, actorId) {
    for (const x of this.around(o.id)) {
      if (x.roomId !== oldRoom) continue;
      const before = snap(x);
      if (x.placement.relation === 'in' && o.roomId) {
        x.roomId = o.roomId;
        x.data = { ...x.data, arrivedAt: this.world.now };
      } else {
        x.placement = { relation: 'floor', of: null };
      }
      x.updatedAt = this.world.now;
      this.#write(x);
      this.stmt.history.run(x.id, this.world.now, actorId, 'move', JSON.stringify(before), JSON.stringify(snap(x)), '[]');
    }
  }

  #anchorProblem(o, placement, anchor) {
    if (!placement?.of) return null;
    if (!anchor) return `there is no object "${placement.of}" to put it ${placement.relation}`;
    if (anchor.id === o.id) return "an object can't be placed relative to itself";
    if (anchor.roomId !== o.roomId) return `${anchor.id} is not in the same room`;
    if (placement.relation === 'in' && !this.type(anchor)?.container) return `${this.type(anchor)?.name ?? anchor.id} is not a container`;
    // no cycles (a sack in a basket in the sack)
    let cur = anchor;
    for (let i = 0; cur?.placement?.of && i < 10; i++) {
      if (cur.placement.of === o.id) return 'that would place it inside itself';
      cur = this.byId.get(cur.placement.of);
    }
    return null;
  }

  #syncCarrying() {
    const by = new Map();
    for (const o of this.byId.values()) if (o.holderId && o.placement?.relation !== 'worn') by.set(o.holderId, [...(by.get(o.holderId) ?? []), o.id]);
    for (const c of this.world.citizens.values()) {
      const list = by.get(c.id) ?? [];
      if (JSON.stringify(c.carrying ?? []) !== JSON.stringify(list)) {
        c.carrying = list;
        this.world.saveCitizen(c);
      }
    }
  }

  #announce(o, { action, actorId, witnesses, before = null, location = null, text = null, extra = {} }) {
    const ev = this.world.logEvent('object', {
      actorId: this.world.citizens.has(actorId) ? actorId : null,
      by: this.world.citizens.has(actorId) ? null : actorId,
      location: location ?? o.roomId ?? null,
      objectId: o.id, objectName: this.label(o), action, witnesses,
      before, after: snap(o), text, ...extra,
    });
    this.world.bus.emit('object', { ...this.view(o), eventId: ev.id });
  }

  /** Location invariant: exactly one of roomId / holderId. repair: put strays somewhere sensible. */
  checkInvariant({ repair = false } = {}) {
    const bad = [];
    for (const o of this.byId.values()) {
      const ok = (o.roomId ? 1 : 0) + (o.holderId ? 1 : 0) === 1
        && (!o.roomId || this.world.rooms.has(o.roomId)) && (!o.holderId || this.world.citizens.has(o.holderId));
      if (ok) continue;
      bad.push(o.id);
      if (!repair) continue;
      const holder = o.holderId && this.world.citizens.get(o.holderId);
      if (holder) {
        o.roomId = null;
      } else {
        o.holderId = null;
        const home = [o.roomId, o.data?.home, this.world.rooms.keys().next().value].find((r) => r && this.world.rooms.has(r));
        o.roomId = home;
        o.placement = { relation: 'floor', of: null };
      }
      this.#write(o);
      console.warn(`[objects] ${o.id} had an invalid location; repaired to ${o.roomId ?? `held by ${o.holderId}`}`);
    }
    return bad;
  }

  // ---------- texts ----------
  /** Neutral name for logs and the director: "Greta's flour sack" or "a full flour sack". */
  label(o) {
    return o.name || this.surfaceText(o);
  }

  surfaceText(o) {
    const clue = o.data?.clue?.text ? `, ${o.data.clue.text}` : '';
    if (o.surfaceText) return o.surfaceText + clue;
    const type = this.type(o);
    if (!type) return o.typeId;
    const tpl = type.surface?.[o.state] ?? type.surface?.default ?? `a ${type.name}`;
    return article(tpl.replace(/\{state\}/g, o.state)).replace(/^a ([aeiou])/i, 'an $1').replace(/^an ([^aeiou\s])/i, 'a $1') + clue;
  }

  /** "the hearth", "the storeroom door" */
  short(o) {
    return `the ${o?.data?.short ?? this.type(o)?.name ?? 'thing'}`;
  }

  /**
   * step A4: the anchor of a placement as this viewer reads it. Two flour sacks side by side are not
   * "beside the flour sack" but "beside the other flour sack".
   */
  shortFor(viewer, o, roomId = null) {
    const peers = this.#sameTypePeers(viewer, o, roomId);
    if (!peers.length) return this.short(o);
    return `the other ${o.data?.short ?? this.type(o)?.name ?? 'thing'}`;
  }

  /** "by the oven"; for a viewer aware of a same-type anchor, "by the other flour sack" (step A4). */
  placementPhrase(o, viewer = null) {
    const p = o.placement ?? {};
    if (!p.of || !RELATION_WORD[p.relation]) return '';
    const anchor = this.byId.get(p.of);
    if (!anchor) return '';
    if (viewer && anchor.typeId === o.typeId) return `${RELATION_WORD[p.relation]} ${this.shortFor(viewer, anchor)}`;
    return `${RELATION_WORD[p.relation]} ${this.short(anchor)}`;
  }

  /** Ownership as this viewer knows it: "yours", "Greta's" or nothing. */
  ownerTag(viewer, o) {
    if (!o.ownerId) return '';
    if (o.ownerId === viewer.id) return 'yours';
    const owner = this.world.citizens.get(o.ownerId);
    const r = this.world.memory.rel(viewer.id, o.ownerId);
    return owner && r?.nameKnown && r.nameConfidence >= 0.5 && r.familiarity >= 1 ? `${owner.name}'s` : '';
  }

  /** What this viewer calls the object in a sentence: "a full flour sack (Greta's)". */
  textFor(viewer, o, { withPlace = false } = {}) {
    const own = viewer ? this.ownerTag(viewer, o) : '';
    const place = withPlace ? this.placementPhrase(o, viewer) : '';
    return `${this.surfaceText(o)}${own ? ` (${own})` : ''}${place ? `, ${place}` : ''}`;
  }

  /** What examine shows: the true text if there is one, else the surface; always the real state. */
  examineText(o) {
    const type = this.type(o);
    const base = o.trueText || cap(this.surfaceText(o));
    const state = type && type.states.length > 1 && !base.toLowerCase().includes(o.state) ? ` It is ${o.state}.` : '';
    return `${base.replace(/[.!]?$/, '.')}${state}`;
  }

  // ---------- the surface view ----------
  /**
   * What citizen c perceives of the room. Returns { items, listed, overflow, kind } where
   * items = everything perceived (for snapshots / knowledge) and listed = what the prompt shows
   * (room detail limit; owned, carried-before and recently touched things always make it).
   */
  perceiveRoom(c, roomId = c.location) {
    const room = this.world.rooms.get(roomId);
    if (!room) return { items: [], listed: [], overflow: 0, kind: '' };
    const visit = c.roomVisits?.[roomId] ?? 0;
    const items = [];
    const st = c.body?.status ?? [];
    const blind = st.includes('blind');
    for (const o of this.inRoom(roomId)) {
      const tier = this.surfaceTier(o);
      // step 7B: a blind citizen only has what they remember or have touched in this room
      if (blind && !(c.knownObjects?.[o.id] && c.knownObjects[o.id].roomId === roomId)) continue;
      if (!this.#perceives(c, o, tier, visit)) continue;
      const k = c.knownObjects?.[o.id];
      const must = o.ownerId === c.id || (k?.touchedAt != null && this.world.now - k.touchedAt <= RECENT_TOUCH_MINUTES);
      items.push({ o, tier, must, knownHidden: tier === 'hidden' });
    }
    const order = { obvious: 0, noticeable: 1, hidden: 2 };
    items.sort((a, b) => (b.must - a.must) || (order[a.tier] - order[b.tier]));
    const limit = DETAIL_LIMIT[room.detail] ?? 8;
    const listed = [];
    for (const it of items) if (it.must || listed.length < limit) listed.push(it);
    return { items, listed, overflow: items.length - listed.length, kind: room.kind };
  }

  #perceives(c, o, tier, visit) {
    if (tier === 'obvious') return true;
    if (tier === 'noticeable') {
      if (c.knownObjects?.[o.id]) return true;
      const st = c.body?.status ?? [];
      if (st.includes('concussed')) return false; // step 7B: a rattled head never notices the subtle
      if (visit >= FAMILIAR_VISITS) return true;
      return hash01(`${c.id}|${o.id}|${visit}`) < NOTICE_CHANCE * (st.includes('half-blind') ? 0.7 : 1);
    }
    return this.knowsWhere(c, o);
  }

  /** c knows the object is exactly here (found it, hid it, saw it put there). */
  knowsWhere(c, o) {
    const k = c.knownObjects?.[o.id];
    return Boolean(k && k.roomId === o.roomId && !k.holderId && k.placementSig === placementSig(o));
  }

  perceivedIds(c, roomId = c.location) {
    return new Set(this.perceiveRoom(c, roomId).items.map((it) => it.o.id));
  }

  /** Object ids c may act on: listed in WHAT'S HERE, plus what they carry. */
  actionable(c) {
    const listed = c.location ? this.perceiveRoom(c).listed.map((it) => it.o) : [];
    return { here: listed, carried: this.carriedBy(c.id) };
  }

  /** A thing named in plain words ("the flour sacks") among what c can act on here; their own first. */
  match(c, text) {
    const t = ` ${String(text ?? '').toLowerCase().replace(/[^a-z' ]+/g, ' ')} `;
    const { here, carried } = this.actionable(c);
    const hit = (o) => {
      const type = this.type(o);
      return [type?.name, type?.plural, o.data?.short].filter(Boolean).some((w) => t.includes(` ${w.toLowerCase()} `) || t.includes(` ${w.toLowerCase()}s `));
    };
    const all = [...carried, ...here].filter(hit);
    return all.find((o) => o.ownerId === c.id) ?? all[0] ?? null;
  }

  /** Prompt lines for WHAT'S HERE (identical things grouped: "three full flour sacks (Greta's), by the oven"). */
  whatsHere(c, { aliases = false } = {}) {
    const { listed, overflow, kind } = this.perceiveRoom(c);
    const groups = new Map();
    for (const it of listed) {
      const key = `${it.knownHidden ? 'h' : 'v'}|${this.surfaceText(it.o)}|${this.ownerTag(c, it.o)}|${this.placementPhrase(it.o, c)}|${it.o.typeId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    const lines = [];
    for (const list of groups.values()) {
      const it = list[0];
      const own = this.ownerTag(c, it.o);
      const place = this.placementPhrase(it.o, c);
      // Identical things share a group (so the line is already unambiguous); otherwise keep the description.
      const what = list.length > 1 ? this.plural(it.o, list.length) : this.surfaceText(it.o);
      const ids = aliases ? ` [${list.map((x) => this.alias(x.o)).join(', ')}]` : '';
      lines.push(`- ${it.knownHidden ? '(you know) ' : ''}${what}${own ? ` (${own})` : ''}${place ? `, ${place}` : ''}${ids}`);
    }
    if (overflow > 0) lines.push(`- …and the usual clutter of ${article(kind || 'place')}`);
    return lines;
  }

  plural(o, n) {
    const type = this.type(o);
    const s = this.surfaceText(o);
    const word = NUMBER_WORDS[n] ?? String(n);
    if (type && /^(a|an) /i.test(s) && s.endsWith(type.name)) return `${word} ${s.replace(/^(a|an) /i, '').slice(0, -type.name.length)}${type.plural}`;
    return `${word} of: ${s}`;
  }

  // ---------- step A4: telling look-alikes apart ----------
  /**
   * Everything of the same type this viewer can see in the room now (step A4). Two flour sacks must never
   * both read as plain "the flour sack".
   */
  #sameTypePeers(c, o, roomId = null) {
    const here = roomId ?? o.roomId ?? (c?.location ?? null);
    if (!here) return [];
    return this.inRoom(here).filter((x) => x.id !== o.id && x.typeId === o.typeId && (!c || this.surfaceTier(x) !== 'hidden'));
  }

  /** "the full flour sack" / "the half-empty one": the type's own surface words for this state. */
  stateName(o) {
    const type = this.type(o);
    if (!type || type.states.length < 2) return null;
    const body = (s) => String(type.surface?.[s] ?? type.surface?.default ?? `a ${type.name}`)
      .replace(/\{state\}/g, s).replace(/^(a|an) /i, '').split(',')[0].trim();
    const own = body(o.state);
    return own && own !== type.name ? own : null;          // a state the surface doesn't show says nothing
  }

  /**
   * step A4: how this viewer names one object among several of the same kind in the room. A content name
   * override wins and is used verbatim; otherwise a state word, then the placement, then the owner, then
   * an ordinal by id. peers = the same-type objects perceived in the same room.
   */
  distinctName(viewer, o, peers = null, roomId = null) {
    if (o.name) return o.name;                                       // content override: as-is, no qualifiers
    if (o.data?.short) return this.short(o);
    let same = peers ?? this.#sameTypePeers(viewer, o, roomId);
    let base = this.short(o);
    if (!same.length) return base;
    // A state word sets it apart only from peers in another state; among peers in the same state
    // ("three full sacks, one half-full") it narrows the group and the next qualifier decides.
    const state = this.stateName(o);
    if (state) {
      const alike = same.filter((x) => this.stateName(x) === state);
      if (!alike.length) return `the ${state}`;
      if (alike.length < same.length) { same = alike; base = `the ${state}`; }
    }
    const place = this.placementPhrase(o, viewer);
    if (place && !same.some((x) => this.placementPhrase(x, viewer) === place)) return `${base} ${place}`;
    const own = viewer ? this.ownerTag(viewer, o) : '';
    if (own && own !== 'yours' && !same.some((x) => (viewer ? this.ownerTag(viewer, x) : '') === own)) return `${own} ${base.replace(/^the /, '')}`;
    const order = [o, ...same].map((x) => x.id).sort();
    const n = order.indexOf(o.id) + 1;
    return n === 1 ? base : `the ${ORDINALS[n] ?? `#${n}`} ${base.replace(/^the /, '')}`;
  }

  // ---------- knowledge ----------
  /** c saw where o is now (or that it is carried by someone). */
  learn(c, o, { touched = false, roomId = null, save = true } = {}) {
    if (!c) return;
    c.knownObjects ??= {};
    const prev = c.knownObjects[o.id];
    // step A3: the anchor too, so "last you saw, you left it on the bakery counter" can be said later.
    const anchor = o.placement?.of ? this.byId.get(o.placement.of) : null;
    c.knownObjects[o.id] = {
      lastSeenAt: this.world.now, roomId: o.roomId, holderId: o.holderId, placementSig: placementSig(o), state: o.state,
      relation: anchor ? o.placement.relation : null, anchorId: anchor?.id ?? null,
      visible: !this.effectivelyHidden(o),
      ...(touched ? { touchedAt: this.world.now } : prev?.touchedAt != null ? { touchedAt: prev.touchedAt } : {}),
    };
    // The room snapshot follows what they saw happen, so it isn't reported as a change later.
    const r = roomId ?? o.roomId;
    if (r && c.roomSnapshots?.[r]) {
      const snapObjs = c.roomSnapshots[r].objects;
      if (o.roomId === r && this.#perceives(c, o, this.surfaceTier(o), c.roomVisits?.[r] ?? 0)) snapObjs[o.id] = `${o.state}|${placementSig(o)}`;
      else delete snapObjs[o.id];
    }
    if (save) this.world.saveCitizen(c);
  }

  /** Remember the room as seen now (the baseline for noticing changes next time). */
  snapshotRoom(c, roomId = c.location) {
    if (!roomId || !this.world.rooms.has(roomId)) return;
    const { items } = this.perceiveRoom(c, roomId);
    c.roomSnapshots ??= {};
    c.roomSnapshots[roomId] = { at: this.world.now, objects: Object.fromEntries(items.map(({ o }) => [o.id, `${o.state}|${placementSig(o)}`])) };
    for (const { o } of items) this.learn(c, o, { save: false });
    const keys = Object.keys(c.roomSnapshots);
    if (keys.length > SNAPSHOT_ROOMS) {
      keys.sort((a, b) => c.roomSnapshots[a].at - c.roomSnapshots[b].at);
      for (const k of keys.slice(0, keys.length - SNAPSHOT_ROOMS)) delete c.roomSnapshots[k];
    }
    this.world.saveCitizen(c);
  }

  /**
   * On arrival: count the visit, diff the surface view against the last snapshot, check owned things
   * that belong here, update knowledge. Returns a stimulus partial (or null) about what changed.
   */
  arrive(c, roomId = c.location) {
    if (!roomId) return null;
    c.roomVisits ??= {};
    c.roomVisits[roomId] = (c.roomVisits[roomId] ?? 0) + 1;
    const old = c.roomSnapshots?.[roomId] ?? null;
    const { items } = this.perceiveRoom(c, roomId);
    const now = new Map(items.map((it) => [it.o.id, it]));
    const seen = [...now.values()].map((it) => it.o);
    const peersOf = (o) => seen.filter((x) => x.id !== o.id && x.typeId === o.typeId); // step A4: what they can compare it with
    const nameOf = (o) => this.distinctName(c, o, peersOf(o), roomId);                 // never two plain "the flour sack"
    const changes = [];
    const importanceOf = (o) => (o.ownerId === c.id ? 7 : c.knownObjects?.[o.id]?.touchedAt != null ? 5 : 3);

    if (old) {
      const missing = [];
      for (const [id, sig] of Object.entries(old.objects)) {
        const o = this.byId.get(id);
        const it = now.get(id);
        if (!o) continue;
        if (!it) {
          if (o.holderId === c.id) continue;
          missing.push(o);
          continue;
        }
        const [oldState, oldPlace] = splitSig(sig);
        if (oldState !== o.state) changes.push({ o, kind: 'state', text: `${cap(nameOf(o))} has changed: now ${this.surfaceText(o)}.`, importance: importanceOf(o) });
        else if (oldPlace !== placementSig(o)) changes.push({ o, kind: 'moved', text: `${cap(nameOf(o))} has been moved: it is now ${this.placementPhrase(o, c) || 'on the floor'}.`, importance: importanceOf(o) });
      }
      // Missing things, grouped by type: "fewer flour sacks by the oven" when some of the same kind remain.
      const byType = new Map();
      for (const o of missing) byType.set(o.typeId, [...(byType.get(o.typeId) ?? []), o]);
      for (const [typeId, list] of byType) {
        const type = this.types.get(typeId);
        const oldSig = splitSig(old.objects[list[0].id])[1];
        const where = placementFromSig(this, oldSig);
        const remaining = items.filter((it) => it.o.typeId === typeId).length;
        const imp = Math.max(...list.map(importanceOf));
        const name = type?.name ?? typeId;
        let text;
        if (remaining > 0) text = `There are fewer ${type?.plural ?? `${name}s`}${where ? ` ${where}` : ''} than when you last looked.`;
        else if (list.length > 1) text = `The ${type?.plural ?? `${name}s`}${where ? ` that were ${where}` : ''} are gone.`;
        else text = `The ${list[0].data?.short ?? name}${where ? ` that was ${where}` : ''} is gone.`;
        changes.push({ o: list[0], kind: 'missing', ids: list.map((o) => o.id), text, importance: imp });
      }
      // New obvious things that arrived after the last look (not just missed noticeable ones).
      for (const it of items) {
        if (old.objects[it.o.id] || it.tier !== 'obvious') continue;
        if ((it.o.data?.arrivedAt ?? -Infinity) <= old.at) continue;
        changes.push({ o: it.o, kind: 'new', text: `There is ${this.textFor(c, it.o, { withPlace: true })} that wasn't here before.`, importance: 3 });
      }
    }

    // Owned things that belong here but aren't here (they know where their things go).
    c.missingNoted ??= {};
    const reported = new Set(changes.flatMap((ch) => ch.ids ?? [ch.o.id]));
    for (const o of this.byId.values()) {
      if (o.ownerId !== c.id || o.data?.home !== roomId || now.has(o.id) || o.holderId === c.id || reported.has(o.id)) continue;
      const last = c.missingNoted[o.id];
      if (last != null && this.world.now - last < MISSING_RENOTICE_MINUTES) continue;
      // step A3: when they saw it put somewhere else, it isn't an alarm but a reminder of where it is.
      const k = c.knownObjects?.[o.id];
      const kRoom = k?.roomId ?? null;
      const elsewhere = Boolean(k) && (kRoom !== roomId || (k.holderId && k.holderId !== c.id));
      const what = o.data?.short ?? this.type(o)?.name ?? 'thing';
      if (elsewhere) {
        const roomName = this.world.rooms.get(kRoom)?.name ?? null;
        const spot = this.placementFromKnown(k);
        const seen = k.holderId === c.id ? 'Last you saw, you had it with you.'
          : k.holderId ? `Last you saw, {{c:${k.holderId}}} had it.`
            : `Last you saw, you left it ${spot ? `${spot}${roomName ? ` in ${roomName}` : ''}` : `in ${roomName ?? 'another room'}`}.`;
        changes.push({ o, kind: 'misplaced', text: `Your ${what} isn't here. ${seen}`, importance: 3, knownElsewhere: true });
      } else {
        changes.push({ o, kind: 'missing', text: `Your ${what} is not where it belongs.`, importance: 7 });
      }
    }
    for (const ch of changes) if (ch.kind === 'missing' || ch.kind === 'misplaced') for (const id of ch.ids ?? [ch.o.id]) c.missingNoted[id] = this.world.now;
    for (const id of Object.keys(c.missingNoted)) if (now.has(id)) delete c.missingNoted[id];

    this.snapshotRoom(c, roomId);
    if (!changes.length) return null;
    const ids = [...new Set(changes.flatMap((ch) => ch.ids ?? [ch.o.id]))];
    const kinds = changes.map((ch) => ch.kind);
    this.world.logEvent('notice', {
      actorId: c.id, location: roomId, importance: Math.max(...changes.map((ch) => ch.importance)),
      text: changes.map((ch) => ch.text).join(' '), objectIds: ids, kinds,
    });
    const since = old ? ` from when you were last here (${relativeTime(this.world.now - old.at)})` : '';
    return {
      kind: 'notice',
      text: `Something's different${since}: ${changes.map((ch) => ch.text).join(' ')}`,
      importance: Math.max(...changes.map((ch) => ch.importance)),
      roomId,
      // step A3: only real "missing" changes may anger or raise suspicion; a thing they left elsewhere is no mystery.
      data: {
        personal: true, objectIds: ids,
        changes: kinds.filter((k) => k !== 'misplaced'),
        ...(kinds.includes('misplaced') && !kinds.includes('missing') ? { knownElsewhere: true } : {}),
      },
    };
  }

  /** step A3: "on the bakery counter" from what the citizen last saw (knownObjects entry). */
  placementFromKnown(k) {
    const word = { on: 'on', in: 'in', behind: 'behind', under: 'under', beside: 'by' }[k?.relation] ?? null;
    const anchor = k?.anchorId ? this.byId.get(k.anchorId) : null;
    return anchor && word ? `${word} ${this.short(anchor)}` : '';
  }

  // ---------- views for the API / UI ----------
  view(o) {
    const type = this.type(o);
    return {
      id: o.id, typeId: o.typeId, typeName: type?.name ?? o.typeId, name: o.name, label: this.label(o),
      roomId: o.roomId, holderId: o.holderId, placement: o.placement, placementText: this.placementPhrase(o),
      state: o.state, visibility: o.visibility, effectiveVisibility: this.surfaceTier(o), searchDifficulty: o.searchDifficulty,
      ownerId: o.ownerId, surfaceText: o.surfaceText, surface: this.surfaceText(o), trueText: o.trueText, origin: o.origin,
      data: o.data, updatedAt: o.updatedAt, portable: Boolean(type?.portable), size: type?.size ?? 1, container: Boolean(type?.container),
      tags: [...(type?.tags ?? []), ...(o.data?.tags ?? [])],
    };
  }

  history(id, limit = 50) {
    return this.db.prepare('SELECT * FROM object_history WHERE object_id = ? ORDER BY id DESC LIMIT ?').all(id, limit)
      .map((r) => ({ ...r, before: safeJson(r.before, {}), after: safeJson(r.after, {}), witnesses: safeJson(r.witnesses, []) }));
  }

  typesView() {
    return [...this.types.values()];
  }
}

// ---------- types ----------
export function loadTypes() {
  const file = path.join(CONTENT_DIR, 'object-types.json');
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  let list;
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`content/object-types.json is not valid JSON: ${err.message}`);
  }
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw?.id || !Array.isArray(raw.states) || !raw.states.length) {
      console.warn(`[objects] type ${raw?.id ?? '?'} needs an id and states; skipped`);
      continue;
    }
    const states = raw.states.map(String);
    const transitions = {};
    for (const s of states) transitions[s] = (raw.transitions?.[s] ?? []).map(String).filter((x) => states.includes(x) && x !== s);
    const rules = {};
    for (const [verb, r] of Object.entries(raw.rules ?? {})) {
      if (r && states.includes(r.to)) rules[verb.toLowerCase()] = { from: (r.from ?? states).filter((x) => states.includes(x)), to: r.to };
    }
    map.set(String(raw.id), {
      id: String(raw.id), name: String(raw.name ?? raw.id), plural: String(raw.plural ?? `${raw.name ?? raw.id}s`),
      portable: Boolean(raw.portable), size: raw.size === 2 ? 2 : 1, states, transitions,
      affordances: (raw.affordances ?? []).map(String), surface: raw.surface ?? {}, rules,
      concealable: Boolean(raw.concealable), container: Boolean(raw.container),
      tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [], // step 5.5: weapon | tool | valuable | holy … (perception only)
      covers: Array.isArray(raw.covers) ? raw.covers.map(String) : [], // step 7B: the body parts a garment covers
    });
  }
  return map;
}

// ---------- helpers ----------
export function placementSig(o) {
  if (o.holderId) return `held:${o.holderId}`;
  const p = o.placement ?? {};
  return p.of && p.relation && p.relation !== 'floor' ? `${p.relation}:${p.of}` : 'floor';
}

function splitSig(sig) {
  const i = String(sig).indexOf('|');
  return i < 0 ? [sig, 'floor'] : [sig.slice(0, i), sig.slice(i + 1)];
}

function placementFromSig(objects, sig) {
  const [rel, of] = String(sig).split(':');
  const anchor = of && objects.get(of);
  return anchor && RELATION_WORD[rel] ? `${RELATION_WORD[rel]} ${objects.short(anchor)}` : '';
}

export function normPlacement(p) {
  if (!p || typeof p !== 'object') return { relation: 'floor', of: null };
  if (p.relation === 'worn') return { relation: 'worn', of: null };
  const relation = RELATIONS.includes(p.relation) ? p.relation : 'floor';
  return relation === 'floor' || !p.of ? { relation: 'floor', of: null } : { relation, of: String(p.of) };
}

function snap(o) {
  return { room: o.roomId, holder: o.holderId, placement: o.placement, state: o.state, visibility: o.visibility };
}

function assertLocation(o) {
  if ((o.roomId ? 1 : 0) + (o.holderId ? 1 : 0) !== 1) {
    throw new Error(`object ${o.id}: exactly one of room_id / holder_id must be set (room=${o.roomId}, holder=${o.holderId})`);
  }
}

function fromRow(r) {
  return {
    id: r.id, typeId: r.type_id, name: r.name, roomId: r.room_id, holderId: r.holder_id, placement: safeJson(r.placement, {}),
    state: r.state, visibility: r.visibility, searchDifficulty: r.search_difficulty, ownerId: r.owner_id,
    surfaceText: r.surface_text, trueText: r.true_text, origin: r.origin, data: safeJson(r.data, {}), updatedAt: r.updated_at,
  };
}

// Deterministic 0..1 from a string (FNV-1a): the "seeded 40% per object per visit".
export function hash01(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

const NUMBER_WORDS = { 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten' };
const ORDINALS = { 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', 6: 'sixth', 7: 'seventh', 8: 'eighth' };

function article(s) {
  const t = String(s).trim();
  if (/^(a|an|the|some|two|three|four|\d)\b/i.test(t)) return t;
  return `${/^[aeiou]/i.test(t) ? 'an' : 'a'} ${t}`;
}

export function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function safeJson(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
