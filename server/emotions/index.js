// Emotions, mood and expression (step 6).
//
// Code tracks emotions as numbers and shapes how the world is PRESENTED to a citizen (perception, framing,
// memory, what others see). It never chooses an action, never skips an LLM call and never removes a tool.
//
// State (citizen data, no migration):
//   emotions: [{ id, type, target, about, intensity 0..10, cause, since, lastBumped, source, lastRuminated?, data? }]
//             one entry per (type, target, about); at most 12; entries under 0.5 are dropped
//   mood:     { valence -5..5, tension 0..10, history: [[t, valence, tension]], outSince, outDir }
//   masks:    [{ type | null, until }]                      (hide_feelings)
//
// Sources of bumps: appraisal (code rules, appraise.js), signal (envy / jealousy detection), self (the model's
// own `feeling` report), reflection / consolidation (the model, after talking / while asleep), contagion,
// rumination, director.
import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_DIR } from '../world/scenarios.js';
import { citizensIn } from '../world/rooms.js';
import { pronounsOf } from '../memory/words.js';
import { Appraisal } from './appraise.js';
import { runContagion } from './contagion.js';

export const MAX_ENTRIES = 12;
export const MIN_INTENSITY = 0.5;
const RUMINATE_EVERY = 30;       // game minutes per entry
const MASK_MINUTES = 45;
const SAMPLE_EVERY = 60;         // game minutes
const CONTAGION_EVERY = 10;
const HISTORY_KEEP = 96;         // hourly mood points kept on the citizen (4 game days)
const PRUNE_AFTER_DAYS = 30;
const NEGATIVE_TENSION = ['fear', 'anger', 'jealousy', 'envy'];

export class Emotions {
  constructor(world) {
    this.world = world;
    this.db = world.db;
    this.reload();
    this.contagionOn = (process.env.EMOTION_CONTAGION ?? 'true') !== 'false';
    this.paramEffects = process.env.EMOTION_PARAM_EFFECTS === 'true';
    this.seq = 0;
    this.lastSample = new Map();   // citizenId -> game time of the last hourly pass
    this.lastContagion = -Infinity;
    this.lastPrune = -Infinity;
    this.roomGlow = new Map();     // roomId -> { type, until } for the UI
    this.insertLog = this.db.prepare('INSERT INTO emotion_log (citizen_id, game_time, kind, data) VALUES (?, ?, ?, ?)');
    this.appraisal = new Appraisal(world, this);
  }

  reload() {
    const read = (f, fallback) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, f), 'utf8'));
      } catch (err) {
        console.warn(`[content] ${f} unreadable: ${err.message}`);
        return fallback;
      }
    };
    const e = read('emotions.json', { types: {}, bands: [3, 6, 8, 10], mood: {}, tools: {} });
    this.types = e.types ?? {};
    this.bands = e.bands ?? [3, 6, 8, 10];
    this.moodText = e.mood ?? {};
    this.toolFraming = e.tools ?? {};
    this.rules = read('appraisals.json', { rules: {}, personality: {}, relationship: {}, envy: {}, jealousy: {}, lasting: {}, irritability: {} });
  }

  typeNames() {
    return Object.keys(this.types);
  }

  band(intensity) {
    const i = this.bands.findIndex((max) => intensity <= max);
    return i < 0 ? this.bands.length - 1 : i;
  }

  valenceOf(type) {
    return this.types[type]?.valence ?? 0;
  }

  // ---------- reading ----------
  of(c) {
    return c.emotions ?? [];
  }

  get(c, type, target = null, about = null) {
    return this.of(c).find((e) => e.type === type && (e.target ?? null) === (target ?? null) && (e.about ?? null) === (about ?? null)) ?? null;
  }

  top(c, n = 3, min = 1) {
    return this.of(c).filter((e) => e.intensity >= min).sort((a, b) => b.intensity - a.intensity).slice(0, n);
  }

  /** Strongest entry of a type (optionally aimed at someone). */
  strongest(c, type, target = undefined) {
    let best = null;
    for (const e of this.of(c)) {
      if (e.type !== type || (target !== undefined && (e.target ?? null) !== target)) continue;
      if (!best || e.intensity > best.intensity) best = e;
    }
    return best;
  }

  max(c, type) {
    return this.strongest(c, type)?.intensity ?? 0;
  }

  /** Strongest emotion involving any of these people (for memory encoding and tiers). */
  strongestAbout(c, ids) {
    const set = new Set(ids);
    let best = null;
    for (const e of this.of(c)) if ((set.has(e.target) || set.has(e.about)) && (!best || e.intensity > best.intensity)) best = e;
    return best;
  }

  dominant(c) {
    return this.top(c, 1, 1)[0] ?? null;
  }

  // ---------- the bump ----------
  /**
   * Change one emotion. delta > 0 raises with diminishing returns (i + d × (1 − i/12)); delta < 0 lowers.
   * raw: skip personality / relationship modulation (self-reports, contagion, the director).
   * Returns { entry, before, after, applied } or null.
   */
  bump(c, { type, target = null, about = null, delta, cause = null, source = 'appraisal', raw = false, rule = null, data = null, cap = null }) {
    const def = this.types[type];
    if (!def || !c || !c.alive || !Number.isFinite(Number(delta)) || Number(delta) === 0) return null;
    if (def.aimed === 'none') target = null;
    if (target === c.id) target = null;
    if (target && !this.world.citizens.has(target)) target = null;
    if (def.aimed === 'required' && !target) return null;
    let d = Number(delta);
    if (!raw && d > 0) d *= this.#modulation(c, type, target);
    c.emotions ??= [];
    let e = this.get(c, type, target, about);
    const before = e?.intensity ?? 0;
    let after = d > 0 ? before + d * (1 - before / 12) : before + d;
    if (cap != null && d > 0) after = Math.min(after, Math.max(before, cap));
    after = Math.min(10, Math.max(0, after));
    const applied = after - before;
    if (Math.abs(applied) < 0.01) return null;
    const now = this.world.now;
    const text = cause ? String(cause).trim().slice(0, 200) : null;
    if (!e) {
      if (after < MIN_INTENSITY) return null;
      e = { id: `e${Date.now().toString(36)}${(this.seq++).toString(36)}`, type, target, about, intensity: after, cause: text, causeWeight: Math.abs(d), since: now, lastBumped: now, source };
      c.emotions.push(e);
    } else {
      e.intensity = after;
      e.lastBumped = now;
      // the stronger cause is the one they'd name
      if (text && d > 0 && (Math.abs(d) >= (e.causeWeight ?? 0) * 0.8 || !e.cause)) {
        e.cause = text;
        e.causeWeight = Math.abs(d);
        e.source = source;
      }
    }
    if (data) e.data = { ...(e.data ?? {}), ...data };
    this.#trim(c);
    if (Math.abs(applied) >= 1) {
      this.insertLog.run(c.id, now, 'bump', JSON.stringify({ type, target, about, delta: round(applied), intensity: round(after), source, rule, cause: text }));
    }
    this.world.saveCitizen(c);
    this.world.bus.emit('emotion', { citizenId: c.id });
    return { entry: e, before, after, applied };
  }

  // personality (all rules), relationship (anger at someone you like is dampened) and irritability (needs)
  #modulation(c, type, target) {
    const t = c.persona?.traits ?? {};
    const P = this.rules.personality ?? {};
    const lin = (spec) => (spec ? spec.base + Object.entries(spec).filter(([k]) => k !== 'base').reduce((s, [k, w]) => s + w * (t[k] ?? 0.5), 0) : 1);
    let f = 1;
    if (this.valenceOf(type) < 0) f *= lin(P.negative);
    if (P[type]) f *= lin(P[type]);
    if (type === 'anger') {
      if (target) {
        const a = this.world.memory.rel(c.id, target)?.affinity ?? 0;
        f *= Math.max(0.3, 1 - (this.rules.relationship?.angerPerAffinity ?? 0.08) * a);
      }
      const irr = this.rules.irritability ?? {};
      if (this.#needSevere(c, irr.needLevel ?? 3)) f *= irr.angerFactor ?? 1.5;
    }
    return f;
  }

  #needSevere(c, level) {
    const N = this.world.needs;
    return ['hunger', 'fatigue'].some((k) => N.levelIndex(k, c.needs) >= level);
  }

  #trim(c) {
    c.emotions = c.emotions.filter((e) => e.intensity >= MIN_INTENSITY);
    if (c.emotions.length > MAX_ENTRIES) {
      c.emotions.sort((a, b) => b.intensity - a.intensity);
      c.emotions.length = MAX_ENTRIES;
    }
  }

  /** Seeing or recalling the target of an aimed negative feeling stirs it up again (at most once per 30 min per entry). */
  ruminate(c, otherId, how = 'encounter') {
    let changed = false;
    for (const e of this.of(c)) {
      if (e.target !== otherId || this.valenceOf(e.type) >= 0 || e.intensity < 3) continue;
      if (this.world.now - (e.lastRuminated ?? -Infinity) < RUMINATE_EVERY) continue;
      e.lastRuminated = this.world.now;
      e.intensity = Math.min(10, e.intensity + 0.5 * (1 - e.intensity / 12));
      e.lastBumped = this.world.now;
      changed = true;
      this.insertLog.run(c.id, this.world.now, 'bump', JSON.stringify({ type: e.type, target: e.target, about: e.about, delta: 0.5, intensity: round(e.intensity), source: 'rumination', rule: how, cause: e.cause }));
    }
    if (changed) this.world.saveCitizen(c);
    return changed;
  }

  // ---------- tick ----------
  tick(elapsed, now) {
    for (const c of this.world.citizens.values()) {
      if (!c.alive) continue;
      if ((c.emotions ?? []).length) this.#decay(c, elapsed);
      if ((c.masks ?? []).some((m) => m.until <= now)) {
        c.masks = c.masks.filter((m) => m.until > now);
        this.world.saveCitizen(c);
      }
      const last = this.lastSample.get(c.id);
      if (last == null) this.lastSample.set(c.id, now - Math.random() * 10); // spread the hourly work
      else if (now - last >= SAMPLE_EVERY) {
        this.lastSample.set(c.id, now);
        this.#hourly(c, (now - last) / 60);
      }
    }
    if (now - this.lastContagion >= CONTAGION_EVERY) {
      const minutes = Math.min(60, now - this.lastContagion);
      this.lastContagion = now;
      if (this.contagionOn) runContagion(this.world, this);
      this.appraisal.periodic(Number.isFinite(minutes) ? minutes : CONTAGION_EVERY);
    }
    if (now - this.lastPrune >= 1440) {
      this.lastPrune = now;
      this.#prune(now);
    }
  }

  #decay(c, elapsed) {
    const t = c.persona?.traits ?? {};
    const m = Math.max(-1, Math.min(1, -(c.mood?.valence ?? 0) / 5)); // > 0 in a low mood
    let dropped = false;
    for (const e of c.emotions) {
      const def = this.types[e.type];
      if (!def) continue;
      const negative = def.valence < 0;
      const personality = negative ? 0.6 + 0.8 * (t.neuroticism ?? 0.5) : 0.7 + 0.6 * (t.extraversion ?? 0.5);
      // low mood: bad feelings linger (up to 1.5×), good ones fade faster (up to 1.5×); the reverse when high
      const stretch = 1 + 0.5 * Math.abs(m);
      const mood = (negative ? m > 0 : m < 0) ? stretch : 1 / stretch;
      const halfLife = def.halfLifeHours * 60 * personality * (m === 0 ? 1 : mood);
      e.intensity *= 0.5 ** (elapsed / halfLife);
      if (e.intensity < MIN_INTENSITY) dropped = true;
    }
    if (dropped) {
      for (const e of c.emotions.filter((x) => x.intensity < MIN_INTENSITY)) {
        this.insertLog.run(c.id, this.world.now, 'decay_out', JSON.stringify({ type: e.type, target: e.target, about: e.about }));
      }
      c.emotions = c.emotions.filter((e) => e.intensity >= MIN_INTENSITY);
      this.world.saveCitizen(c);
      this.world.bus.emit('emotion', { citizenId: c.id });
    }
    this.world.dirty.add(c.id);
  }

  // ---------- mood ----------
  baseline(c) {
    const t = c.persona?.traits ?? {};
    return {
      valence: 1.5 * ((t.extraversion ?? 0.5) - 0.5) - 2 * ((t.neuroticism ?? 0.5) - 0.5),
      tension: 3 + 4 * ((t.neuroticism ?? 0.5) - 0.5),
    };
  }

  mood(c) {
    if (!c.mood || !Number.isFinite(c.mood.valence)) c.mood = { ...this.baseline(c), history: [], outSince: null, outDir: 0 };
    return c.mood;
  }

  /** Every game hour: mood drifts 10% towards the current emotional balance; a sample is logged. */
  #hourly(c, hours) {
    const mood = this.mood(c);
    const base = this.baseline(c);
    let pos = 0;
    let neg = 0;
    let tense = 0;
    for (const e of this.of(c)) {
      if (this.valenceOf(e.type) > 0) pos += e.intensity;
      else neg += e.intensity;
      if (NEGATIVE_TENSION.includes(e.type)) tense = Math.max(tense, e.intensity);
    }
    const targetV = clamp(base.valence + (pos - neg) * 0.25, -5, 5); // a summed intensity of 20 is the full ±5
    const targetT = tense > 0 ? Math.max(tense, base.tension) : base.tension;
    const k = 1 - 0.9 ** Math.max(0.1, hours);
    mood.valence = clamp(mood.valence + (targetV - mood.valence) * k, -5, 5);
    mood.tension = clamp(mood.tension + (targetT - mood.tension) * k, 0, 10);
    this.#trackRange(c, mood, base);
    mood.history = [...(mood.history ?? []), [Math.round(this.world.now), round(mood.valence), round(mood.tension)]].slice(-HISTORY_KEEP);
    // Irritability: a body in a bad way wears on the spirits.
    if (this.#needSevere(c, this.rules.irritability?.needLevel ?? 3)) this.appraisal.fire(c, 'need_severe_hourly', {});
    this.insertLog.run(c.id, this.world.now, 'sample', JSON.stringify({
      entries: this.of(c).map((e) => ({ type: e.type, target: e.target, about: e.about, intensity: round(e.intensity) })),
      mood: { valence: round(mood.valence), tension: round(mood.tension) },
    }));
    this.world.saveCitizen(c);
  }

  #trackRange(c, mood, base) {
    const dir = mood.valence < base.valence - 1 ? -1 : mood.valence > base.valence + 1 ? 1 : 0;
    if (dir !== (mood.outDir ?? 0)) {
      mood.outDir = dir;
      mood.outSince = dir ? this.world.now : null;
    }
  }

  /** At consolidation: the model's own mood_shift, then a 15% pull towards the personality baseline per day. */
  nightly(c, moodShift = 0, days = 1) {
    const mood = this.mood(c);
    const base = this.baseline(c);
    const shift = clamp(Number(moodShift) || 0, -2, 2);
    mood.valence = clamp(mood.valence + shift, -5, 5);
    const k = 1 - 0.85 ** Math.max(0.25, Math.min(7, days));
    mood.valence += (base.valence - mood.valence) * k;
    mood.tension += (base.tension - mood.tension) * k;
    this.#trackRange(c, mood, base);
    this.insertLog.run(c.id, this.world.now, 'mood', JSON.stringify({ valence: round(mood.valence), tension: round(mood.tension), shift, night: true }));
    this.world.saveCitizen(c);
    return mood;
  }

  /** { dir: -1|0|1, far: bool, lastingDays } relative to the personality baseline. */
  moodState(c) {
    const mood = this.mood(c);
    const base = this.baseline(c);
    const diff = mood.valence - base.valence;
    const dir = diff < -1 ? -1 : diff > 1 ? 1 : 0;
    return {
      dir, diff, far: Math.abs(diff) >= 1.5, valence: mood.valence, tension: mood.tension,
      lastingDays: dir && mood.outSince != null ? (this.world.now - mood.outSince) / 1440 : 0,
      tense: mood.tension >= base.tension + 2.5,
    };
  }

  // ---------- expression, masking ----------
  composure(c) {
    const t = c.persona?.traits ?? {};
    return clamp(0.5 + 0.3 * ((t.conscientiousness ?? 0.5) - 0.5) - 0.4 * ((t.neuroticism ?? 0.5) - 0.5) + 0.2 * (0.5 - (t.extraversion ?? 0.5)), 0.1, 0.9);
  }

  isMasked(c, type) {
    return (c.masks ?? []).some((m) => m.until > this.world.now && (m.type == null || m.type === type));
  }

  /** How much of a feeling shows on the outside. At intensity >= 8 at least 40% always shows. */
  expressed(c, e) {
    const comp = this.composure(c);
    let x = Math.max(0, e.intensity - comp * 4);
    if (this.isMasked(c, e.type)) x = Math.max(0, x - comp * 4);
    if (e.intensity >= 8) x = Math.max(x, e.intensity * 0.4);
    return x;
  }

  expressedOf(c, type) {
    let best = 0;
    for (const e of this.of(c)) if (e.type === type) best = Math.max(best, this.expressed(c, e));
    return best;
  }

  /** hide_feelings: for 45 game minutes that feeling (or all) shows less. The feeling itself is unchanged. */
  hide(c, type = null) {
    c.masks = [...(c.masks ?? []).filter((m) => m.until > this.world.now && m.type !== type), { type: type ?? null, until: this.world.now + MASK_MINUTES }];
    this.world.saveCitizen(c);
    this.world.bus.emit('emotion', { citizenId: c.id });
  }

  /**
   * What `viewer` can read off `other`'s face: up to two cue sentences. Close observers (familiarity >= 6)
   * notice more, and notice when something is being held back.
   */
  cuesFor(viewer, other) {
    const fam = this.world.memory.rel(viewer.id, other.id)?.familiarity ?? 0;
    const close = fam >= 6;
    const name = this.world.memory.nameFor(viewer, other.id, { start: true });
    const lower = this.world.memory.nameFor(viewer, other.id);
    const p = pronounsOf(other);
    const shown = [];
    let hiding = false;
    for (const e of this.of(other).slice().sort((a, b) => b.intensity - a.intensity)) {
      const x = this.expressed(other, e);
      if (x >= 3) shown.push({ e, x, text: this.#cue(viewer, other, e, x, name, p) });
      else if (close && x >= 1.5) {
        const word = this.valenceOf(e.type) < 0 ? (e.type === 'fear' ? 'frightened' : e.type === 'anger' ? 'angry' : 'upset') : 'pleased about something';
        shown.push({ e, x, text: `You can tell ${lower} is ${word}, even if ${p.subj} hide${p.subj === 'they' ? '' : 's'} it well` });
      } else if (close && e.intensity >= 5 && this.isMasked(other, e.type)) hiding = true;
    }
    const out = shown.slice(0, 2).map((s) => `${s.text}.`);
    if (!out.length && hiding) out.push(`${name} seems to be hiding something.`);
    return out;
  }

  #cue(viewer, other, e, x, name, p) {
    const def = this.types[e.type];
    const tpl = def.cue[this.band(x)] ?? def.cue.at(-1);
    const targetHere = e.target && this.world.citizens.get(e.target)?.location === other.location;
    const tName = !e.target ? '' : e.target === viewer.id ? 'you' : this.world.memory.nameFor(viewer, e.target);
    const at = targetHere && def.cueAt ? def.cueAt.replace('{target}', tName) : '';
    const glance = targetHere ? `at ${tName}` : 'at the door';
    return tpl.replace('{Name}', name).replace('{atPlain}', at ? at.replace(/^ at /, ' ') : ' it').replace('{at}', at).replace('{glance}', glance)
      .replace(/\{subj\}/g, p.subj).replace(/\{obj\}/g, p.obj).replace(/\{poss\}/g, p.poss);
  }

  // passthroughs used by other modules (signals, object actions, groups)
  onSignal(observer, other, sign, evidence) {
    this.appraisal.onSignal(observer, other, sign, evidence);
  }

  onOwnActSeen(actor, obj, witnessIds, action) {
    this.appraisal.onOwnActSeen(actor, obj, witnessIds, action);
  }

  /** The cues anyone in the room would see (for the inspector's "what they show"). */
  shows(c) {
    const out = [];
    for (const e of this.of(c)) {
      const x = this.expressed(c, e);
      out.push({ type: e.type, target: e.target, intensity: round(e.intensity), expressed: round(x), masked: this.isMasked(c, e.type), visible: x >= 3, band: this.band(Math.max(x, 0.1)) });
    }
    return out;
  }

  // ---------- views / director ----------
  view(c) {
    const name = (id) => this.world.citizens.get(id)?.name ?? id;
    return {
      citizenId: c.id,
      entries: this.of(c).slice().sort((a, b) => b.intensity - a.intensity).map((e) => ({
        ...e, intensity: round(e.intensity), targetName: e.target ? name(e.target) : null, aboutName: e.about ? (this.world.citizens.has(e.about) ? name(e.about) : this.world.objects.get(e.about) ? this.world.objects.label(this.world.objects.get(e.about)) : e.about) : null,
        cause: detok(this.world, e.cause), valence: this.valenceOf(e.type), color: this.types[e.type]?.color ?? '#888', band: this.band(e.intensity),
        expressed: round(this.expressed(c, e)), masked: this.isMasked(c, e.type),
      })),
      mood: { ...this.mood(c), baseline: this.baseline(c), state: this.moodState(c) },
      composure: round(this.composure(c)),
      masks: (c.masks ?? []).filter((m) => m.until > this.world.now),
      shows: [...this.world.citizens.values()].filter((o) => o.id !== c.id && o.alive && o.location && o.location === c.location).slice(0, 1)
        .flatMap((o) => this.cuesFor(o, c).map((t) => detok(this.world, t))),
      showsAnyone: this.shows(c),
    };
  }

  /** Compact summary for the roster / world view. */
  summary(c) {
    const d = this.dominant(c);
    return {
      dominant: d ? { type: d.type, intensity: round(d.intensity), target: d.target, color: this.types[d.type]?.color } : null,
      envy: round(this.max(c, 'envy')), jealousy: round(this.max(c, 'jealousy')),
      mood: c.mood ? { valence: round(c.mood.valence), tension: round(c.mood.tension) } : null,
    };
  }

  history(citizenId, { from = null, to = null, limit = 2000 } = {}) {
    return this.db.prepare(`SELECT id, game_time, kind, data FROM emotion_log WHERE citizen_id = ? AND game_time >= ? AND game_time <= ? ORDER BY game_time DESC, id DESC LIMIT ?`)
      .all(citizenId, from ?? -1e12, to ?? 1e12, Math.min(5000, Number(limit) || 2000))
      .map((r) => ({ id: r.id, gameTime: r.game_time, kind: r.kind, ...safeJson(r.data) })).reverse();
  }

  /** For the timeline: each citizen's dominant emotion per hourly sample, and bumps of 3 or more with their cause. */
  timeline(from, to) {
    const lo = from ?? this.world.now - 720;
    const hi = to ?? this.world.now;
    const samples = {};
    for (const r of this.db.prepare("SELECT citizen_id, game_time, data FROM emotion_log WHERE kind = 'sample' AND game_time >= ? AND game_time <= ? ORDER BY game_time").all(lo - 60, hi)) {
      const top = (safeJson(r.data).entries ?? []).sort((a, b) => b.intensity - a.intensity)[0];
      (samples[r.citizen_id] ??= []).push([Math.round(r.game_time), top?.type ?? null, top?.intensity ?? 0]);
    }
    const bumps = this.db.prepare("SELECT citizen_id, game_time, data FROM emotion_log WHERE kind = 'bump' AND game_time >= ? AND game_time <= ? ORDER BY game_time").all(lo, hi)
      .map((r) => ({ citizenId: r.citizen_id, t: r.game_time, ...safeJson(r.data) })).filter((b) => Math.abs(b.delta) >= 3)
      .map((b) => ({ citizenId: b.citizenId, t: b.t, type: b.type, delta: b.delta, target: b.target, cause: detok(this.world, b.cause), source: b.source }));
    return { samples, bumps };
  }

  /** Recent rule firings across the village (the director's appraisal log). */
  appraisalLog(limit = 60) {
    return this.db.prepare(`SELECT id, citizen_id, game_time, data FROM emotion_log WHERE kind = 'bump' ORDER BY id DESC LIMIT ?`).all(Math.min(300, Number(limit) || 60))
      .map((r) => ({ id: r.id, citizenId: r.citizen_id, gameTime: r.game_time, ...safeJson(r.data) })).map((r) => ({ ...r, cause: detok(this.world, r.cause) }));
  }

  directorEmotion({ citizenId, type, target = null, about = null, delta, cause = null }) {
    const c = this.world.citizens.get(citizenId);
    if (!c) throw httpError(404, `unknown citizen "${citizenId}"`);
    if (!this.types[type]) throw httpError(400, `type must be one of ${this.typeNames().join(', ')}`);
    if (this.types[type].aimed === 'required' && !this.world.citizens.has(target)) throw httpError(400, `${type} needs a target`);
    const r = this.bump(c, { type, target: target || null, about: about || null, delta: Number(delta), cause: cause || 'It came over me suddenly.', source: 'director', raw: true });
    this.world.logEvent('director', { action: 'emotion', citizenId, type, target, delta: Number(delta) });
    return { ...this.view(c), changed: r ? { before: round(r.before), after: round(r.after) } : null };
  }

  directorMood({ citizenId, valence, tension }) {
    const c = this.world.citizens.get(citizenId);
    if (!c) throw httpError(404, `unknown citizen "${citizenId}"`);
    const mood = this.mood(c);
    if (valence != null && valence !== '') mood.valence = clamp(Number(valence), -5, 5);
    if (tension != null && tension !== '') mood.tension = clamp(Number(tension), 0, 10);
    this.#trackRange(c, mood, this.baseline(c));
    this.insertLog.run(c.id, this.world.now, 'mood', JSON.stringify({ valence: round(mood.valence), tension: round(mood.tension), director: true }));
    this.world.saveCitizen(c);
    this.world.bus.emit('emotion', { citizenId: c.id });
    return this.view(c);
  }

  setContagion(on) {
    this.contagionOn = Boolean(on);
    return { contagion: this.contagionOn };
  }

  /** Share of the last game day's samples in which an emotion of this type towards `target` was >= min. */
  shareOfDay(citizenId, type, target, min) {
    const rows = this.db.prepare(`SELECT data FROM emotion_log WHERE citizen_id = ? AND kind = 'sample' AND game_time >= ?`).all(citizenId, this.world.now - 1440);
    if (rows.length < 6) return 0;
    const hits = rows.filter((r) => (safeJson(r.data).entries ?? []).some((e) => e.type === type && e.target === target && e.intensity >= min)).length;
    return hits / rows.length;
  }

  glow(roomId, type) {
    this.roomGlow.set(roomId, { type, until: Date.now() + 8000 });
    this.world.bus.emit('emotion_room', { roomId, type, color: this.types[type]?.color ?? '#e08a3c' });
  }

  // Samples older than 30 game days are thinned to one per game day.
  #prune(now) {
    const cutoff = now - PRUNE_AFTER_DAYS * 1440;
    this.db.prepare(`DELETE FROM emotion_log WHERE kind = 'sample' AND game_time < ? AND id NOT IN (
      SELECT MIN(id) FROM emotion_log WHERE kind = 'sample' AND game_time < ? GROUP BY citizen_id, CAST(game_time / 1440 AS INTEGER))`).run(cutoff, cutoff);
    this.db.prepare("DELETE FROM emotion_log WHERE kind IN ('bump', 'decay_out') AND game_time < ?").run(cutoff - 30 * 1440);
  }

  awakeIn(roomId) {
    return citizensIn(this.world.citizens, roomId).filter((c) => c.activity.type !== 'sleeping' && c.activity.type !== 'collapsed');
  }
}

export function detok(world, text) {
  return text == null ? text : String(text).replace(/\{\{c:([\w-]+)\}\}/g, (_m, id) => world.citizens.get(id)?.name ?? id);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v) => Math.round(v * 100) / 100;

function safeJson(s) {
  try {
    return JSON.parse(s) ?? {};
  } catch {
    return {};
  }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
