// Scheduler: decides WHO thinks WHEN. Never decides WHAT they do; that is the model's job.
//
// Runs on every clock tick and shortly after every perception (poke). For an idle citizen, in order:
//   1. a plan is due (needsPlan) and nothing urgent (>= 7) is pending → planning think (purpose 'plan')
//   2. a day plan is running and nothing (>= 5) is pending → CODE runs the next plan step (no LLM call)
//   3. otherwise → a decision, as before
// Busy citizens: waiting/doing wake on importance >= 5; talking wakes when spoken to / their turn / urgent.
//
// Interrupts (aborting an in-flight think) are rare on purpose. The SOURCE of a stimulus marks it
// with data.interrupt only when it is worth it (addressed speech, own-room events >= 8, whispers >= 8,
// critical body states). At most 1 interrupt per citizen per 5 game minutes.
import { think } from './think.js';
import { maxImportance } from '../world/perception.js';
import { planActive, runPlan } from './plan.js';

export const WAKE_IMPORTANCE = 5;
export const INTERRUPT_EVERY_MINUTES = 5;

export class Scheduler {
  constructor(world) {
    this.world = world;
    this.poked = false;
  }

  #ready(c) {
    const w = this.world;
    if (c.kind !== 'citizen' || !c.alive) return false;
    if (c.activity.type === 'thinking' || c.activity.type === 'moving') return false;
    if (!c.location || !w.rooms.has(c.location)) return false;
    if (c.activity.detail?.held || w.conversations.hasHeldLine(c)) return false;
    return true;
  }

  /** What, if anything, this citizen should do now: 'plan' | 'step' | 'decide' | null. */
  next(c) {
    const w = this.world;
    if (!this.#ready(c)) return null;
    const a = c.activity.type;
    if (a === 'idle') {
      const pending = maxImportance(c.inbox);
      if (c.needsPlan && pending < 7 && !c.conversationId && w.now >= c.thinkCooldownUntil) return 'plan';
      if (planActive(c) && pending < WAKE_IMPORTANCE && !c.conversationId) return 'step';
      return w.now >= c.thinkCooldownUntil ? 'decide' : null;
    }
    if (w.now < c.thinkCooldownUntil) return null;
    switch (a) {
      case 'waiting':
      case 'doing': return c.inbox.some((s) => s.importance >= WAKE_IMPORTANCE) ? 'decide' : null;
      case 'talking': return c.inbox.some((s) => s.data?.wake || s.data?.interrupt) ? 'decide' : null;
      default: return null;
    }
  }

  isDue(c) {
    return this.next(c) === 'decide';
  }

  // Start every due think. Highest inbox importance first, so when the LLM
  // semaphore queues requests, the most urgent ones are at the front.
  run() {
    const w = this.world;
    if (!w.clock.running || w.stopped) return;
    const due = [];
    for (const c of w.citizens.values()) {
      const n = this.next(c);
      if (n === 'step') runPlan(w, c); // code carries out the plan: no LLM call
      else if (n) due.push([c, n]);
    }
    due.sort((a, b) => maxImportance(b[0].inbox) - maxImportance(a[0].inbox));
    for (const [c, n] of due) think(w, c, { mode: n === 'plan' ? 'plan' : 'decide' }); // think() never rejects
  }

  // Coalesce many perceptions in one synchronous burst into a single run.
  poke() {
    if (this.poked) return;
    this.poked = true;
    setImmediate(() => {
      this.poked = false;
      this.run();
    });
  }

  // Called by world.perceive for every delivered stimulus.
  onStimulus(c, s) {
    const w = this.world;
    if (c.activity.type === 'thinking' && s.data?.interrupt && w.clock.running) {
      const last = w.runtime(c.id).lastInterruptAt;
      if (w.now - last >= INTERRUPT_EVERY_MINUTES) w.interruptThink(c, s);
    }
    this.poke();
  }
}
