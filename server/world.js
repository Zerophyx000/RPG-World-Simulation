// The world: single owner of all state (clock, rooms, citizens, conversations, event log).
// Every mutation happens in a World method or a module World calls. LLM results never
// write state directly: they hand an action to World, which validates it first.
//
// Modules: world/* hold the logic (rooms, citizens, needs, places, perception, actions,
// conversations, director, quiet, scenarios); agents/* hold the thinking loop.
import { EventEmitter } from 'node:events';
import { Clock } from './clock.js';
import { LLM } from './llm.js';
import { config } from './config.js';
import { backup } from './db.js';
import { loadRooms, citizensIn, danglingExits, saveRoom, activeEffects, activeServices, serviceNames } from './world/rooms.js';
import { appearance } from './world/appearance.js';
import { Wear } from './world/wear.js';
import { Decals } from './world/decals.js';
import { Positions } from './world/positions.js';
import { createCitizenStore, citizenFromInput, citizenSummary, needsSummary, bodySummary } from './world/citizens.js';
import { makeStimulus, pushToInbox, mergeInboxes, IMPORTANCE } from './world/perception.js';
import { applyAction, resolveTimers, applyHeldSay, wake, startSleep, collapse, die, finishMeal } from './world/actions.js';
import { Conversations } from './world/conversations.js';
import { upsertRooms, seedCitizensIfEmpty, wipeCitizens, loadWorldText, activeScenario, loadScenario, listScenarios } from './world/scenarios.js';
import { Needs, NEED_KINDS, UNAWARE } from './world/needs.js';
import { Body } from './body/index.js';
import { Maps } from './world/maps.js';
import { hearing } from './body/perceive.js';
import { initialKnownPlaces, learnPlace } from './world/places.js';
import { Quiet } from './world/quiet.js';
import { directorEvent, expireDirectorState, EFFECT_TYPES } from './world/director.js';
import { Scheduler } from './agents/scheduler.js';
import { Governor } from './agents/governor.js';
import { validatePlan, startPlan, planActive, stepText } from './agents/plan.js';
import { Memory } from './memory/index.js';
import { Objects, placementSig } from './world/objects.js';
import { Relationships } from './social/relationships.js';
import { Groups } from './social/groups.js';
import { Strangers } from './social/strangers.js';
import { Signals } from './social/signals.js';
import { relationLine } from './social/describe.js';
import { Emotions } from './emotions/index.js';
import { parseFeeling, applyFeeling } from './emotions/report.js';
import { onConversationEnd as reflectOnConversationEnd } from './memory/reflect.js';
import { onSleepStart as consolidateOnSleep, consolidate as consolidateNow, decayAndFade } from './memory/consolidate.js';
import { seedFromScenario, ensureVillageAcquaintance, bootstrap as bootstrapMemories } from './memory/bootstrap.js';
import { buildMessages } from './agents/prompt.js';
import { buildTools } from './agents/tools.js';
import { setState } from './db.js';

const THOUGHT_MAX = 2000;
const THINK_COOLDOWN_MINUTES = 1; // the governor raises it under budget pressure
const CO_PRESENCE_EVERY = 10;      // game minutes between "who sees whom" updates
const ERROR_WAIT_MINUTES = 10;
const NO_ACTION_WAIT_MINUTES = 5;
const NEEDS_FLUSH_MS = 5000;   // need values drift every tick; persist them at most this often
const SLEEP_BUFFER_MAX = 8;
const UNAWARE_ACT = UNAWARE; // step A2: bodies that don't notice things (one list, in needs.js)

export class World {
  constructor(db) {
    this.db = db;
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(100);
    this.clock = new Clock(db, this.bus, config.clock);
    this.llm = new LLM(db, this.bus, () => this.clock.gameMinutes);
    this.stopped = false;
    this.memory = new Memory(this);
    this.relationships = new Relationships(this); // step 5.5: the single write path for trust / affinity / familiarity
    this.groups = new Groups(this);
    this.objects = new Objects(this);
    this.strangers = new Strangers(this);
    this.signals = new Signals(this);
    this.emotions = new Emotions(this);   // step 6: feelings shape what citizens are shown, never what they do

    this.insertEvent = db.prepare(`INSERT INTO events (game_time, real_time, type, actor_id, location, data)
                                   VALUES (?, ?, ?, ?, ?, ?)`);
    this.store = createCitizenStore(db);
    this.conversations = new Conversations(this);
    this.scheduler = new Scheduler(this);
    this.needs = new Needs();
    this.body = new Body(this);           // step 7B: parts, conditions, blood, healing, death (the one writer)
    this.maps = new Maps(this);
    this.wear = new Wear(this);            // step 9: worn paths (tiles walked over, decaying)
    this.decals = new Decals(this);        // step 9: lasting marks: soot, scorch, rubble, puddles, blood
    this.positions = new Positions(this);  // step 9: every position change as an event (replay)           // step 8: footprints, doors and named spots per room (checked against the room graph)
    this.quiet = new Quiet(this);
    this.rooms = new Map();
    this.citizens = new Map();
    this.runtimes = new Map(); // citizenId -> { think, seq, lastInterruptAt }  (in memory only)
    this.worldText = '';
    this.scenario = config.scenario;
    this.dirty = new Set();    // citizens whose need values changed since the last flush
    this.lastFlush = Date.now();

    // Night hooks: falling asleep may start the nightly memory consolidation.
    this.hooks = {
      onSleepStart: (citizen) => consolidateOnSleep(this, citizen),
      onWake(_citizen, _sleptMinutes) {},
      // step 9 (visual record only, never perceived): trips feed the wear map and the replay log; room effects leave marks
      onTripStart: (citizen, trip) => this.positions?.onTripStart(citizen, this.#withPath(trip)),
      onTrip: (citizen, trip) => { const t = this.#withPath(trip); this.wear?.onTrip(citizen, t); this.positions?.onTrip(citizen, t); },
      onRoomEffect: (room, effect, info) => this.decals?.onRoomEffect(room, effect, info),
    };
    this.lastCoPresence = -Infinity;

    this.#load();
    this.governor = new Governor(this);
    this.llm.routeFilter = (purpose, chain) => this.governor.filterRoute(purpose, chain);
    this.clock.horizonFn = () => this.quiet.nextEventAt();
    this.clock.onTick((elapsed, now) => this.#tick(elapsed, now));
  }

  get now() {
    return this.clock.gameMinutes;
  }

  // ---------- boot ----------
  #load() {
    upsertRooms(this.db); // rooms are content: every boot brings new services/appearances into a live world
    this.rooms = loadRooms(this.db);
    this.maps.load(); // fails loudly if a room has no footprint or an exit no door
    this.wear.load(); this.decals.load(); // step 9: persisted traces
    for (const bad of danglingExits(this.rooms)) console.warn(`[world] exit to unknown room: ${bad}`);

    this.scenario = activeScenario(this.db, config.scenario);
    const seeded = seedCitizensIfEmpty(this.db, this.rooms, this.now, this.scenario);
    if (seeded) this.#applyScenarioStart();
    this.worldText = loadWorldText(this.scenario);
    this.citizens = this.store.loadAll();
    this.runtimes.clear();
    this.memory.load();
    if (seeded) seedFromScenario(this, seeded.inputs);
    this.objects.load(this.scenario); // types from content, new content instances seeded, invariant checked
    this.body.load();                 // step 7B: body state for everyone (HP → vitality), garments seeded once

    for (const c of this.citizens.values()) {
      let changed = false;
      // `thinking` is never a final state: a citizen saved mid-think simply thinks again.
      if (c.activity.type === 'thinking' || c.thinkingInbox.length) {
        c.inbox = mergeInboxes(c.thinkingInbox, c.inbox);
        c.thinkingInbox = [];
        if (c.activity.type === 'thinking') c.activity = { type: 'idle', since: this.now, until: null, detail: null };
        changed = true;
      }
      // Citizens from before step 3 are locals: they know the whole village.
      if (!c.knownPlaces) {
        c.knownPlaces = initialKnownPlaces(this.rooms, 'all', { location: c.location, home: c.home, now: this.now });
        changed = true;
      }
      const here = this.rooms.get(c.location);
      if (here && learnPlace(c, here.id, serviceNames(here, this.now), 'visited', this.now)) changed = true;
      if (changed) this.saveCitizen(c);
      // Step 5: the room they stand in is the baseline for noticing changes later.
      if (here && !c.roomSnapshots?.[here.id]) this.objects.snapshotRoom(c, here.id);
    }
    // A village from before step 4: the locals have lived alongside each other (bootstrap adds the rest).
    // Runs after knownPlaces are filled in, since that is how locals are recognised.
    if (this.scenario === 'village') ensureVillageAcquaintance(this);
    this.relationships.consistencyCheck(); // step 5.5: every relationship has at least one reason on record
    this.groups.load(this.scenario);        // content groups seeded once, in-group reasons written (after acquaintance)
    this.conversations.load();
    this.conversations.reconcile();
  }

  // Scenario start time (e.g. "07:00"): move the clock FORWARD to the next such time, never back.
  #applyScenarioStart() {
    let meta;
    try {
      meta = loadScenario(this.scenario);
    } catch {
      return;
    }
    const m = /^(\d{1,2}):(\d{2})$/.exec(meta.startTime ?? '');
    if (!m) return;
    const dayStart = Math.floor(this.now / 1440) * 1440;
    let target = dayStart + Number(m[1]) * 60 + Number(m[2]);
    if (target < this.now) target += 1440;
    this.clock.gameMinutes = target;
    this.clock.save();
  }

  // ---------- tick ----------
  #tick(elapsed, now) {
    this.body.tick(elapsed, now);     // step 7B: bleeding, clotting, vitality, healing (before the needs levels read them)
    this.#updateBodies(elapsed, now);
    if (now - this.lastCoPresence >= CO_PRESENCE_EVERY) {
      this.lastCoPresence = now;
      this.memory.updateCoPresence();
    }
    resolveTimers(this, now);
    this.#expireEffects(now);
    expireDirectorState(this, now);
    this.conversations.releaseDue((held) => applyHeldSay(this, held));
    this.conversations.tick(now);
    this.emotions.tick(elapsed, now); // decay, mood drift, contagion, hourly samples
    this.quiet.update();
    this.scheduler.run();
    this.wear?.tick(now);   // step 9: decay and hourly persistence (self-throttled)
    this.decals?.tick(now);
    if (Date.now() - this.lastFlush >= NEEDS_FLUSH_MS) this.#flushNeeds();
  }

  /** step 9: the tile path of a trip, computed on the server with the map's A* (furniture blocks). */
  #withPath(trip) {
    try { return { ...trip, path: this.maps.tilePath(trip.fromRoom, trip.fromSpot, trip.toRoom, trip.toSpot) }; } catch { return { ...trip, path: null }; }
  }

  #updateBodies(elapsed, now) {
    for (const c of this.citizens.values()) {
      if (!c.alive) continue;
      // step 8: everyone in a room stands at one of its spots (old worlds, newcomers, director moves)
      if (c.location && (!c.spot || !this.maps.spot(c.location, c.spot))) c.spot = this.maps.startSpot(c.location);
      else if (!c.location && c.spot) c.spot = null;
      const f = this.needs.advance(c, elapsed);
      this.dirty.add(c.id);
      if (f.hpZero) {
        if (this.needs.lethal) die(this, c, { reason: c.needs.hunger >= this.needs.starvingAt ? 'starvation' : 'injury' });
        else collapse(this, c, { reason: c.needs.hunger >= this.needs.starvingAt ? 'starvation' : 'injury' });
        continue;
      }
      // step A2: the collapse countdown starts the moment fatigue reaches the top level, and stops when
      // the body recovers below it.
      if (c.needs.collapsingSince == null && !UNAWARE_ACT.has(c.activity.type) && c.needs.fatigue >= this.needs.topFatigueMin) {
        c.needs.collapsingSince = now;
        this.saveCitizen(c);
      } else if (c.needs.collapsingSince != null && c.needs.fatigue < this.needs.topFatigueMin) {
        c.needs.collapsingSince = null;
        this.saveCitizen(c);
      }
      // Forced sleep: fatigue 100, or still up after the collapse deadline — whichever comes first.
      const collapseAt = this.needs.collapseAt(c, now);
      if (f.forcedSleep || (collapseAt != null && now >= collapseAt)) {
        this.#forcedSleep(c, { reason: f.forcedSleep ? 'fatigue_100' : 'collapse_deadline', fatigue: Math.round(c.needs.fatigue) });
      } else if (f.rested) {
        wake(this, c, { reason: 'rested' });
      } else if (c.wokeEarly) {
        const fatigueMin = this.needs.levelOf('fatigue', 'exhausted');
        const exhaustion = this.needs.levelIndex('fatigue', c.needs) >= fatigueMin;
        if (!exhaustion) {
          c.wokeEarly = null; // slept it off after all
          this.saveCitizen(c);
        } else if (now >= c.wokeEarly.until && c.activity.type !== 'sleeping' && c.activity.type !== 'collapsed') {
          if ((c.lastUrgentAt ?? -1) > c.wokeEarly.at) { // after the wake-up itself (whatever woke them doesn't count)
            c.wokeEarly = null; // something more important than sleep is going on
            this.saveCitizen(c);
          } else {
            this.#forcedSleep(c, { reason: 'woken_early', fatigue: Math.round(c.needs.fatigue) });
          }
        }
      }
      for (const s of this.needs.checkLevels(c, now)) {
        if (s.importance >= 5 && !UNAWARE_ACT.has(c.activity.type)) {
          this.logEvent('body', { actorId: c.id, location: c.location, need: s.data.need, level: s.data.level, importance: s.importance, reminder: s.data.reminder, text: s.text });
        }
        this.perceive([c.id], s);
      }
    }
  }

  // step A2: the body takes over (a deliberate physical exception to "citizens decide"): stop whatever
  // they were doing and thinking, drop them where they stand, and let them sleep it off.
  #forcedSleep(c, { reason, fatigue }) {
    this.cancelThink(c);
    if (c.conversationId) {
      const conv = this.conversations.get(c.conversationId);
      this.conversations.leave(c, { reason: 'collapsed' });
      // The room sees them go down through startSleep(forced): "X sways and slumps to the ground, asleep."
      if (conv) this.saveCitizen(c); // leave() may have ended the conversation and saved the others
    }
    c.needs.collapsingSince = null;
    startSleep(this, c, { quality: 'rough', untilRested: true, forced: true });
    this.logEvent('forced_sleep', { actorId: c.id, location: c.location, reason, fatigue });
  }

  #flushNeeds() {
    this.lastFlush = Date.now();
    this.body.flush();
    for (const id of this.dirty) {
      const c = this.citizens.get(id);
      if (c) this.saveCitizen(c);
    }
    this.dirty.clear();
  }

  // ---------- citizens: persistence + live updates ----------
  saveCitizen(c) {
    if (this.stopped || this.citizens.get(c.id) !== c) return;
    this.store.save(c);
    this.dirty.delete(c.id);
    this.bus.emit('citizen', {
      id: c.id, name: c.name, kind: c.kind, alive: c.alive, location: c.location,
      activity: c.activity, conversationId: c.conversationId, inboxSize: c.inbox.length,
      lastInnerThought: c.lastInnerThought, lastDecisionAt: c.lastDecisionAt, hp: c.needs?.hp ?? 100,
      needs: needsSummary(c), body: bodySummary(c), spot: c.spot ?? null, marks: c.marks, plan: this.planSummary(c), emotion: this.emotions?.summary(c) ?? null,
    });
  }

  /** Compact plan state for the roster: "3/6 · baking the morning bread", paused or not. */
  planSummary(c) {
    const p = c.plan;
    if (!p) return null;
    const cur = p.steps[Math.min(p.cursor, p.steps.length - 1)];
    return {
      status: p.status, cursor: p.cursor, total: p.steps.length, interrupted: Boolean(p.interrupted),
      current: cur ? stepText(this, c, cur) : null,
    };
  }

  setActivity(c, { type, until = null, detail = null }) {
    const prev = c.activity;
    // An interrupted meal still counts for the part that was eaten.
    if (prev?.type === 'doing' && prev.detail?.kind === 'eat' && !prev.detail.done && (type !== 'doing' || detail?.kind !== 'eat')) {
      prev.detail.done = true;
      finishMeal(this, c, prev, { completed: false });
    }
    c.activity = { type, since: this.now, until, detail };
    this.saveCitizen(c);
    // Activity spans for the timeline are rebuilt from these events.
    if (!this.stopped && this.citizens.get(c.id) === c && (prev?.type !== type || !sameDetail(prev?.detail, detail))) {
      this.logEvent('activity', {
        actorId: c.id, location: c.location, from: prev?.type ?? null, to: type, until, detail: activityDetail(type, detail),
      });
    }
  }

  citizensIn(roomId, opts) {
    return citizensIn(this.citizens, roomId, opts);
  }

  runtime(id) {
    let rt = this.runtimes.get(id);
    if (!rt) {
      rt = { think: null, seq: 0, lastInterruptAt: -Infinity };
      this.runtimes.set(id, rt);
    }
    return rt;
  }

  // ---------- perception ----------
  /**
   * Deliver a stimulus (or a per-viewer builder `(citizen) => stimulus`) to citizens.
   * Sleepers: >= 7 wakes them (body: only hunger/pain >= 8, never tiredness); 4–6 is kept for "while you slept…";
   * less is lost. Collapsed: nothing gets through.
   */
  perceive(citizenIds, stimulusOrFn) {
    const delivered = [];
    for (const id of citizenIds) {
      const c = this.citizens.get(id);
      if (!c || !c.alive) continue;
      const partial = typeof stimulusOrFn === 'function' ? stimulusOrFn(c) : stimulusOrFn;
      if (!partial) continue;
      const s = hearing(c, makeStimulus(partial, this.now)); // step 7B: deaf / hard of hearing hear less
      // step A2: an emergency (>= 7) that gets through to someone counts, asleep or not.
      if (s.importance >= 7) c.lastUrgentAt = this.now;
      if (c.activity.type === 'collapsed') continue;
      if (c.activity.type === 'sleeping') {
        // The body speaks differently in sleep: tiredness never wakes you; only a real emergency (>= 8,
        // e.g. pain crossing to critical) gets through, and hunger can't (they'd only fall over again).
        if (s.kind === 'body' && (s.data?.need === 'fatigue' || s.importance < 8)) continue;
        // Dropped from exhaustion and still spent: only a real emergency (>= 8) gets through.
        const spent = c.activity.detail?.forced && c.needs.fatigue >= 60;
        if (spent && (s.kind === 'body' || s.importance < 8)) {
          if (s.importance >= 4 && s.kind !== 'body') {
            c.sleepBuffer = [...(c.sleepBuffer ?? []), { text: s.text, gameTime: s.gameTime, importance: s.importance }].slice(-SLEEP_BUFFER_MAX);
            this.saveCitizen(c);
          }
          continue;
        }
        if (s.importance >= 7) {
          wake(this, c, { reason: 'jolt', cause: s });
        } else {
          if (s.importance >= 4 && s.kind !== 'body') {
            c.sleepBuffer = [...(c.sleepBuffer ?? []), { text: s.text, gameTime: s.gameTime, importance: s.importance }].slice(-SLEEP_BUFFER_MAX);
            this.saveCitizen(c);
          }
          continue;
        }
      }
      s.text = this.memory.resolveNames(c, s.text); // "Tomas" or "a broad and heavy-shouldered man", per viewer
      pushToInbox(c, s);
      this.emotions.appraisal.onPerceived(c, s); // first, so the memory is laid down with the feeling
      this.memory.onPerceived(c, s);
      this.saveCitizen(c);
      if (s.importance >= 5) this.quiet.snap(); // something worth watching: back to normal speed now
      this.scheduler.onStimulus(c, s);
      delivered.push(c.id);
    }
    return delivered;
  }

  // ---------- actions ----------
  applyAction(c, call) {
    return applyAction(this, c, call);
  }

  // ---------- thinking lifecycle (used by agents/think.js) ----------
  beginThink(c, { mode = 'decide' } = {}) {
    this.quiet.snap();
    if (mode === 'decide' && planActive(c)) c.plan.interrupted = true;
    const rt = this.runtime(c.id);
    const conv = this.conversations.of(c);
    const t = {
      token: ++rt.seq, controller: new AbortController(), cancelled: null, startedAt: this.now,
      convId: conv?.id ?? null, convLines: conv?.lines.length ?? 0, rethought: false,
    };
    rt.think = t;
    c.thinkingInbox = mergeInboxes(c.thinkingInbox, c.inbox); // snapshot + clear; restored on abort
    c.inbox = [];
    const prev = c.activity;
    this.setActivity(c, {
      type: 'thinking',
      detail: {
        token: t.token,
        interrupted: prev.type === 'thinking' ? prev.detail?.interrupted ?? null
          : { type: prev.type, since: prev.since, until: prev.until, detail: prev.detail },
      },
    });
    return t;
  }

  /** Lines spoken in the citizen's conversation since this think started. */
  conversationLinesSince(c, t) {
    const conv = this.conversations.of(c);
    if (!conv || conv.id !== t.convId) return 0;
    return conv.lines.length - t.convLines;
  }

  /** The conversation moved on while this think ran: fold new stimuli in and think once more. */
  rethinkStale(c, t, linesSince) {
    t.rethought = true;
    t.convLines = this.conversations.of(c)?.lines.length ?? t.convLines;
    c.thinkingInbox = mergeInboxes(c.thinkingInbox, c.inbox);
    c.inbox = [];
    this.saveCitizen(c);
    this.logEvent('rethink_stale', { actorId: c.id, location: c.location, conversationId: t.convId, linesSince });
  }

  isCurrentThink(c, t) {
    return !this.stopped && !t.cancelled && this.citizens.get(c.id) === c && this.runtime(c.id).think === t;
  }

  #ownsThink(c, t) {
    return !this.stopped && this.citizens.get(c.id) === c && this.runtime(c.id).think === t;
  }

  /** The model decided. Store its thoughts and apply the action. */
  completeThink(c, t, outcome) {
    if (!this.#ownsThink(c, t)) return;
    this.runtime(c.id).think = null;
    c.thinkingInbox = [];
    c.lastThought = trimText(outcome.reasoning, THOUGHT_MAX);
    c.lastDecisionAt = this.now;
    c.thinkCooldownUntil = this.now + (this.governor?.thinkGapMinutes() ?? THINK_COOLDOWN_MINUTES);
    c.lastTier = outcome.tier ?? null;
    this.memory.recalled(outcome.recalled);
    this.#afterThought(c, outcome);

    if (outcome.call) {
      if (outcome.innerThought) c.lastInnerThought = outcome.innerThought; // keep the latest thought if this decision had none
      this.applyAction(c, { ...outcome.call, innerThought: outcome.innerThought || null });
    } else if (outcome.fallback) {
      if (outcome.innerThought) c.lastInnerThought = outcome.innerThought;
      this.logEvent('error', { actorId: c.id, location: c.location, message: `invalid tool call twice: ${outcome.error}` });
      this.setActivity(c, { type: 'waiting', until: this.now + NO_ACTION_WAIT_MINUTES, detail: { reason: 'hesitating', minutes: NO_ACTION_WAIT_MINUTES } });
    } else {
      // Text but no tool call: a private thought; the citizen lingers for a bit.
      c.lastInnerThought = trimText(outcome.text, 600) || c.lastInnerThought;
      this.setActivity(c, { type: 'waiting', until: this.now + NO_ACTION_WAIT_MINUTES, detail: { reason: 'lost in thought', minutes: NO_ACTION_WAIT_MINUTES } });
    }
  }

  // Step 6: the optional `feeling` on a decision (clamped ±3, known people only), and grudges stirred by
  // the memories that were in mind for this decision.
  #afterThought(c, outcome) {
    const raw = outcome.call?.arguments?.feeling;
    if (raw != null && raw !== '') {
      const people = this.memory.labelsFor(c, [...new Set([...this.memory.knownPeople(c), ...(c.location ? this.citizensIn(c.location, { exceptId: c.id }) : [])])]);
      const f = parseFeeling(this, c, raw, people);
      const r = applyFeeling(this, c, f, 'self');
      this.logEvent('feeling', { actorId: c.id, location: c.location, raw: String(typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 200), parsed: f, applied: r ? Math.round(r.applied * 100) / 100 : 0 });
    }
    const ids = (outcome.recalled ?? []).slice(0, 8);
    if (ids.length) {
      const rows = this.db.prepare(`SELECT about FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
      const about = new Set(rows.flatMap((r) => { try { return JSON.parse(r.about); } catch { return []; } }));
      for (const id of about) this.emotions.ruminate(c, id, 'recall');
    }
  }

  /** A planning think finished: validate the steps and start the plan (code carries it out). */
  completePlanThink(c, t, outcome) {
    if (!this.#ownsThink(c, t)) return;
    this.runtime(c.id).think = null;
    c.thinkingInbox = [];
    c.lastThought = trimText(outcome.reasoning, THOUGHT_MAX);
    c.lastDecisionAt = this.now;
    c.lastTier = 'full';
    c.thinkCooldownUntil = this.now + (this.governor?.thinkGapMinutes() ?? THINK_COOLDOWN_MINUTES);
    if (outcome.innerThought) c.lastInnerThought = outcome.innerThought;
    this.memory.recalled(outcome.recalled);
    const raw = outcome.call?.name === 'make_plan' ? outcome.call.arguments.steps : [];
    const { steps, dropped } = validatePlan(this, c, raw);
    startPlan(this, c, steps, dropped); // an empty plan still counts as planned (no endless re-planning)
    this.setActivity(c, { type: 'idle' });
  }

  /** Aborted (interrupt, pause) or stale: put the inbox back and let the scheduler pick them up again. */
  abandonThink(c, t) {
    if (!this.#ownsThink(c, t)) return;
    this.runtime(c.id).think = null;
    c.inbox = mergeInboxes(c.thinkingInbox, c.inbox);
    c.thinkingInbox = [];
    this.setActivity(c, { type: 'idle' });
  }

  /** HTTP error / timeout: lost in thought for a while, inbox kept. */
  failThink(c, t, err) {
    if (!this.#ownsThink(c, t)) return;
    this.runtime(c.id).think = null;
    c.inbox = mergeInboxes(c.thinkingInbox, c.inbox);
    c.thinkingInbox = [];
    c.thinkCooldownUntil = this.now + ERROR_WAIT_MINUTES;
    this.logEvent('error', { actorId: c.id, location: c.location, message: String(err?.message ?? err).slice(0, 500) });
    this.setActivity(c, { type: 'waiting', until: this.now + ERROR_WAIT_MINUTES, detail: { reason: 'lost in thought', minutes: ERROR_WAIT_MINUTES } });
  }

  interruptThink(c, cause = null) {
    const rt = this.runtime(c.id);
    if (!rt.think || rt.think.cancelled) return;
    rt.lastInterruptAt = this.now;
    rt.think.cancelled = 'interrupt';
    rt.think.controller.abort(new Error('interrupted'));
    this.logEvent('interrupt', {
      actorId: c.id, location: c.location,
      cause: cause && { kind: cause.kind, text: cause.text.slice(0, 200), sourceId: cause.sourceId },
    });
  }

  /**
   * Something took the decision out of the citizen's hands (fell asleep, collapsed, was moved):
   * abort an in-flight think and DETACH it, so its result can't overwrite the new state.
   * The snapshot inbox goes back into the inbox. The caller sets the new activity.
   */
  cancelThink(c) {
    const rt = this.runtime(c.id);
    if (!rt.think) return;
    rt.think.cancelled = 'forced';
    rt.think.controller.abort(new Error('forced'));
    rt.think = null;
    c.inbox = mergeInboxes(c.thinkingInbox, c.inbox);
    c.thinkingInbox = [];
  }

  #cancelAllThinks(reason) {
    for (const rt of this.runtimes.values()) {
      if (rt.think && !rt.think.cancelled) {
        rt.think.cancelled = reason;
        rt.think.controller.abort(new Error(reason));
      }
    }
  }

  // ---------- clock control ----------
  pause() {
    this.quiet.snap();
    this.clock.pause();
    this.conversations.freezeFloors(); // the reading floor stops with the clock
    this.#cancelAllThinks('pause');    // aborted thinks settle into idle with their inbox kept
    this.#flushNeeds();
  }

  resume() {
    this.conversations.thawFloors();
    this.clock.resume();
    this.scheduler.poke();
  }

  // ---------- director ----------
  /** Located, distance-based event with optional effects. See world/director.js. */
  directorEvent(input) {
    return directorEvent(this, input);
  }

  effectTypes() {
    return Object.entries(EFFECT_TYPES).map(([type, d]) => ({ type, label: d.label, room: Boolean(d.room) }));
  }

  /** Testing: set need values directly. Levels update on the next tick and announce themselves normally. */
  setNeeds({ citizenId, hunger, fatigue, hp }) {
    if (!this.citizens.has(citizenId)) throw httpError(404, `unknown citizen "${citizenId}"`);
    return this.directorEvent({ effects: [{ type: 'needs', target: citizenId, mode: 'set', hunger, fatigue, hp, notify: false }] });
  }

  revive({ citizenId }) {
    const c = this.citizens.get(citizenId);
    if (!c) throw httpError(404, `unknown citizen "${citizenId}"`);
    if (c.activity.type !== 'collapsed') throw httpError(400, `${c.name} is not collapsed`);
    return this.body.reviveCitizen(citizenId); // step 7B: vitality at least 30, conditions stay
  }

  /** Director: remove one room effect (or all with effectId = null). */
  clearEffect(roomId, effectId = null) {
    const room = this.rooms.get(roomId);
    if (!room) throw httpError(404, `unknown room "${roomId}"`);
    const before = room.effects.length;
    room.effects = effectId ? room.effects.filter((e) => e.id !== effectId) : [];
    if (room.effects.length === before) throw httpError(404, 'no such effect');
    this.saveRoom(room);
    this.logEvent('director', { action: 'clear_effect', location: room.id, effectId: effectId ?? 'all' });
    return { ok: true };
  }

  #expireEffects(now) {
    for (const room of this.rooms.values()) {
      if (!room.effects.length) continue;
      const active = activeEffects(room, now);
      if (active.length !== room.effects.length) {
        room.effects = active;
        this.saveRoom(room);
      }
    }
  }

  saveRoom(room) {
    saveRoom(this.db, room);
    this.bus.emit('room', this.roomView(room));
  }

  roomView(r) {
    const now = this.now;
    return {
      id: r.id, name: r.name, description: r.description, appearance: r.appearance, exits: r.exits, tags: r.tags, x: r.x, y: r.y,
      danger: r.danger ?? 0, owner: r.owner ?? null,
      effects: activeEffects(r, now),
      services: activeServices(r, now),
      allServices: r.services,
      serviceOverrides: r.serviceOverrides,
      blockedExits: (r.blockedExits ?? []).filter((b) => b.until == null || b.until > now),
    };
  }

  /** Optional helper for the director form: write `near` and `far` versions of a `here` text. */
  async generateEventTexts({ roomId, here }) {
    const room = this.rooms.get(roomId);
    if (!room) throw httpError(400, `unknown room "${roomId}"`);
    here = String(here ?? '').trim().replace(/\{room\}/g, room.name);
    if (!here) throw httpError(400, 'here is required');
    const tools = [{
      type: 'function',
      function: {
        name: 'event_texts',
        description: 'The same event as perceived from further away.',
        parameters: {
          type: 'object',
          properties: {
            near: { type: 'string', description: 'Second person, one sentence: perceived from a place right next to it.' },
            far: { type: 'string', description: 'Second person, one sentence: perceived from elsewhere in the village, faint and vague.' },
          },
          required: ['near', 'far'],
        },
      },
    }];
    const r = await this.llm.chat({
      purpose: 'director_text',
      tools,
      messages: [
        { role: 'system', content: 'You write short sensory narration for a village simulation. Second person ("you hear..."). Only describe what could be sensed from that distance: sounds, smells, tremors, glimpses. No names of people. One sentence each.' },
        { role: 'user', content: `Event at ${room.name}, as experienced by someone right there:\n"${here}"\n\nWrite how it is perceived by someone in a neighbouring place (near) and by someone further away in the village (far). Call event_texts.` },
      ],
    });
    const args = r.toolCalls?.[0]?.arguments ?? safeJsonObject(r.content);
    return { near: String(args?.near ?? '').trim(), far: String(args?.far ?? '').trim(), callId: r.callId ?? null };
  }

  whisper({ citizenId, text, importance }) {
    text = String(text ?? '').trim();
    if (!text) throw httpError(400, 'text is required');
    if (!this.citizens.has(citizenId)) throw httpError(404, `unknown citizen "${citizenId}"`);
    return this.directorEvent({ effects: [{ type: 'whisper', target: citizenId, text, importance: importance === '' ? undefined : importance }] });
  }

  createCitizen(input) {
    let c;
    try {
      c = citizenFromInput(input, { rooms: this.rooms, existingIds: new Set(this.citizens.keys()), now: this.now });
    } catch (err) {
      throw httpError(400, err.message);
    }
    this.store.insert(c);
    this.citizens.set(c.id, c);
    this.body.ensureState(c); // step 7B: body state and garments for newcomers too
    this.saveCitizen(c);
    this.groups.seed(this.scenario); // content memberships for someone who appears later
    this.perceive(this.citizensIn(c.location, { exceptId: c.id }).map((o) => o.id), {
      kind: 'arrive', text: `${c.name} is here.`, importance: IMPORTANCE.arriveDepart, sourceId: c.id, roomId: c.location,
    });
    this.logEvent('director', { action: 'create_citizen', location: c.location, citizenId: c.id, name: c.name });
    this.bus.emit('world', { reason: 'citizen_created', id: c.id });
    return citizenSummary(c);
  }

  /** Scenario characters with "active": false (e.g. Kael) and whether they are in the world yet. */
  inactiveCitizens() {
    let list = [];
    try {
      list = loadScenario(this.scenario).citizens;
    } catch { /* unknown scenario */ }
    return list.filter((x) => x.active === false).map((x) => ({
      id: x.id, name: x.name, occupation: x.persona?.occupation ?? null, inWorld: this.citizens.has(x.id),
      secretGoals: x.persona?.secretGoals ?? [], appearanceTags: x.persona?.appearanceTags ?? [],
    }));
  }

  /** Director: bring a dormant scenario character into the world (with their seed memories and groups). */
  activateCitizen({ id, location }) {
    let input;
    try {
      input = loadScenario(this.scenario).citizens.find((x) => x.id === id && x.active === false);
    } catch { /* fall through */ }
    if (!input) throw httpError(404, `no inactive scenario character "${id}"`);
    if (this.citizens.has(id)) throw httpError(400, `${input.name} is already in the world`);
    const summary = this.createCitizen({ ...input, location: location || input.location });
    seedFromScenario(this, [input]);
    this.logEvent('director', { action: 'activate_citizen', citizenId: id, name: input.name });
    return summary;
  }

  // ---------- step 5.5: reasons, groups, strangers ----------
  relationshipEvents(citizenId, otherId) {
    if (!this.citizens.has(citizenId)) throw httpError(404, `unknown citizen "${citizenId}"`);
    const c = this.citizens.get(citizenId);
    return {
      row: this.memory.rel(citizenId, otherId),
      events: this.relationships.events(citizenId, otherId, 200).map((e) => ({ ...e, reason: detokName(this, e.reason) })),
      inPrompt: this.citizens.has(otherId) ? relationLine(this, c, this.citizens.get(otherId)) : null,
    };
  }

  warinessOf(citizenId, otherId) {
    const a = this.citizens.get(citizenId);
    const b = this.citizens.get(otherId);
    if (!a || !b) throw httpError(404, 'unknown citizen');
    return { ...this.strangers.wariness(a, b), stranger: this.strangers.isStranger(a, b), line: this.strangers.line(a, b), strangerTrust: a.strangerTrust };
  }

  setStrangerTrust({ citizenId, value }) {
    const c = this.citizens.get(citizenId);
    if (!c) throw httpError(404, `unknown citizen "${citizenId}"`);
    c.strangerTrust = Math.min(0.95, Math.max(0.05, Number(value)));
    c.strangerLog = [...(c.strangerLog ?? []), { at: this.now, value: c.strangerTrust, why: 'director' }].slice(-30);
    this.saveCitizen(c);
    return { strangerTrust: c.strangerTrust };
  }

  /** Director: persona bits that have no effect type of their own (appearance tags, secret goals, covets). */
  setPersonaList({ citizenId, field, values }) {
    const c = this.citizens.get(citizenId);
    if (!c) throw httpError(404, `unknown citizen "${citizenId}"`);
    if (!['appearanceTags', 'secretGoals', 'covets'].includes(field)) throw httpError(400, 'field must be appearanceTags, secretGoals or covets');
    c.persona[field] = (Array.isArray(values) ? values : String(values ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean);
    this.saveCitizen(c);
    this.logEvent('director', { action: 'persona_list', citizenId, field, values: c.persona[field] });
    return { [field]: c.persona[field] };
  }

  setRoomDanger({ roomId, danger }) {
    const room = this.rooms.get(roomId);
    if (!room) throw httpError(404, `unknown room "${roomId}"`);
    room.danger = Math.min(10, Math.max(0, Number(danger) || 0));
    this.saveRoom(room);
    return this.roomView(room);
  }

  // ---------- memory (director tools + hooks) ----------
  onConversationEnd(conv, end) {
    if (this.stopped) return;
    reflectOnConversationEnd(this, conv, end).catch((err) => console.warn('[memory] reflection failed:', err.message));
  }

  directorMemory({ citizenId, action, text, importance, about, memoryId }) {
    const c = this.citizens.get(citizenId);
    if (!c) throw httpError(404, `unknown citizen "${citizenId}"`);
    if (action === 'add') {
      if (!String(text ?? '').trim()) throw httpError(400, 'text is required');
      const id = this.memory.add(c.id, {
        kind: 'episodic', text: String(text).trim(), importance: Number(importance) || 5,
        about: (Array.isArray(about) ? about : about ? [about] : []).filter((x) => this.citizens.has(x)),
        placeId: c.location, source: { director: true },
      });
      if ((Number(importance) || 5) >= 7) this.memory.pushOnMind(c, { text: String(text).trim(), importance: Number(importance), memoryId: id });
      this.logEvent('director', { action: 'memory_add', citizenId: c.id, memoryId: id, text });
      return { ok: true, id };
    }
    if (action === 'forget') {
      const row = this.db.prepare('SELECT id FROM memories WHERE id = ? AND citizen_id = ?').get(Number(memoryId), c.id);
      if (!row) throw httpError(404, 'no such memory for this citizen');
      this.memory.setStatus(row.id, 'forgotten');
      this.logEvent('director', { action: 'memory_forget', citizenId: c.id, memoryId: row.id });
      return { ok: true };
    }
    throw httpError(400, 'action must be add or forget');
  }

  async consolidateCitizen({ citizenId }) {
    const c = this.citizens.get(citizenId);
    if (!c) throw httpError(404, `unknown citizen "${citizenId}"`);
    decayAndFade(this, c);
    const record = await consolidateNow(this, c);
    return { ok: true, record };
  }

  /**
   * Director: set values (absolute), or apply deltas (dAffinity / dTrust / dFamiliarity), always with a reason
   * the citizen could name.
   */
  setRelationship({ citizenId, otherId, affinity, trust, familiarity, dAffinity, dTrust, dFamiliarity, nameConfidence, summary, reason }) {
    if (!this.citizens.has(citizenId) || !this.citizens.has(otherId)) throw httpError(404, 'unknown citizen');
    const given = (v) => v != null && v !== '';
    const meta = {};
    if (given(nameConfidence)) {
      meta.nameConfidence = Number(nameConfidence);
      meta.nameKnown = Number(nameConfidence) > 0;
    }
    if (summary != null) meta.summary = String(summary).trim() || null;
    const cur = this.memory.rel(citizenId, otherId);
    const target = {};
    for (const [k, abs, d] of [['affinity', affinity, dAffinity], ['trust', trust, dTrust], ['familiarity', familiarity, dFamiliarity]]) {
      if (given(abs)) target[k] = Number(abs);
      else if (given(d)) target[k] = (cur?.[k] ?? 0) + Number(d);
    }
    let row;
    if (Object.keys(target).length) {
      const why = String(reason ?? '').trim() || meta.summary || 'Something changed how I see them.';
      row = this.relationships.change(citizenId, otherId, target, { set: true, source: 'director', reason: why, meta }).row;
    } else {
      row = this.memory.upsertRel(citizenId, otherId, meta);
    }
    this.logEvent('director', { action: 'relationship', citizenId, otherId, ...target, ...meta, reason: reason ?? null });
    return row;
  }

  bootstrapMemories({ citizenIds } = {}) {
    const running = bootstrapMemories(this, citizenIds);
    running.catch((err) => console.warn('[memory] bootstrap failed:', err.message));
    return { started: true };
  }

  scenarios() {
    return { active: this.scenario, list: listScenarios() };
  }

  /** Dev only: back up, wipe citizens + rooms + conversations, seed a scenario from content/. */
  reseed({ scenario } = {}) {
    const id = scenario || this.scenario || config.scenario;
    try {
      loadScenario(id);
    } catch (err) {
      throw httpError(400, err.message);
    }
    const file = backup(this.db, 'pre-reseed');
    this.#cancelAllThinks('reseed');
    this.conversations.clear();
    wipeCitizens(this.db);
    this.db.exec('DELETE FROM rooms; DELETE FROM objects; DELETE FROM object_history; DELETE FROM emotion_log;');
    setState(this.db, 'scenario', id);
    this.#load();
    this.needs.reload();
    this.logEvent('director', { action: 'reseed', scenario: id, backup: file });
    this.bus.emit('world', { reason: 'reseed' });
    this.scheduler.poke();
    return { ok: true, scenario: id, rooms: this.rooms.size, citizens: this.citizens.size };
  }

  // ---------- read models for the API ----------
  snapshot() {
    return {
      clock: this.clock.snapshot(),
      scenario: this.scenario,
      rooms: [...this.rooms.values()].map((r) => this.roomView(r)),
      citizens: [...this.citizens.values()].map((c) => ({ ...citizenSummary(c), look: appearance(this, c), plan: this.planSummary(c), lastTier: c.lastTier ?? null, emotion: this.emotions.summary(c) })),
      conversations: this.conversations.list().map((cv) => this.conversations.view(cv)),
      objects: [...this.objects.byId.values()].map((o) => this.objects.view(o)),
      groups: this.groups.list(),
    };
  }

  /** Step 8: how everybody looks right now ({ id: appearance }), for the map view (polled; read-only). */
  looks() {
    return Object.fromEntries([...this.citizens.values()].map((c) => [c.id, appearance(this, c)]));
  }

  citizenDetail(id) {
    const c = this.citizens.get(id);
    if (!c) throw httpError(404, `unknown citizen "${id}"`);
    const conv = this.conversations.of(c);
    const name = (cid) => this.citizens.get(cid)?.name ?? cid;
    const reminders = this.needs.nextReminders(c, this.now);
    return {
      ...c,
      needsView: Object.fromEntries(NEED_KINDS.map((k) => {
        const idx = this.needs.levelIndex(k, c.needs);
        return [k, {
          value: Math.round(c.needs[k] * 10) / 10,
          max: k === 'hp' ? c.needs.hpMax : 100,
          level: idx,
          levelName: this.needs.levelName(k, idx),
          told: c.needs.levels[k] ?? 0,
          nextReminderIn: reminders[k],
          thresholds: this.needs.levels(k).map((l) => ({ name: l.name, at: k === 'hp' ? ((l.minPct ?? 0) / 100) * (c.needs.hpMax ?? 100) : l.min })),
        }];
      })),
      groupsView: this.groups.of(c.id).map((m) => ({ id: m.group.id, name: m.group.name, kind: m.group.kind, public: m.group.public, role: m.role, secret: m.secret, purpose: m.group.data?.purpose ?? null })),
      invitationsView: this.groups.invitations(c).map((i) => ({ ...i, fromName: name(i.from) })),
      strangersView: (c.location ? this.citizensIn(c.location, { exceptId: c.id }) : []).filter((o) => this.strangers.isStranger(c, o))
        .map((o) => ({ id: o.id, name: o.name, ...this.strangers.wariness(c, o) })),
      relationshipsView: this.memory.relsOf(c.id).map((r) => ({
        ...r, name: this.citizens.get(r.otherId)?.name ?? r.otherId,
        reasons: this.relationships.reasons(c.id, r.otherId, 2).map((e) => ({ reason: detokName(this, e.reason), source: e.source, strength: e.strength, dTrust: e.dTrust, dAffinity: e.dAffinity })),
        tags: this.citizens.has(r.otherId) ? this.groups.tagsFor(c, this.citizens.get(r.otherId)) : [],
        appearance: this.citizens.get(r.otherId)?.persona?.appearance ?? '',
        lastSeenPlaceName: r.lastSeenPlace ? this.rooms.get(r.lastSeenPlace)?.name ?? r.lastSeenPlace : null,
      })),
      planView: c.plan ? { ...c.plan, steps: c.plan.steps.map((st) => ({ ...st, text: stepText(this, c, st) })) } : null,
      memoryCount: this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE citizen_id = ? AND status = 'active'").get(c.id).n,
      knownPlacesView: Object.entries(c.knownPlaces ?? {}).map(([rid, k]) => ({
        id: rid, name: this.rooms.get(rid)?.name ?? rid, services: k.services, source: k.source,
        sourceName: k.source?.startsWith('told:') ? name(k.source.slice(5)) : null, learnedAt: k.learnedAt,
      })),
      ...this.#objectsOf(c),
      emotionsView: this.emotions.view(c),
      bodyView: this.body.view(c.id), // step 7B
      promptPreview: buildMessages(this, c),
      toolsPreview: buildTools(this, c).map((t) => t.function.name),
      conversation: conv && { ...this.conversations.view(conv), participantNames: conv.participants.map(name) },
      lastCalls: this.db.prepare(`SELECT id, real_time, game_time, purpose, status, duration_ms
                                  FROM llm_calls WHERE citizen_id = ? ORDER BY id DESC LIMIT 10`).all(c.id),
    };
  }

  // ---------- objects (step 5) ----------
  /** Inspector: what they carry, where they THINK things are vs where they are, and their room snapshots. */
  #objectsOf(c) {
    const O = this.objects;
    return {
      carryingView: O.carriedBy(c.id).map((o) => ({ ...O.view(o), alias: O.alias(o) })),
      slotsUsed: O.slotsUsed(c.id),
      knownObjectsView: Object.entries(c.knownObjects ?? {}).map(([id, k]) => {
        const o = O.get(id);
        if (!o) return { id, gone: true, believed: k };
        const sig = placementSig(o);
        const mismatch = (k.holderId ?? null) !== (o.holderId ?? null) || (k.roomId ?? null) !== (o.roomId ?? null)
          || k.placementSig !== sig || k.state !== o.state;
        return {
          id, label: O.label(o), believed: k, mismatch,
          believedText: k.holderId ? `carried by ${this.citizens.get(k.holderId)?.name ?? k.holderId}` : `${this.rooms.get(k.roomId)?.name ?? k.roomId}${sigText(O, k.placementSig)}`,
          actualText: o.holderId ? `carried by ${this.citizens.get(o.holderId)?.name ?? o.holderId}` : `${this.rooms.get(o.roomId)?.name ?? o.roomId}${sigText(O, sig)}`,
          actual: { roomId: o.roomId, holderId: o.holderId, placementSig: sig, state: o.state, visibility: O.surfaceTier(o) },
        };
      }).sort((a, b) => (b.mismatch === true) - (a.mismatch === true) || (b.believed?.lastSeenAt ?? 0) - (a.believed?.lastSeenAt ?? 0)),
      snapshotsView: Object.entries(c.roomSnapshots ?? {}).map(([roomId, s]) => ({
        roomId, roomName: this.rooms.get(roomId)?.name ?? roomId, at: s.at,
        objects: Object.entries(s.objects).map(([id, v]) => ({ id, label: O.get(id) ? O.label(O.get(id)) : id, sig: v })),
      })).sort((a, b) => b.at - a.at),
      roomVisits: c.roomVisits ?? {},
    };
  }

  /** GET /api/rooms/:id/objects?view=true|surface&citizen= */
  roomObjects(roomId, { view = 'true', citizen = null } = {}) {
    if (!this.rooms.has(roomId)) throw httpError(404, `unknown room "${roomId}"`);
    const O = this.objects;
    if (view === 'surface') {
      const c = this.citizens.get(citizen);
      if (!c) throw httpError(400, 'the surface view needs ?citizen=<id>');
      const { items, listed, overflow } = O.perceiveRoom(c, roomId);
      const shown = new Set(listed.map((it) => it.o.id));
      return {
        roomId, view, citizen: c.id, lines: c.location === roomId ? O.whatsHere(c) : null, overflow,
        objects: items.map((it) => ({ ...O.view(it.o), text: O.textFor(c, it.o, { withPlace: true }), tier: it.tier, listed: shown.has(it.o.id), knownHidden: it.knownHidden })),
      };
    }
    return { roomId, view: 'true', objects: O.inRoom(roomId).map((o) => O.view(o)) };
  }

  objectDetail(id) {
    const o = this.objects.get(id);
    if (!o) throw httpError(404, `unknown object "${id}"`);
    const name = (cid) => this.citizens.get(cid)?.name ?? cid;
    return {
      ...this.objects.view(o), alias: this.objects.alias(o),
      history: this.objects.history(id).map((h) => ({ ...h, actorName: h.actor_id ? name(h.actor_id) : null, witnessNames: h.witnesses.map(name) })),
      knownBy: [...this.citizens.values()].filter((c) => c.knownObjects?.[id]).map((c) => ({ id: c.id, name: c.name, believed: c.knownObjects[id] })),
    };
  }

  createObject(body) {
    return this.objects.create(body ?? {}, { actorId: 'director', origin: 'director' });
  }

  /** PATCH /api/director/objects/:id: goes through objects.change() like everything else. */
  patchObject(id, body = {}) {
    const patch = {};
    for (const k of ['state', 'visibility', 'searchDifficulty', 'ownerId', 'surfaceText', 'trueText', 'name', 'typeId']) if (body[k] !== undefined) patch[k] = body[k];
    if (body.holderId) patch.holderId = body.holderId;
    else if (body.roomId) {
      patch.roomId = body.roomId;
      patch.placement = body.placement ?? { relation: 'floor' };
    } else if (body.placement) patch.placement = body.placement;
    if (!Object.keys(patch).length) throw httpError(400, 'nothing to change');
    const action = patch.holderId || patch.roomId ? 'move' : patch.state ? 'state' : patch.visibility === 'hidden' ? 'conceal' : 'edit';
    const notify = body.notify ? String(body.notify) : null;
    return this.objects.change(id, patch, {
      actorId: 'director', action, notify: Boolean(notify), perceive: notify ? () => notify : null, importance: body.importance ?? null,
    });
  }

  resetObject(id) {
    return this.objects.reset(id);
  }

  // ---------- event log ----------
  logEvent(type, { actorId = null, location = null, ...data } = {}) {
    const row = {
      gameTime: this.clock.gameMinutes,
      realTime: new Date().toISOString(),
      type, actorId, location, data,
    };
    const info = this.insertEvent.run(row.gameTime, row.realTime, type, actorId, location, JSON.stringify(data));
    row.id = Number(info.lastInsertRowid);
    this.bus.emit('event', row);
    return row;
  }

  recentEvents(limit = 50) {
    return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit)
      .map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  start() {
    this.clock.start();
  }

  stop() {
    this.#flushNeeds();
    try { this.wear?.save(); } catch { /* step 9: worn paths are a visual record; never block a shutdown */ }
    this.governor?.stop();
    this.llm.stop();
    this.#cancelAllThinks('shutdown'); // citizens stay stored as `thinking` and simply think again after restart
    this.stopped = true;
    this.clock.stop();
  }
}

// Reasons carry {{c:id}} tokens; the director sees real names.
function detokName(world, text) {
  return String(text ?? '').replace(/\{\{c:([\w-]+)\}\}/g, (_m, id) => world.citizens.get(id)?.name ?? id);
}

function sigText(O, sig) {
  const [rel, of] = String(sig ?? 'floor').split(':');
  const a = of && O.get(of);
  return a && rel !== 'floor' ? ` (${rel} ${O.short(a)})` : '';
}

function sameDetail(a, b) {
  return JSON.stringify(activityDetail(null, a)) === JSON.stringify(activityDetail(null, b));
}

// The bits of an activity's detail worth keeping in the event log (not the whole interrupted state).
function activityDetail(_type, d) {
  if (!d) return null;
  const out = {};
  for (const k of ['description', 'reason', 'from', 'to', 'conversationId', 'held', 'minutes', 'quality', 'finalDest', 'kind', 'forced']) {
    if (d[k] != null) out[k] = d[k];
  }
  if (d.interrupted) out.interrupted = d.interrupted.type;
  return Object.keys(out).length ? out : null;
}

function safeJsonObject(s) {
  const m = String(s ?? '').match(/\{[\s\S]*\}/);
  try {
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}

function trimText(s, max) {
  if (!s) return null;
  const t = String(s).trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
