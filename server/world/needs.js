// Needs: hunger, fatigue and hp change over GAME time in code and pass through graded levels.
// Citizens only become aware of a need when it crosses a level (or as a reminder at bad levels):
// the update is pure math here; World turns the results into stimuli and state changes.
//
// step A2: an unaware body (sleeping / collapsed) keeps its levels up to date silently — no reminders,
// no '(still)' noise — except pain crossing to the critical level, which may still wake them. Fatigue at
// the top level starts a countdown (needs.collapsingSince) after which World forces sleep.
//
// All numbers live in content/needs.json, the wording in content/needs-text.json.
import { loadNeedsContent } from './scenarios.js';

export const NEED_KINDS = ['hunger', 'fatigue', 'hp'];

// step A2: activity types during which the body's own noise is switched off ('unconscious' is kept in
// case a later step introduces it).
export const UNAWARE = new Set(['sleeping', 'collapsed', 'unconscious']);
const COLLAPSE_DEADLINE_MINUTES = 30; // 'collapsing' and still awake this long → World forces sleep

export class Needs {
  constructor() {
    this.reload();
  }

  reload() {
    const { config, text } = loadNeedsContent();
    this.cfg = config ?? {};
    this.text = text ?? {};
    for (const k of NEED_KINDS) this.cfg[k] ??= { levels: [{ min: 0, minPct: 100, name: 'fine', importance: 0, remindEvery: null }] };
  }

  get lethal() {
    return Boolean(this.cfg.lethal);
  }

  levels(kind) {
    return this.cfg[kind]?.levels ?? [];
  }

  /** Current level index of a need (0 = fine). */
  levelIndex(kind, needs) {
    const levels = this.levels(kind);
    if (kind === 'hp') {
      const pct = ((needs.hp ?? 100) / Math.max(1, needs.hpMax ?? 100)) * 100;
      const i = levels.findIndex((l) => pct >= l.minPct);
      return i === -1 ? levels.length - 1 : i;
    }
    const v = needs[kind] ?? 0;
    let idx = 0;
    levels.forEach((l, i) => { if (v >= l.min) idx = i; });
    return idx;
  }

  levelName(kind, idx) {
    return this.levels(kind)[idx]?.name ?? '';
  }

  /** Index of the first level with this name (e.g. 'exhausted'), or Infinity. */
  levelOf(kind, name) {
    const i = this.levels(kind).findIndex((l) => l.name === name);
    return i === -1 ? Infinity : i;
  }

  /** Threshold where starvation damage starts: the last hunger level's min (default 95). */
  get starvingAt() {
    return this.levels('hunger').at(-1)?.min ?? 95;
  }

  rateKey(c) {
    const a = c.activity?.type;
    if (a === 'sleeping') return c.activity.detail?.quality === 'rough' ? 'asleepRough' : 'asleep';
    if (a === 'collapsed') return 'asleepRough';
    if (a === 'moving') return 'moving';
    return 'awake';
  }

  rate(kind, key) {
    const r = this.cfg[kind]?.ratePerHour ?? {};
    const chain = { asleepRough: ['asleepRough', 'asleep', 'awake'], asleep: ['asleep', 'awake'], moving: ['moving', 'awake'], awake: ['awake'] }[key];
    for (const k of chain) if (Number.isFinite(r[k])) return r[k];
    return 0;
  }

  /** step 7B: vitality (needs.hp mirrors it) is owned by world.body: regeneration, starvation and wounds live there. */
  hpRate(_c) {
    return 0;
  }

  /**
   * Advance one citizen by `elapsed` game minutes. Pure math on the needs object.
   * step A2: any sleep-like activity must REST. The asleepRough rate is negative by content, but if a
   * content edit ever makes it 0+, fall back to the plain asleep rate (still negative) so fatigue can
   * never flatline or rise while asleep — forced sleep has to recover.
   * @returns {{ forcedSleep: boolean, hpZero: boolean, rested: boolean }}
   */
  advance(c, elapsed) {
    const n = c.needs;
    const key = this.rateKey(c);
    let fRate = this.rate('fatigue', key);
    if ((key === 'asleep' || key === 'asleepRough') && fRate >= 0) fRate = Math.min(-0.5, this.rate('fatigue', 'asleep'));
    n.hunger = clamp(n.hunger + (this.rate('hunger', key) * elapsed) / 60, 0, 100);
    n.fatigue = clamp(n.fatigue + (fRate * elapsed) / 60, 0, 100);
    const a = c.activity?.type;
    return {
      forcedSleep: n.fatigue >= 100 && a !== 'sleeping' && a !== 'collapsed',
      hpZero: false, // death and collapse come from the body (blood, vitality, vital parts), see body/index.js
      rested: a === 'sleeping' && c.activity.detail?.untilRested && n.fatigue <= 5,
    };
  }

  /**
   * Level crossings and reminders. Mutates needs.levels / lastReminderAt (always — the levels stay
   * accurate for the prompt's HOW YOU FEEL block). Returns body stimuli to deliver (only levels with
   * importance > 0). Several levels crossed at once → only the highest one is announced.
   *
   * step A2: an unaware body (sleeping / collapsed / unconscious) announces nothing — reminders pile up
   * as '(still)' noise after waking. One exception: hp crossing to the critical level (importance 9)
   * is still delivered; it is the stand-in for Part B's critical alerts and may wake a sleeper.
   */
  checkLevels(c, now) {
    const n = c.needs;
    const unaware = UNAWARE.has(c.activity?.type);
    const out = [];
    // step 10 (0.3): sitting up with the dead costs something they should notice — tiredness speaks one level earlier
    const watchful = ['vigil', 'tend'].includes(c.activity?.detail?.kind);
    for (const kind of NEED_KINDS) {
      const idx = this.levelIndex(kind, n);
      const told = n.levels[kind] ?? 0;
      const own = this.levels(kind)[idx];
      const next = this.levels(kind)[idx + 1];
      const lvl = kind === 'fatigue' && watchful && idx >= 1 && next ? { ...own, importance: next.importance, remindEvery: next.remindEvery ?? own.remindEvery } : own;
      if (idx > told) {
        n.levels[kind] = idx;
        n.lastReminderAt[kind] = now;
        // step A2: asleep, only a critical hp crossing is worth waking for.
        if (lvl?.importance > 0 && (!unaware || (kind === 'hp' && lvl.importance >= 9))) out.push(this.#stimulus(kind, lvl, false));
      } else if (idx < told) {
        n.levels[kind] = idx; // getting better: no stimulus, the prompt's HOW YOU FEEL shows it
        n.lastReminderAt[kind] = now;
      } else if (idx > 0 && lvl?.remindEvery && now - (n.lastReminderAt[kind] ?? 0) >= lvl.remindEvery) {
        n.lastReminderAt[kind] = now;
        if (lvl.importance > 0 && !unaware) out.push(this.#stimulus(kind, lvl, true));
      }
    }
    return out;
  }

  /**
   * step A2: absolute game time at which World forces this citizen down. The deadline is whichever
   * comes first: 30 minutes after fatigue first reached the top level ('collapsing'), or the moment
   * fatigue itself reaches 100. Already asleep (or recovered below the top level) → null.
   */
  collapseAt(c, now) {
    if (c.needs?.collapsingSince == null) return null;
    const fatigueMin = this.topFatigueMin;
    if ((c.needs.fatigue ?? 0) < fatigueMin) return null; // got better: the deadline no longer applies
    if (UNAWARE.has(c.activity?.type)) return null;       // already down: nothing to force
    return Math.min((c.needs.collapsingSince ?? 0) + COLLAPSE_DEADLINE_MINUTES, this.fatigue100At(c, now));
  }

  /** Absolute game time when fatigue reaches 100 at the current rate (now if it is already there). */
  fatigue100At(c, now) {
    const fr = this.rate('fatigue', this.rateKey(c));
    if ((c.needs.fatigue ?? 0) >= 100) return now;
    return fr > 0 ? now + ((100 - c.needs.fatigue) / fr) * 60 : Infinity; // resting: never
  }

  /** The value at which the top fatigue level ('collapsing') starts. */
  get topFatigueMin() {
    return this.levels('fatigue').at(-1)?.min ?? 93;
  }

  #stimulus(kind, lvl, reminder) {
    const variants = this.text?.[kind]?.[lvl.name] ?? [];
    const text = variants.length ? variants[Math.floor(Math.random() * variants.length)] : `You feel ${lvl.name}.`;
    return {
      kind: 'body', text, importance: lvl.importance,
      // Body reminders never interrupt a think unless they are critical (>= 9).
      data: { need: kind, level: lvl.name, levelIndex: Math.max(0, this.levels(kind).findIndex((l) => l.name === lvl.name)), reminder, interrupt: lvl.importance >= 9 },
    };
  }

  /** Minutes until each need's next reminder (null if none is due at this level). */
  nextReminders(c, now) {
    const out = {};
    for (const kind of NEED_KINDS) {
      const idx = c.needs.levels[kind] ?? 0;
      const lvl = this.levels(kind)[idx];
      out[kind] = idx > 0 && lvl?.remindEvery ? Math.max(0, (c.needs.lastReminderAt[kind] ?? 0) + lvl.remindEvery - now) : null;
    }
    return out;
  }

  /**
   * Game minutes until the next thing that will happen to this citizen's body on its own:
   * a level crossing, a reminder, forced sleep, waking rested, hp reaching 0.
   * Used by the quiet-time fast-forward so a long tick never jumps past it.
   */
  horizon(c, now) {
    const n = c.needs;
    const key = this.rateKey(c);
    const cands = [];
    const toward = (value, rate, target) => {
      if (!rate) return;
      const t = ((target - value) / rate) * 60;
      if (t > 0) cands.push(t);
    };
    for (const kind of ['hunger', 'fatigue']) {
      const r = this.rate(kind, key);
      for (const l of this.levels(kind)) toward(n[kind], r, l.min); // crossings up (r > 0) and down (r < 0)
    }
    const fr = this.rate('fatigue', key);
    toward(n.fatigue, fr, 100); // forced sleep
    // step A2: the collapse deadline is also a scheduled event — a long tick must not jump past it.
    // collapseAt() already folds in fatigue reaching 100, whichever comes first.
    const dl = this.collapseAt(c, now);
    if (dl != null) cands.push(Math.max(0, dl - now));
    if (c.activity?.type === 'sleeping' && c.activity.detail?.untilRested) toward(n.fatigue, fr, 5); // waking rested
    toward(n.hunger, this.rate('hunger', key), this.starvingAt);
    const hr = this.hpRate(c);
    for (const l of this.levels('hp')) toward(n.hp, hr, ((l.minPct ?? 0) / 100) * (n.hpMax ?? 100));
    toward(n.hp, hr, 0);
    for (const m of Object.values(this.nextReminders(c, now))) if (m != null && m > 0) cands.push(m);
    return cands.length ? Math.min(...cands) : null;
  }

  /** Words for the HOW YOU FEEL block and the urgency line. */
  describe(c) {
    const n = c.needs;
    const idx = Object.fromEntries(NEED_KINDS.map((k) => [k, this.levelIndex(k, n)]));
    const hungerWords = [null, 'a little peckish', 'hungry', 'very hungry', 'ravenous', 'famished'];
    const fatigueWords = [null, 'a little sleepy', 'tired', 'exhausted', 'barely able to stay awake'];
    const hpWords = ['unhurt', 'a little hurt', 'weak and badly hurt', 'fading', "at death's door"];
    const word = (k) => ({ hunger: hungerWords, fatigue: fatigueWords, hp: hpWords })[k][idx[k]] ?? this.levelName(k, idx[k]);
    const feel = ['hunger', 'fatigue'].filter((k) => idx[k] > 0).map(word);
    const parts = [];
    if (feel.length) parts.push(`You're ${feel.join(' and ')}.`);
    parts.push(`You're ${word('hp')}.`);
    const severe = NEED_KINDS
      .filter((k) => idx[k] >= 3)
      .sort((a, b) => (this.levels(b)[idx[b]]?.importance ?? 0) - (this.levels(a)[idx[a]]?.importance ?? 0));
    const urgent = severe.length ? `Above all, you are ${word(severe[0])}.` : null;
    return { any: NEED_KINDS.some((k) => idx[k] > 0), text: parts.join(' '), urgent, idx };
  }
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
