// Token budget governor: keeps output tokens per rolling REAL hour under a budget by degrading,
// never by pausing the world.
//
//   green            normal
//   yellow           light → none (unless protected); no stale rethinks; deferrable work only on 'local'
//                    (deferred if it's down); min gap between a citizen's thinks 1 → 3 game min
//   red              yellow + full → light unless protected; gap 6; reading floor ×1.5
//
// step 9.5: hysteresis so the state stops flapping — enter yellow at 75%, leave it below 65%; enter red at 100%,
// leave it below 85%; a state once entered holds for GOVERNOR_MIN_STATE_MINUTES real minutes (10), except a
// drop straight to green below 50%. Full decisions keep their token cap (a 1,200 cap cut off 40% of them).
// Protected decisions (death, grief, fear, critical bodies, addressed speech, importance >= 9: see tiers.js)
// are never downgraded.
import { config } from '../config.js';

const WINDOW_MS = 60 * 60 * 1000;
const STATES = ['green', 'yellow', 'red'];

export class Governor {
  constructor(world) {
    this.world = world;
    this.budget = config.governor.budgetPerHour;
    this.governed = new Set(config.governor.profiles);
    this.samples = new Map(); // profile -> [{ t, tokens }]
    this.state = 'green';
    this.enteredAt = 0; // real ms
    this.minStateMs = (Number(process.env.GOVERNOR_MIN_STATE_MINUTES ?? 10) || 0) * 60_000;
    this.#loadRecent();
    this.onLlm = (e) => {
      if (!e.outputTokens || !e.profile) return;
      this.#push(e.profile, Date.now(), e.outputTokens);
      this.evaluate();
    };
    world.bus.on('llm', this.onLlm);
    this.timer = setInterval(() => this.evaluate(), 30_000); // the window slides even when nothing happens
    this.timer.unref?.();
    this.evaluate(true);
  }

  stop() {
    clearInterval(this.timer);
    this.world.bus.off('llm', this.onLlm);
  }

  #loadRecent() {
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    try {
      for (const r of this.world.db.prepare(`SELECT real_time, profile, completion_tokens FROM llm_calls
        WHERE real_time >= ? AND completion_tokens IS NOT NULL`).all(since)) {
        this.#push(r.profile ?? 'school', Date.parse(r.real_time), r.completion_tokens);
      }
    } catch { /* fresh DB */ }
  }

  #push(profile, t, tokens) {
    if (!this.samples.has(profile)) this.samples.set(profile, []);
    this.samples.get(profile).push({ t, tokens });
  }

  usage(profile) {
    const cutoff = Date.now() - WINDOW_MS;
    const list = (this.samples.get(profile) ?? []).filter((s) => s.t >= cutoff);
    this.samples.set(profile, list);
    return list.reduce((a, s) => a + s.tokens, 0);
  }

  get enabled() {
    return this.budget > 0;
  }

  ratio() {
    if (!this.enabled) return 0;
    let worst = 0;
    for (const p of this.governed) worst = Math.max(worst, this.usage(p) / this.budget);
    return worst;
  }

  /** The state the ratio asks for, given the current one (hysteresis). */
  static target(cur, r) {
    if (r < 0.5) return 'green';
    if (cur === 'red') return r >= 0.85 ? 'red' : r >= 0.65 ? 'yellow' : 'green';
    if (cur === 'yellow') return r >= 1 ? 'red' : r >= 0.65 ? 'yellow' : 'green';
    return r >= 1 ? 'red' : r >= 0.75 ? 'yellow' : 'green';
  }

  evaluate(initial = false) {
    const r = this.ratio();
    const next = initial ? (r >= 1 ? 'red' : r >= 0.75 ? 'yellow' : 'green') : Governor.target(this.state, r);
    if (next === this.state && !initial) return;
    // hold a state for a while once entered (no flapping); falling below 50% goes straight to green
    const held = Date.now() - this.enteredAt < this.minStateMs;
    if (!initial && held && !(next === 'green' && r < 0.5)) return;
    const prev = this.state;
    this.state = next;
    this.enteredAt = Date.now();
    if (!initial || next !== 'green') {
      this.world.logEvent('system', { action: 'governor', from: prev, to: next, ratio: Math.round(r * 100) / 100, budget: this.budget });
    }
    this.world.bus.emit('governor', this.view());
  }

  setBudget(n) {
    this.budget = Math.max(0, Number(n) || 0);
    this.evaluate();
    return this.view();
  }

  view() {
    return {
      state: this.state,
      budgetPerHour: this.budget,
      enabled: this.enabled,
      ratio: Math.round(this.ratio() * 1000) / 1000,
      usage: Object.fromEntries([...this.samples.keys()].map((p) => [p, this.usage(p)])),
      governed: [...this.governed],
    };
  }

  level() {
    return STATES.indexOf(this.state);
  }

  /**
   * Adjust a chosen tier under budget pressure. protect: a decision about death, grief, fear, a critical body
   * or addressed speech (tiers.js) — never downgraded. Each rule applies to the ORIGINAL tier (no cascading).
   */
  adjust({ tier, maxTokens = null, addressed = false, maxImportance = 0, protect = false }) {
    const lvl = this.level();
    if (lvl === 0 || protect || addressed) return { tier, maxTokens };
    if (tier === 'light') return { tier: 'none', maxTokens };
    if (tier === 'full' && lvl >= 2 && maxImportance < 9) return { tier: 'light', maxTokens };
    return { tier, maxTokens };
  }

  thinkGapMinutes() {
    return [1, 3, 6][this.level()];
  }

  floorFactor() {
    return this.level() >= 2 ? 1.5 : 1;
  }

  staleRethinksAllowed() {
    return this.level() === 0;
  }

  /** Under pressure, deferrable background work may only use the local profile. */
  filterRoute(purpose, chain) {
    if (this.level() >= 1 && config.llm.deferrable.includes(purpose)) return chain.filter((n) => n === 'local');
    return chain;
  }
}
