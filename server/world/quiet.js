// Quiet-time speed-up: when nothing is happening that anyone would watch, the clock gets an
// automatic multiplier on top of the user-set speed (1 → 2 → 4 → 8 → max, one step every 2 real s).
//
// Quiet = no citizen thinking or talking, no in-flight citizen LLM call, no inbox stimulus >= 5
// waiting, no held conversation line, and every LLM citizen is sleeping/doing/waiting/moving/collapsed.
// It snaps back to 1× instantly when a think starts or any stimulus >= 5 is created (perceive, scheduler).
//
// While sped up, the clock never jumps past the next scheduled event (nextEventAt), so timers fire exactly.
import { config } from '../config.js';
import { activeEffects } from './rooms.js';

const STEP_MS = 2000;
const QUIET_ACTIVITIES = new Set(['sleeping', 'doing', 'waiting', 'moving', 'collapsed']);

export class Quiet {
  constructor(world) {
    this.world = world;
    this.enabled = config.quiet.enabled;
    this.max = Math.max(1, config.quiet.maxSpeed);
    this.lastStep = Date.now();
  }

  get multiplier() {
    return this.world.clock.quietMultiplier;
  }

  isQuiet() {
    const w = this.world;
    if (w.llm.activeFor('decide') > 0) return false;
    if (w.body?.anyBleedingOver(5)) return false; // step 7B: nobody fast-forwards past a bleed
    let anyCitizen = false;
    for (const c of w.citizens.values()) {
      if (!c.alive || c.kind !== 'citizen') continue;
      anyCitizen = true;
      if (!QUIET_ACTIVITIES.has(c.activity.type)) return false;
      if (c.inbox.some((s) => s.importance >= 5) && c.activity.type !== 'sleeping' && c.activity.type !== 'collapsed') return false;
    }
    for (const conv of w.conversations.list()) if (conv.held.length) return false;
    return anyCitizen;
  }

  /** Called every clock tick (real-time paced). Ramps up while quiet, drops to 1× otherwise. */
  update() {
    if (!this.enabled) return;
    if (!this.isQuiet()) return this.snap();
    const now = Date.now();
    if (now - this.lastStep >= STEP_MS && this.multiplier < this.max) {
      this.world.clock.setQuietMultiplier(Math.min(this.max, this.multiplier * 2));
      this.lastStep = now;
    }
  }

  snap() {
    this.lastStep = Date.now();
    if (this.multiplier !== 1) this.world.clock.setQuietMultiplier(1);
  }

  /** The earliest future game time at which something scheduled happens. */
  nextEventAt() {
    const w = this.world;
    const now = w.now;
    let best = Infinity;
    const consider = (t) => {
      if (t != null && Number.isFinite(t) && t > now + 1e-6 && t < best) best = t;
    };
    for (const c of w.citizens.values()) {
      if (!c.alive) continue;
      consider(c.activity.until);
      const h = w.needs.horizon(c, now);
      if (h != null) consider(now + h);
      for (const m of c.marks ?? []) consider(m.until);
    }
    for (const c of w.citizens.values()) if (c.alive && c.body?.critical) consider(c.body.critical.until);
    for (const conv of w.conversations.list()) consider(conv.lastLineAt + 30);
    for (const r of w.rooms.values()) {
      for (const e of activeEffects(r, now)) consider(e.until);
      for (const o of Object.values(r.serviceOverrides ?? {})) consider(o?.until);
      for (const b of r.blockedExits ?? []) consider(b.until);
    }
    return best === Infinity ? null : best;
  }
}
