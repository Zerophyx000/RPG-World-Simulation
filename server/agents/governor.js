// Token budget governor: keeps output tokens per rolling REAL hour under a budget by degrading,
// never by pausing the world.
//
//   green  (< 70%)   normal
//   yellow (70–100%) light → none; full capped at 1,200 tokens; no stale rethinks; deferrable work only on
//                    'local' (deferred if it's down); min gap between a citizen's thinks 1 → 3 game min
//   red    (> 100%)  yellow + full → light unless addressed speech / importance >= 9; gap 6; reading floor ×1.5
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

  evaluate(initial = false) {
    const r = this.ratio();
    const next = r > 1 ? 'red' : r >= 0.7 ? 'yellow' : 'green';
    if (next === this.state && !initial) return;
    const prev = this.state;
    this.state = next;
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

  /** Adjust a chosen tier under budget pressure. */
  adjust({ tier, maxTokens = null, addressed = false, maxImportance = 0 }) {
    const lvl = this.level();
    if (lvl === 0) return { tier, maxTokens };
    // Each rule applies to the ORIGINAL tier (no cascading full → light → none).
    if (tier === 'light') return { tier: 'none', maxTokens };
    if (tier === 'full') {
      if (lvl >= 2 && !addressed && maxImportance < 9) return { tier: 'light', maxTokens };
      return { tier: 'full', maxTokens: Math.min(maxTokens ?? 1200, 1200) }; // a cut-off call gets the cheap retry
    }
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
