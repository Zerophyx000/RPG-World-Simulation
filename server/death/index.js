// Step 9.5 (Part B): death that matters. world.deaths owns everything a death means to the LIVING:
//
//   knowledge   c.knownDeaths = { deadId: { learnedAt, how, certainty, where, by? } }
//               how: witnessed · found · told:<id> · inferred      certainty: certain · believed · doubted · suspected
//               Nobody knows a death until they witness it, examine the body or are told (B1). Everything about a
//               death in a prompt goes through knows(): names marked "(dead)", grief, fear, on-my-mind, target enums.
//   grief       sadness aimed at the dead, by closeness, at the moment of LEARNING (B2.2); a floor of 5 for three days
//               for family and close friends; a pinned on-my-mind line for seven days; reminders; body effects (B2.3)
//   mortality   fear for one's own life from others' deaths (B3.1) and from one's own body (B3.2)
//   dread       per region (map), 0..10, in world_state 'dread' (B3.3): known deaths, damage, unburied bodies
//   news        "Lena doesn't know about Greta yet" for someone who knows (B5.1)
//
// The body object and its decay, and the customs (tend, vigil, burial, gatherings) live in customs.js. The observer and
// the director see the ground truth; this module is about what each citizen knows.
import { getState, setState } from '../db.js';
import { citizensIn } from '../world/rooms.js';
import { ref, plainRef } from '../memory/index.js';
import { pronouns } from '../world/citizens.js';
import { decayTick, corpseOf } from './customs.js';

export const CERTAINTY = ['suspected', 'doubted', 'believed', 'certain'];
const RANK = Object.fromEntries(CERTAINTY.map((c, i) => [c, i]));
const GRIEF_FLOOR = 5;
const GRIEF_FLOOR_DAYS = 3;
const GRIEF_HALF_LIFE_HOURS = 24 * 10;
const PIN_DAYS = 7;
const FULL_TIER_HOURS = 12;
const MORTALITY_HALF_LIFE_HOURS = 48;
const OWN_CHECK_EVERY = 10;          // game minutes
const SCAN_EVERY = 1;                // bodies seen, news to break
const VIOLENT = /bled|blood|blast|stab|cut|burn|crush|kill|slain|wound|fell|skull|blow|beaten|struck|shot|drown/i;
const REMINDER_EVERY = 30;           // per reminder kind
const DREAD_MAX = 10;
// news of a death in plain words — including the words of burial ("lay him to rest", "Jonas's burial"), seen in a GLM run
export const DEATH_WORDS = /\b(dead|died|dies|death|no breath|not breathing|isn't breathing|stopped breathing|passed|gone|killed|lifeless|cold and still|bury|buried|burial|funeral|grave|mourn\w*|laid to rest|lay \w+ to rest|laying \w+ to rest|to rest|vigil|wake for)\b/i;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class Deaths {
  constructor(world) {
    this.world = world;
    this.lastScan = -Infinity;
    this.lastOwn = -Infinity;
    this.lastDay = null;
    this.dread = {};                 // mapId -> { value, lastIncidentAt, decayedAt }
  }

  load() {
    const saved = getState(this.world.db, 'dread', null);
    this.dread = saved ?? {};
    for (const c of this.world.citizens.values()) {
      if (!c.knownDeaths || typeof c.knownDeaths !== 'object') c.knownDeaths = {};
    }
    if (!saved) this.#backfill();
  }

  // A world from before step 9.5: deaths that are already known count once, decayed since they became known.
  #backfill() {
    const w = this.world;
    let last = null;
    for (const d of w.citizens.values()) {
      if (d.alive || d.deathKnownAt != null) continue;
      const times = [...w.citizens.values()].map((c) => c.knownDeaths?.[d.id]).filter((e) => e && RANK[e.certainty] >= RANK.doubted).map((e) => e.learnedAt);
      if (!times.length) continue;
      d.deathKnownAt = Math.min(...times);
      const witnessed = [...w.citizens.values()].some((c) => c.knownDeaths?.[d.id]?.how === 'witnessed');
      const map = w.maps.mapOf(d.deathPlace ?? d.location) ?? this.#defaultMap();
      const cur = this.dread[map] ?? { value: 0, lastIncidentAt: null, decayedAt: w.now };
      cur.value = Math.min(DREAD_MAX, cur.value + 3 + (witnessed ? 0 : 1));
      cur.lastIncidentAt = Math.max(cur.lastIncidentAt ?? -Infinity, d.deathKnownAt);
      this.dread[map] = cur;
      last = Math.max(last ?? -Infinity, d.deathKnownAt);
      w.saveCitizen(d);
    }
    for (const d of Object.values(this.dread)) {
      const days = Math.max(0, (w.now - (d.lastIncidentAt ?? w.now)) / 1440 - 1); // the decay starts a day after the last incident
      d.value = Math.max(0, Math.round((d.value - 0.5 * days) * 100) / 100);
      d.decayedAt = w.now;
    }
    if (last != null) this.#saveDread();
  }

  // ---------- knowledge ----------
  entry(viewer, deadId) {
    const v = typeof viewer === 'string' ? this.world.citizens.get(viewer) : viewer;
    return v?.knownDeaths?.[deadId] ?? null;
  }

  /** Does the viewer know (or believe, or doubt) that this person is dead? Suspicion is not knowing. */
  knows(viewer, deadId) {
    const e = this.entry(viewer, deadId);
    return Boolean(e && RANK[e.certainty] >= RANK.doubted);
  }

  certainty(viewer, deadId) {
    return this.entry(viewer, deadId)?.certainty ?? null;
  }

  /** The dead this viewer knows (or believes) are dead. */
  knownDead(viewer) {
    return Object.entries(viewer?.knownDeaths ?? {}).filter(([, e]) => RANK[e.certainty] >= RANK.doubted).map(([id]) => id);
  }

  /** "(dead)" / "(dead, or so you were told)" for name labels — '' when they don't know. */
  deadTag(viewerId, otherId) {
    const e = this.entry(viewerId, otherId);
    if (!e || RANK[e.certainty] < RANK.doubted) return '';
    return e.certainty === 'doubted' ? ' (dead, or so you were told)' : ' (dead)';
  }

  /**
   * The viewer learns of (or becomes surer about) a death. Upgrades only. Grief and fear happen HERE, at the moment of
   * learning (not at the moment of death). Returns the entry when something changed, else null.
   */
  learn(viewer, deadId, { how, certainty, where = null, by = null, quiet = false } = {}) {
    const w = this.world;
    const c = typeof viewer === 'string' ? w.citizens.get(viewer) : viewer;
    const dead = w.citizens.get(deadId);
    if (!c || !dead || c.id === deadId || !c.alive || dead.alive) return null;
    c.knownDeaths ??= {};
    const cur = c.knownDeaths[deadId];
    if (cur && RANK[cur.certainty] >= RANK[certainty]) return null;
    const firstReal = (!cur || cur.certainty === 'suspected') && RANK[certainty] >= RANK.doubted;
    const confirming = cur && cur.certainty === 'doubted' && RANK[certainty] >= RANK.believed;
    const e = { learnedAt: cur?.certainty !== 'suspected' && cur ? cur.learnedAt : w.now, how, certainty, where: where ?? cur?.where ?? dead.deathPlace ?? null, ...(by ? { by } : {}) };
    c.knownDeaths[deadId] = e;
    w.logEvent('learned_death', { actorId: c.id, location: c.location, deadId, how, certainty, where: e.where });
    if (!quiet && (firstReal || confirming)) {
      this.#firstKnown(dead);
      this.#grieve(c, dead, e, { confirming });
      if (firstReal) this.#mortality(c, dead, e);
    }
    w.saveCitizen(c);
    return e;
  }

  /**
   * Plain speech counts as telling (seen in a GLM run: "It's her. I found her cold on the floor — no breath in her."
   * left the listener merely suspecting for hours). When someone who knows of a death says it — the dead's name, or a
   * pronoun while the body lies right here — together with words of death, the hearers learn it (believed or doubted
   * by their trust in the speaker).
   */
  onSpeech(speaker, text, hearers) {
    const w = this.world;
    const said = String(text ?? '');
    if (!hearers.length || !DEATH_WORDS.test(said)) return;
    for (const deadId of this.knownDead(speaker)) {
      const dead = w.citizens.get(deadId);
      if (!dead) continue;
      const named = new RegExp(`\\b${escapeRe(dead.name)}\\b`, 'i').test(said);
      const p = pronouns(dead);
      const bodyHere = [...w.objects.inRoom(speaker.location)].some((o) => o.typeId === 'corpse' && o.data?.citizenId === deadId);
      const pointed = bodyHere && new RegExp(`\\b(${p.subj}|${p.obj}|${p.poss})\\b`, 'i').test(said);
      if (!named && !pointed) continue;
      for (const o of hearers) {
        if (o.id === deadId || this.knows(o, deadId)) continue;
        const trust = w.memory.rel(o.id, speaker.id)?.trust ?? 0;
        this.learn(o, deadId, { how: `told:${speaker.id}`, certainty: trust < 0 ? 'doubted' : 'believed', where: this.entry(speaker, deadId)?.where ?? null, by: speaker.id });
      }
    }
  }

  /** Death itself (from body/death.js): ties are kept for grief, awake witnesses know at once. */
  onDeath(dead, { roomId, cause, witnesses }) {
    const w = this.world;
    // ties outlive group membership (the dead leave their groups)
    const ties = dead.deathTies ?? {};
    if (!dead.deathTies) for (const m of w.groups.of(dead.id)) {
      if (!['family', 'household'].includes(m.group.kind)) continue;
      for (const o of w.groups.membersOf(m.group.id)) if (o.citizenId !== dead.id) ties[o.citizenId ?? o.id] = m.group.kind;
    }
    dead.deathTies = ties;
    dead.deathPlace = roomId;
    dead.deathCause = cause;
    dead.deathWitnessed = false;
    for (const o of witnesses) {
      if (!o.alive || ['sleeping', 'collapsed'].includes(o.activity.type)) continue;
      dead.deathWitnessed = true;
      this.learn(o, dead.id, { how: 'witnessed', certainty: 'certain', where: roomId });
    }
    w.saveCitizen(dead);
  }

  // The first time anyone alive knows: the village's dread rises (+3, +1 more when nobody saw it happen).
  #firstKnown(dead) {
    if (dead.deathKnownAt != null) return;
    dead.deathKnownAt = this.world.now;
    this.world.saveCitizen(dead);
    const map = this.world.maps.mapOf(dead.deathPlace) ?? this.#defaultMap();
    this.raiseDread(map, 3 + (dead.deathWitnessed ? 0 : 1), `${dead.name} is dead`);
  }

  // ---------- grief (B2.2) ----------
  /** How close the viewer was to the dead → grief intensity (0 = nothing). */
  closeness(c, dead) {
    const tie = dead.deathTies?.[c.id] ?? (this.world.groups.shared(c.id, dead.id, ['family', 'household']).length ? 'household' : null);
    const rel = this.world.memory.rel(c.id, dead.id);
    const aff = rel?.affinity ?? 0;
    const fam = rel?.familiarity ?? 0;
    if (tie) return { grief: 9, close: true, tie, affinity: aff };
    if (aff <= -3) return { grief: 2, close: false, enemy: true, affinity: aff };
    if (aff >= 4) return { grief: 8, close: true, affinity: aff };
    if (aff >= 2 || fam >= 6) return { grief: 6, close: aff >= 2, affinity: aff };
    if (fam >= 2) return { grief: 3, close: false, affinity: aff };
    return { grief: rel ? 1 : 0, close: false, affinity: aff };
  }

  #grieve(c, dead, e, { confirming = false } = {}) {
    const w = this.world;
    const k = this.closeness(c, dead);
    if (!k.grief) return;
    const doubted = e.certainty === 'doubted';
    let amount = k.grief * (doubted ? 0.5 : 1);
    if (confirming) amount = k.grief * 0.5; // the other half, now that it's sure
    const floor = (k.tie || k.affinity >= 4) && !doubted;
    w.emotions.bump(c, {
      type: 'sadness', target: dead.id, delta: amount, cause: `${plainRef(dead)} is dead`, source: 'death', raw: true, rule: 'grief',
      data: { grief: true, halfLifeHours: GRIEF_HALF_LIFE_HOURS, ...(floor ? { floor: GRIEF_FLOOR, floorUntil: w.now + GRIEF_FLOOR_DAYS * 1440 } : {}) },
    });
    if (k.enemy) {
      // the model decides between guilt and relief; code only puts it in front of them
      w.perceive([c.id], { kind: 'system', text: `You had no love for ${ref(dead)}. Now ${pronouns(dead).subj} is dead, and you are not sure what you feel.`, importance: 5 });
    }
    // mood: an immediate drop by closeness
    const drop = k.grief >= 8 ? 3 : k.grief >= 6 ? 2 : k.grief >= 3 ? 1 : 0;
    if (drop && !confirming) {
      const mood = w.emotions.mood(c);
      mood.valence = Math.max(-5, mood.valence - drop * (doubted ? 0.5 : 1));
      mood.tension = Math.min(10, mood.tension + 1);
    }
    // pinned on my mind for a week, with the place
    if (!confirming && k.grief >= 3) {
      const room = w.rooms.get(e.where)?.name ?? 'somewhere';
      c.onMyMind = (c.onMyMind ?? []).filter((m) => m.deathOf !== dead.id);
      w.memory.pushOnMind(c, { text: `${plainRef(dead)} is dead${doubted ? ' (or so you were told)' : ''} — at ${room}.`, importance: 10, pinnedUntil: w.now + PIN_DAYS * 1440, deathOf: dead.id });
    }
    // their next decisions think it through (A5)
    if (k.affinity >= 2 || k.tie) c.griefFullUntil = Math.max(c.griefFullUntil ?? 0, w.now + FULL_TIER_HOURS * 60);
    w.saveCitizen(c);
  }

  /** Grief for this dead person right now (0 if none). */
  griefFor(c, deadId) {
    return this.world.emotions.of(c).filter((e) => e.type === 'sadness' && e.target === deadId && e.data?.grief).reduce((m, e) => Math.max(m, e.intensity), 0);
  }

  /** Strongest grief entry of a citizen (for body effects, UI). */
  strongestGrief(c) {
    let best = null;
    for (const e of this.world.emotions.of(c)) if (e.type === 'sadness' && e.data?.grief && (!best || e.intensity > best.intensity)) best = e;
    return best;
  }

  /** A reminder of the dead: grief +0.5, at most once per 30 game minutes per kind. */
  remind(c, deadId, kind, text = null) {
    const w = this.world;
    if (!this.knows(c, deadId) || this.griefFor(c, deadId) <= 0) return false;
    c.griefReminders ??= {};
    const key = `${deadId}|${kind}`;
    if (w.now - (c.griefReminders[key] ?? -Infinity) < REMINDER_EVERY) return false;
    c.griefReminders[key] = w.now;
    w.emotions.bump(c, { type: 'sadness', target: deadId, delta: 0.5, cause: text ?? `everything here reminds me of ${ref(w.citizens.get(deadId))}`, source: 'reminder', raw: true, rule: `reminder:${kind}`, data: { grief: true } });
    if (text) w.perceive([c.id], { kind: 'system', text, importance: 4, roomId: c.location, data: { reminder: deadId } });
    return true;
  }

  // ---------- mortality (B3.1) ----------
  #mortality(c, dead, e) {
    const w = this.world;
    const cause = String(dead.deathCause ?? '');
    const witnessed = e.how === 'witnessed';
    let m = 2;
    if (VIOLENT.test(cause) && (witnessed || e.how === 'found' || e.certainty === 'certain')) m += 2;
    if (!witnessed) m += 2; // they don't know what happened: mysterious
    const where = e.where;
    const near = where && (where === c.home || where === c.location || (c.roomLog ?? []).some((r) => r.room === where || r.roomId === where) || (c.knownPlaces?.[where]?.source === 'home'));
    if (near) m += 1;
    const recent = Object.entries(c.knownDeaths ?? {}).filter(([id, x]) => id !== dead.id && RANK[x.certainty] >= RANK.doubted && w.now - x.learnedAt <= 3 * 1440).length;
    m += recent;
    w.emotions.bump(c, {
      type: 'fear', target: null, delta: Math.min(8, m), cause: `${plainRef(dead)} is dead${witnessed ? '' : ', and nobody knows how'}. It could be me next.`,
      source: 'death', rule: 'mortality', data: { mortality: true, halfLifeHours: MORTALITY_HALF_LIFE_HOURS },
    });
    c.mortalityAt = w.now;
    // the place it happened becomes a place to dread
    if (where) {
      c.fearedPlaces ??= {};
      c.fearedPlaces[where] = { since: w.now, why: `${dead.name} died there` };
    }
  }

  /** Fear about one's own life right now (the mortality entry), 0..10. */
  mortalityFear(c) {
    return this.world.emotions.of(c).filter((e) => e.type === 'fear' && e.data?.mortality).reduce((m, e) => Math.max(m, e.intensity), 0);
  }

  // ---------- own mortality (B3.2) ----------
  /** 'critical' | 'dangerous' | null, from the body. */
  ownState(c) {
    const b = c.body;
    if (!b || !c.alive) return null;
    const blood = b.blood ?? 100;
    const vit = b.vitality ?? 100;
    const status = b.status ?? [];
    if (b.critical || blood < 55 || vit < 25 || status.includes('dying')) return 'critical';
    const conds = this.world.body?.active(c.id) ?? [];
    const parts = this.world.body?.content?.parts ?? {};
    const bleeding = conds.filter((x) => (x.bleeding ?? 0) > 0.05);
    if (blood < 70 && (b.bleedTotal ?? 0) > 0.05) return 'dangerous';
    if (vit < 50) return 'dangerous';
    if (bleeding.length >= 2) return 'dangerous';
    for (const x of conds) {
      const region = parts[x.partId]?.region ?? x.partId;
      if (x.severity >= 7 && ['head', 'neck', 'torso'].includes(region)) return 'dangerous';
      if (x.type === 'fever' && x.severity >= 7) return 'dangerous';
      if ((x.infection ?? 0) >= 5) return 'dangerous';
    }
    return null;
  }

  /** The line at the top of the prompt, in the body's language. */
  ownLine(c) {
    const s = c.mortal?.state;
    if (!s) return null;
    if ((c.body?.status ?? []).includes('dying')) return "You're dying.";
    if (s === 'critical') return "You're getting colder. Something is very wrong. You could die from this, soon.";
    return 'You could die from this.';
  }

  /** Where help could be had: the nearest place they know with a healer, and anyone here who could help. */
  helpLine(c) {
    const w = this.world;
    const healers = [...w.citizens.values()].filter((o) => o.alive && o.id !== c.id && /heal|herb|physic|midwife|doctor/i.test(o.persona?.occupation ?? ''));
    const here = healers.filter((o) => o.location === c.location);
    if (here.length) return `${ref(here[0])} is right here and knows healing.`;
    const known = healers.find((o) => o.home && c.knownPlaces?.[o.home] && w.memory.rel(c.id, o.id)?.nameKnown);
    if (known) {
      const room = w.rooms.get(known.home);
      return `${ref(known)} knows healing; ${room?.name ?? 'their home'} is not far.`;
    }
    return null;
  }

  #checkOwn(c) {
    const w = this.world;
    const state = this.ownState(c);
    const prev = c.mortal?.state ?? null;
    if (!state) {
      if (prev) { c.mortal = null; w.saveCitizen(c); }
      return;
    }
    c.mortal = { state, since: prev === state ? c.mortal.since : w.now, lastBump: c.mortal?.lastBump ?? -Infinity };
    const bump = (delta) => w.emotions.bump(c, { type: 'fear', target: null, delta, cause: state === 'critical' ? 'I am dying' : 'I could die from this', source: 'body', rule: 'own_mortality', data: { mortality: true, halfLifeHours: MORTALITY_HALF_LIFE_HOURS } });
    if (state === 'critical' && prev !== 'critical') { bump(4); c.mortal.lastBump = w.now; }
    else if (state === 'dangerous' && w.now - c.mortal.lastBump >= 60) { bump(2); c.mortal.lastBump = w.now; }
    if (state !== prev) w.logEvent('mortality', { actorId: c.id, location: c.location, state, from: prev });
    w.saveCitizen(c);
  }

  // ---------- dread (B3.3) ----------
  #defaultMap() {
    return this.world.maps.maps?.[0]?.id ?? 'village';
  }

  dreadOf(mapId) {
    return this.dread[mapId]?.value ?? 0;
  }

  /** The dread where this citizen is (their room's region). */
  dreadFor(c) {
    const map = (c.location && this.world.maps.mapOf(c.location)) ?? this.#defaultMap();
    return this.dreadOf(map);
  }

  raiseDread(mapId, amount, why, { incident = true } = {}) {
    const d = this.dread[mapId] ?? { value: 0, lastIncidentAt: null, decayedAt: this.world.now };
    d.value = Math.min(DREAD_MAX, Math.max(0, d.value + amount));
    if (incident) d.lastIncidentAt = this.world.now;
    d.decayedAt = this.world.now;
    this.dread[mapId] = d;
    this.#saveDread();
    this.world.logEvent('dread', { mapId, value: round(d.value), delta: amount, why });
    return d.value;
  }

  setDread(mapId, value) {
    const d = this.dread[mapId] ?? { value: 0, lastIncidentAt: null, decayedAt: this.world.now };
    d.value = Math.min(DREAD_MAX, Math.max(0, Number(value) || 0));
    d.decayedAt = this.world.now;
    this.dread[mapId] = d;
    this.#saveDread();
    this.world.logEvent('director', { action: 'dread', mapId, value: d.value });
    return this.dreadView();
  }

  #saveDread() {
    setState(this.world.db, 'dread', this.dread);
    this.world.bus.emit('dread', this.dreadView());
  }

  dreadView() {
    const maps = this.world.maps.maps ?? [];
    return Object.fromEntries([...new Set([...maps.map((m) => m.id), ...Object.keys(this.dread)])].map((id) => [id, { value: round(this.dreadOf(id)), lastIncidentAt: this.dread[id]?.lastIncidentAt ?? null }]));
  }

  // −0.5 per game day without new incidents
  #decayDread(now) {
    let changed = false;
    for (const d of Object.values(this.dread)) {
      if (d.value <= 0) continue;
      const quietSince = Math.max(d.lastIncidentAt ?? -Infinity, d.decayedAt ?? -Infinity);
      const days = (now - quietSince) / 1440;
      if (d.lastIncidentAt != null && now - d.lastIncidentAt < 1440) continue;
      if (days < 0.25) continue;
      d.value = Math.max(0, d.value - 0.5 * days);
      d.decayedAt = now;
      changed = true;
    }
    if (changed) this.#saveDread();
  }

  // ---------- the tick ----------
  tick(elapsed, now) {
    const w = this.world;
    if (now - this.lastScan >= SCAN_EVERY) {
      this.lastScan = now;
      this.#seeBodies();
      this.#newsToBreak();
    }
    if (now - this.lastOwn >= OWN_CHECK_EVERY) {
      this.lastOwn = now;
      for (const c of w.citizens.values()) if (c.alive && c.kind === 'citizen') this.#checkOwn(c);
      this.#griefReminders();
      this.#decayDread(now);
      decayTick(w, now);
    }
  }

  // Bodies: anyone awake in a room with a body they don't know about sees someone "lying very still" (suspected).
  #seeBodies() {
    const w = this.world;
    for (const o of w.objects.byId.values()) {
      if (o.typeId !== 'corpse' || !o.roomId) continue;
      const deadId = o.data?.citizenId;
      const dead = deadId ? w.citizens.get(deadId) : null;
      if (!dead) continue;
      for (const c of citizensIn(w.citizens, o.roomId)) {
        if (['sleeping', 'collapsed'].includes(c.activity.type) || c.id === deadId) continue;
        if ((c.body?.status ?? []).includes('blind')) continue;
        if (this.entry(c, deadId)) continue; // suspected or more: seen already
        this.learn(c, deadId, { how: 'inferred', certainty: 'suspected', where: o.roomId, quiet: true });
        const known = w.memory.rel(c.id, deadId)?.nameKnown;
        const covered = o.data?.covered;
        const text = covered
          ? (known ? `Someone lies under a cloth on the floor, still. It has the shape of ${ref(dead)}.` : 'Someone lies under a cloth on the floor, quite still.')
          : (known ? `${ref(dead)} is lying very still on the floor. ${pronouns(dead).subj[0].toUpperCase() + pronouns(dead).subj.slice(1)} doesn't move.`
            : 'A stranger lies very still on the floor, not moving at all.');
        w.perceive([c.id], { kind: 'action', text, importance: 8, sourceId: deadId, roomId: o.roomId, data: { interrupt: true, body: deadId, suspected: true } });
        w.emotions.bump(c, { type: 'fear', target: null, delta: 2, cause: 'someone is lying so still', source: 'death', rule: 'body_seen' });
      }
    }
  }

  // B5.1: a knower and someone close to the dead who doesn't know yet, in the same place.
  #newsToBreak() {
    const w = this.world;
    const dead = [...w.citizens.values()].filter((d) => !d.alive);
    if (!dead.length) return;
    const byRoom = new Map();
    for (const c of w.citizens.values()) {
      if (!c.alive || !c.location || ['sleeping', 'collapsed'].includes(c.activity.type)) continue;
      (byRoom.get(c.location) ?? byRoom.set(c.location, []).get(c.location)).push(c);
    }
    for (const list of byRoom.values()) {
      if (list.length < 2) continue;
      for (const k of list) {
        for (const d of dead) {
          if (!this.knows(k, d.id)) continue;
          for (const o of list) {
            if (o === k || this.knows(o, d.id)) continue;
            const ties = this.closeness(o, d);
            if (!(ties.tie || ties.affinity >= 2)) continue;
            k.newsPrompted ??= {};
            const key = `${o.id}|${d.id}`;
            if (k.newsPrompted[key]) continue;
            if (!w.memory.rel(k.id, o.id)) continue;
            k.newsPrompted[key] = w.now;
            w.perceive([k.id], { kind: 'system', text: `${ref(o)} doesn't know about ${plainRef(d)} yet.`, importance: 7, sourceId: o.id, roomId: k.location, data: { breakNews: { to: o.id, dead: d.id } } });
            w.saveCitizen(k);
          }
        }
      }
    }
  }

  // B2.3: the dead's house, workplace, usual spot, grave and belongings remind the grieving.
  #griefReminders() {
    const w = this.world;
    for (const c of w.citizens.values()) {
      if (!c.alive || !c.location || ['sleeping', 'collapsed'].includes(c.activity.type)) continue;
      for (const deadId of this.knownDead(c)) {
        if (this.griefFor(c, deadId) < 1) continue;
        const d = w.citizens.get(deadId);
        if (!d) continue;
        const room = w.rooms.get(c.location);
        const placeName = room?.name ?? '';
        if (c.location === d.home) this.remind(c, deadId, 'home', `This was ${ref(d)}'s home.`);
        else if (room && (room.owner === d.id || (d.persona?.occupation && w.groups && (room.tags ?? []).includes(d.persona.occupation)))) this.remind(c, deadId, 'work', `${placeName}: this is where ${ref(d)} worked.`);
        const grave = [...w.objects.inRoom(c.location)].find((o) => o.typeId === 'grave' && o.data?.citizenId === deadId);
        if (grave) this.remind(c, deadId, 'grave', `${ref(d)}'s grave is here.`);
        const things = w.objects.inRoom(c.location).filter((o) => o.ownerId === deadId && o.typeId !== 'corpse');
        if (things.length && c.location !== d.home) this.remind(c, deadId, 'belongings', `Things of ${ref(d)}'s are here.`);
        // their habits' windows ("This is when Jonas used to sweep the floor")
        const h = w.habits?.windowNow(d);
        if (h) this.remind(c, deadId, `habit:${h.id}`, h.doing ? `At this hour ${plainRef(d)} would be ${h.doing.replace(/^(\w)/, (m) => m.toLowerCase())}.` : `This was ${plainRef(d)}'s time for: ${h.what.replace(/^(\w)/, (m) => m.toLowerCase())}.`);
        // others who grieve them
        for (const o of citizensIn(w.citizens, c.location, { exceptId: c.id })) if (this.griefFor(o, deadId) >= 3) { this.remind(c, deadId, 'mourner'); break; }
      }
    }
  }

  // ---------- body effects (B2.3) ----------
  /** Meals relieve less hunger while grief >= 6. */
  mealFactor(c) {
    return (this.strongestGrief(c)?.intensity ?? 0) >= 6 ? 0.8 : 1;
  }

  /** Fatigue builds faster while grief >= 6. */
  fatigueFactor(c) {
    return (this.strongestGrief(c)?.intensity ?? 0) >= 6 ? 1.1 : 1;
  }

  /** On falling asleep: a 30% chance a grieving sleeper wakes in the dark once. */
  onSleepStart(c) {
    const g = this.strongestGrief(c);
    if (!g || g.intensity < 6) return;
    if (Math.random() >= 0.3) return;
    c.griefWakeAt = this.world.now + 120 + Math.random() * 240;
    c.griefWakeOf = g.target;
  }

  // ---------- views ----------
  knownView(c) {
    const name = (id) => this.world.citizens.get(id)?.name ?? id;
    return Object.entries(c.knownDeaths ?? {}).map(([id, e]) => ({ deadId: id, name: name(id), ...e, grief: round(this.griefFor(c, id)) }));
  }

  /** For the timeline: when each citizen learned of each death. */
  learnedTimeline() {
    return this.world.db.prepare("SELECT game_time, actor_id, data FROM events WHERE type = 'learned_death' ORDER BY id").all()
      .map((r) => ({ t: r.game_time, citizenId: r.actor_id, ...JSON.parse(r.data) }));
  }
}

const round = (v) => Math.round(v * 100) / 100;

export { corpseOf };
