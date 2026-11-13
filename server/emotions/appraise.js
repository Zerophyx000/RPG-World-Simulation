// Code appraisal (step 6): clear world events → emotion bumps, from the rule table in content/appraisals.json.
// Plus the two dedicated story drivers: ENVY (someone has what you covet) and JEALOUSY (someone you are
// attached to is getting close to a rival). No LLM calls; the subtle cases come in through the model's own
// self-reports instead (feeling / feelings / lingering).
import { ref } from '../memory/index.js';

const WARY_AT = 7;
const WARY_EVERY = 30; // game minutes present per +1 fear

export class Appraisal {
  constructor(world, emotions) {
    this.world = world;
    this.emo = emotions;
    this.cool = new Map();    // `${citizen}|${type}|${target}|${about}` -> game time (envy / jealousy signals)
    this.wary = new Map();    // `${citizen}>${stranger}` -> minutes present since the last fear bump
    // A broken trust hurts (and makes you angry).
    world.relationships.onEvent((ev) => this.onRelationshipEvent(ev));
    // Someone close collapsing or getting hurt; a coveted thing changing hands.
    world.bus.on('event', (e) => {
      try {
        if (e.type === 'collapse' || e.type === 'damage') this.onHurt(e.actorId, e.type);
      } catch (err) {
        console.warn('[emotions] appraisal failed:', err.message);
      }
    });
    world.bus.on('object', (o) => {
      const holder = o.holderId && world.citizens.get(o.holderId);
      if (holder?.location) this.checkEnvy(holder.location);
    });
  }

  get rules() {
    return this.emo.rules;
  }

  /** Apply one named rule to citizen c. ctx: { actor, other, owner, suspect (ids), thing, place, reason, text, importance, data } */
  fire(c, name, ctx = {}) {
    const out = [];
    for (const r of this.rules.rules?.[name] ?? []) {
      const target = r.target === 'none' ? null : ctx[r.target] ?? null;
      if (r.target !== 'none' && r.target !== 'suspect' && !target) continue;
      let delta = r.delta ?? 0;
      if (r.deltaFromImportance != null) delta = (ctx.importance ?? 0) + r.deltaFromImportance;
      if (!(delta > 0)) continue;
      const fill = (k) => (ctx[k] && this.world.citizens.has(ctx[k]) ? ref(ctx[k]) : ctx[k] ?? '');
      const cause = String(r.cause ?? '').replace(/\{(actor|other|owner|suspect)\}/g, (_m, k) => fill(k))
        .replace(/\{thing\}/g, ctx.thing ?? 'thing').replace(/\{place\}/g, ctx.place ?? '').replace(/\{reason\}/g, ctx.reason ?? '').replace(/\{text\}/g, ctx.text ?? '');
      const res = this.emo.bump(c, { type: r.emotion, target, about: ctx.about ?? null, delta, cause, source: 'appraisal', rule: name, cap: r.cap ?? null, data: ctx.data ?? null });
      if (res) out.push(res);
    }
    return out;
  }

  // ---------- hooks ----------
  /** Every stimulus an awake citizen perceives passes through here (after it reached their inbox). */
  onPerceived(c, s) {
    const w = this.world;
    const d = s.data ?? {};
    if (s.kind === 'object' && s.sourceId && s.sourceId !== c.id) {
      const o = d.objectId ? w.objects.get(d.objectId) : null;
      const thing = o ? o.data?.short ?? w.objects.type(o)?.name ?? 'thing' : 'thing';
      if (d.ownObject && d.action === 'take') this.fire(c, 'own_object_taken_seen', { actor: s.sourceId, thing });
      else if (d.ownObject && d.action === 'conceal') this.fire(c, 'own_object_hidden_seen', { actor: s.sourceId, thing });
      if (d.action === 'give' && o) {
        if (o.holderId === c.id) this.fire(c, 'gift_received', { actor: s.sourceId, thing: w.objects.surfaceText(o) });
        else this.jealousyPair(c, s.sourceId, o.holderId, (b, r) => `${ref(b)} and ${ref(r)} were handing each other things.`);
      }
      if ((d.action === 'take' || d.action === 'give') && o?.holderId && o.holderId !== c.id) this.envyObject(c, w.citizens.get(o.holderId), o);
    } else if (s.kind === 'notice' && (d.changes ?? []).includes('missing')) {
      const mine = (d.objectIds ?? []).map((id) => w.objects.get(id)).filter((o) => o && o.ownerId === c.id && o.roomId !== c.location && o.holderId !== c.id);
      if (mine.length) {
        const o = mine[0];
        this.fire(c, 'own_object_missing', { suspect: this.suspectFor(c, o), thing: o.data?.short ?? w.objects.type(o)?.name ?? 'thing' });
      }
    } else if (s.kind === 'director' && d.level === 'here' && s.importance >= 8) {
      this.fire(c, 'director_event_here', { importance: s.importance, text: firstSentence(s.text) });
    } else if (s.kind === 'timer' && d.planEnd && /everything you planned/.test(s.text)) {
      this.fire(c, 'plan_finished', {});
    } else if (s.kind === 'speech' && d.conversationId && c.conversationId !== d.conversationId) {
      // a conversation they are not part of: is someone they love deep in talk with a rival?
      const conv = w.conversations.get(d.conversationId);
      if (conv && conv.lines.length >= (this.rules.jealousy?.conversationLines ?? 6) && conv.participants.length === 2) {
        this.jealousyPair(c, conv.participants[0], conv.participants[1], (b, r) => `${ref(b)} and ${ref(r)} have been talking and talking, just the two of them.`);
      }
    }
  }

  onSignal(observer, other, sign, evidence = {}) {
    const o = evidence.objectId ? this.world.objects.get(evidence.objectId) : null;
    const thing = o ? o.data?.short ?? this.world.objects.type(o)?.name ?? 'thing' : 'thing';
    if (sign === 'followed') this.fire(observer, 'followed', { other: other.id });
    else if (sign === 'intruder') this.fire(observer, 'intruder', { other: other.id });
    else if (sign === 'property') this.fire(observer, 'property', { other: other.id, thing });
  }

  onRelationshipEvent(ev) {
    if (['seed', 'group', 'first_impression', 'consolidation', 'signal'].includes(ev.source)) return;
    if (!(ev.dTrust <= -2)) return;
    const c = this.world.citizens.get(ev.citizenId);
    if (!c) return;
    this.fire(c, 'trust_broken', { other: ev.otherId, reason: ev.reason });
    if ((ev.before?.affinity ?? 0) >= 3) this.fire(c, 'trust_broken_by_loved', { other: ev.otherId, reason: ev.reason });
  }

  /** Someone collapsed or was hurt: fear and sadness for everyone present who is close to them. */
  onHurt(victimId, kind) {
    const w = this.world;
    const v = w.citizens.get(victimId);
    if (!v?.location) return;
    for (const c of this.emo.awakeIn(v.location)) {
      if (c.id === v.id) continue;
      const close = (w.memory.rel(c.id, v.id)?.affinity ?? 0) >= 3 || w.groups.isFamily(c.id, v.id);
      if (!close) continue;
      const key = `${c.id}|hurt|${v.id}`;
      if (w.now - (this.cool.get(key) ?? -Infinity) < 30) continue;
      this.cool.set(key, w.now);
      this.fire(c, 'close_one_hurt', { other: v.id, data: { kind } });
    }
  }

  /** The actor took or hid something that isn't theirs, and was seen: shame, and guilt for the conscientious. */
  onOwnActSeen(actor, obj, witnessIds, action) {
    if (!witnessIds?.length || !obj?.ownerId || obj.ownerId === actor.id) return;
    const w = this.world;
    if (w.strangers.gaveIt(obj.ownerId, actor.id, obj.id)) return;
    const thing = w.objects.surfaceText(obj);
    this.fire(actor, 'own_act_witnessed', { thing, data: { witnesses: witnessIds, action } });
    const t = actor.persona?.traits ?? {};
    if ((t.agreeableness ?? 0.5) > 0.6 || (t.conscientiousness ?? 0.5) > 0.6) this.fire(actor, 'own_act_witnessed_guilt', { owner: obj.ownerId, thing });
  }

  /** `c` arrived somewhere: jealousy (two people alone together), envy (what people here carry). */
  onArrive(c, roomId) {
    const w = this.world;
    const here = w.citizensIn(roomId, { exceptId: c.id });
    if (here.length === 2) {
      const [x, y] = here;
      const conv = x.conversationId && x.conversationId === y.conversationId;
      if (conv) this.jealousyPair(c, x.id, y.id, (b, r) => `I walked in on ${ref(b)} and ${ref(r)}, alone together and deep in talk.`);
    }
    this.checkEnvy(roomId);
  }

  onPartyJoin(group, joinerId) {
    const w = this.world;
    const members = w.groups.membersOf(group.id).map((m) => m.citizenId);
    const joiner = w.citizens.get(joinerId);
    if (!joiner?.location) return;
    for (const c of this.emo.awakeIn(joiner.location)) {
      if (members.includes(c.id)) continue;
      for (const other of members) if (other !== joinerId) this.jealousyPair(c, joinerId, other, (b, r) => `${ref(b)} and ${ref(r)} are going off together as a party, without me.`);
    }
  }

  /** Every ~10 game minutes: wary strangers wear on the nerves; coveted things in view. */
  periodic(minutes) {
    const w = this.world;
    const byRoom = new Map();
    for (const c of w.citizens.values()) if (c.alive && c.location) byRoom.set(c.location, [...(byRoom.get(c.location) ?? []), c]);
    for (const [roomId, list] of byRoom) {
      if (list.length < 2) continue;
      for (const c of list) {
        if (c.activity.type === 'sleeping' || c.activity.type === 'collapsed') continue;
        for (const o of list) {
          if (o === c || !w.strangers.isStranger(c, o) || w.groups.isClose(c.id, o.id)) continue;
          const key = `${c.id}>${o.id}`;
          if (w.strangers.wariness(c, o).value < WARY_AT) {
            this.wary.delete(key);
            continue;
          }
          const t = (this.wary.get(key) ?? 0) + minutes;
          if (t >= WARY_EVERY) {
            this.wary.set(key, t - WARY_EVERY);
            this.fire(c, 'wary_stranger_present', { other: o.id });
          } else this.wary.set(key, t);
        }
      }
      this.checkEnvy(roomId);
    }
  }

  // ---------- envy ----------
  checkEnvy(roomId) {
    const w = this.world;
    const awake = this.emo.awakeIn(roomId);
    if (awake.length < 2) return;
    for (const holder of w.citizensIn(roomId)) {
      const carried = w.objects.carriedBy(holder.id);
      if (!carried.length) continue;
      for (const c of awake) if (c.id !== holder.id) for (const o of carried) this.envyObject(c, holder, o);
    }
  }

  covetsObject(c, o) {
    const covets = c.persona?.covets ?? [];
    if (!covets.length) return false;
    const type = this.world.objects.type(o);
    const tags = new Set([o.typeId, type?.name, ...(type?.tags ?? []), ...(o.data?.tags ?? [])].filter(Boolean).map((s) => String(s).toLowerCase()));
    return covets.some((k) => tags.has(String(k).toLowerCase()));
  }

  /** c sees `holder` with a thing c covets. */
  envyObject(c, holder, o) {
    if (!holder || holder.id === c.id || !this.covetsObject(c, o)) return null;
    if (o.ownerId === c.id) return null; // their own thing in someone else's hands is anger, not envy
    if (this.world.groups.isFamily(c.id, holder.id)) return null;
    const thing = this.world.objects.surfaceText(o);
    return this.envy(c, holder.id, o.id, `${ref(holder)} has ${thing}, and I have nothing like it.`);
  }

  envy(c, targetId, about, cause) {
    const E = this.rules.envy ?? {};
    if (!this.#ready(c, 'envy', targetId, about, E.cooldownMinutes ?? 60)) return null;
    const recent = this.world.db.prepare(`SELECT COUNT(*) AS n FROM emotion_log WHERE citizen_id = ? AND kind = 'bump' AND game_time >= ?
      AND json_extract(data, '$.type') = 'envy' AND json_extract(data, '$.target') = ?`).get(c.id, this.world.now - (E.recentDays ?? 3) * 1440, targetId).n;
    const delta = (E.base ?? 2) + (E.agreeableness ?? 2) * (1 - (c.persona?.traits?.agreeableness ?? 0.5)) + (E.perRecentBump ?? 0.5) * recent;
    const r = this.emo.bump(c, { type: 'envy', target: targetId, about, delta, cause, source: 'signal', rule: 'envy', raw: true });
    if (r && r.before < 4 && r.after >= 4) {
      this.world.logEvent('emotion', { actorId: c.id, location: c.location, emotion: 'envy', otherId: targetId, about, intensity: Math.round(r.after * 10) / 10, cause: cause });
    }
    return r;
  }

  /** A coveted role: someone becomes leader / head of a group c wanted to lead. */
  onGroupRole(group, citizenId, role) {
    if (!['leader', 'head'].includes(String(role))) return;
    const holder = this.world.citizens.get(citizenId);
    for (const c of this.world.citizens.values()) {
      if (c.id === citizenId || !c.alive) continue;
      const wants = (c.persona?.covets ?? []).some((k) => k === `group_leader:${group.id}` || k === `group_leader:${group.kind}`);
      if (wants && holder) this.envy(c, citizenId, `group:${group.id}`, `${ref(holder)} leads ${group.name}. It should have been me.`);
    }
  }

  // ---------- jealousy ----------
  /** x and y are close together in front of c: if c is attached to one of them, the other is a rival. */
  jealousyPair(c, x, y, causeFn, factor = 1) {
    if (!x || !y || x === y || c.id === x || c.id === y) return null;
    const J = this.rules.jealousy ?? {};
    const attached = (id) => (this.world.memory.rel(c.id, id)?.affinity ?? 0) >= (J.attachmentAffinity ?? 4);
    let out = null;
    for (const [b, rival] of [[x, y], [y, x]]) {
      if (!attached(b) || attached(rival) && (this.world.memory.rel(c.id, rival)?.affinity ?? 0) > (this.world.memory.rel(c.id, b)?.affinity ?? 0)) continue;
      if (this.world.groups.isFamily(b, rival)) continue;
      out = this.jealousy(c, b, rival, causeFn(b, rival), factor) ?? out;
    }
    return out;
  }

  jealousy(c, belovedId, rivalId, cause, factor = 1) {
    const J = this.rules.jealousy ?? {};
    if (!this.#ready(c, 'jealousy', rivalId, belovedId, J.cooldownMinutes ?? 60)) return null;
    const t = c.persona?.traits ?? {};
    const trust = this.world.memory.rel(c.id, belovedId)?.trust ?? 0;
    const beloved = this.world.citizens.get(belovedId);
    const showsAffection = beloved && this.emo.of(beloved).some((e) => e.type === 'affection' && e.target === rivalId && this.emo.expressed(beloved, e) >= 3);
    const delta = Math.max(0.5, ((J.base ?? 2) + (J.neuroticism ?? 3) * (t.neuroticism ?? 0.5) + (J.trust ?? -0.3) * trust + (showsAffection ? J.visibleAffection ?? 1 : 0)) * factor);
    const r = this.emo.bump(c, { type: 'jealousy', target: rivalId, about: belovedId, delta, cause, source: 'signal', rule: 'jealousy', raw: true });
    if (r && r.before < 4 && r.after >= 4) {
      this.world.logEvent('emotion', { actorId: c.id, location: c.location, emotion: 'jealousy', otherId: rivalId, about: belovedId, intensity: Math.round(r.after * 10) / 10, cause });
    }
    return r;
  }

  /** Learned secondhand (a told memory that puts the beloved and a rival together): a weaker pang. */
  secondhand(c, aboutIds) {
    const ids = [...new Set(aboutIds)].filter((id) => id !== c.id && this.world.citizens.has(id));
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        this.jealousyPair(c, ids[i], ids[j], (b, r) => `I heard ${ref(b)} and ${ref(r)} have been spending time together.`, this.rules.jealousy?.secondhandFactor ?? 0.5);
      }
    }
  }

  /**
   * At consolidation: envy or jealousy that stayed at 5+ for most of the day hardens into an attitude:
   * a relationship event with a reason. Feelings slowly become attitudes.
   */
  lasting(c) {
    const L = this.rules.lasting ?? {};
    const out = [];
    for (const e of this.emo.of(c)) {
      if (!['envy', 'jealousy'].includes(e.type) || !e.target || e.intensity < (L.minIntensity ?? 5)) continue;
      if (this.emo.shareOfDay(c.id, e.type, e.target, L.minIntensity ?? 5) <= (L.shareOfDay ?? 0.5)) continue;
      const rival = this.world.citizens.get(e.target);
      if (!rival) continue;
      const p = rival.persona?.sex?.toLowerCase().startsWith('f') ? 'she' : rival.persona?.sex?.toLowerCase().startsWith('m') ? 'he' : 'they';
      const about = e.about && this.world.citizens.has(e.about) ? ref(e.about) : null;
      const reason = e.type === 'jealousy'
        ? `I can't stand how close ${p}${p === 'they' ? "'re" : "'s"} getting to ${about ?? 'someone I care about'}.`
        : `It galls me that ${p} ${p === 'they' ? 'have' : 'has'} what I can't.`;
      this.world.relationships.change(c.id, e.target, { affinity: L.dAffinity ?? -1 }, { reason, source: 'consolidation', evidence: { emotion: e.type, about: e.about ?? null } });
      out.push({ type: e.type, target: e.target, reason });
    }
    return out;
  }

  // ---------- helpers ----------
  /** Who would they blame for a missing thing? Only if a warning sign points at someone recently. */
  suspectFor(c, obj) {
    const rows = this.world.db.prepare(`SELECT other_id, evidence FROM relationship_events WHERE citizen_id = ? AND source = 'signal' AND game_time >= ? ORDER BY id DESC LIMIT 20`)
      .all(c.id, this.world.now - 2 * 1440);
    const hit = rows.find((r) => /"sign":"(property|hiding|property_missing)"/.test(r.evidence) && (!obj || r.evidence.includes(obj.id) || true));
    return hit?.other_id ?? null;
  }

  #ready(c, type, target, about, cooldown) {
    const key = `${c.id}|${type}|${target}|${about}`;
    if (this.world.now - (this.cool.get(key) ?? -Infinity) < cooldown) return false;
    this.cool.set(key, this.world.now);
    if (this.cool.size > 20000) this.cool.clear();
    return true;
  }
}

function firstSentence(s) {
  const t = String(s ?? '').trim();
  const m = /^.*?[.!?](\s|$)/.exec(t);
  return (m ? m[0] : t).trim().slice(0, 160);
}
