// Scheduler: decides WHO thinks WHEN. Never decides WHAT they do; that is the model's job.
//
// Runs on every clock tick and shortly after every perception (poke). For an idle citizen, in order:
//   1. a habit is due, and the moment is calm (step 9.5, A3: habits.js calm()) → CODE carries out the habit (no LLM
//      call; at most two in a row, then the citizen decides)
//   2. otherwise → a decision
// There are no day plans any more (step 9.5): intentions are only ever carried out by the citizen's own decisions.
// Busy citizens: waiting/doing wake on importance >= 5; talking wakes when spoken to / their turn / urgent.
//
// Interrupts (aborting an in-flight think) are rare on purpose. The SOURCE of a stimulus marks it
// with data.interrupt only when it is worth it (addressed speech, own-room events >= 8, whispers >= 8,
// critical body states). At most 1 interrupt per citizen per 5 game minutes.
import { think } from './think.js';
import { maxImportance } from '../world/perception.js';

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

  /** What, if anything, this citizen should do now: 'habit' | 'decide' | null. */
  next(c) {
    const w = this.world;
    if (!this.#ready(c)) return null;
    const a = c.activity.type;
    if (a === 'idle') {
      if (w.now < c.thinkCooldownUntil) return null;
      if (w.habits && w.habits.autopilot(c)) return 'habit'; // habits.calm() weighs the inbox (routine stimuli don't count)
      return 'decide';
    }
    if (w.now < c.thinkCooldownUntil) return null;
    switch (a) {
      case 'waiting':
      case 'doing': {
        // step 9.5: what is done for the dead (a vigil, washing, laying out, digging) is only broken by something
        // urgent (>= 7) — a GLM run showed hunger reminders cutting every washing short
        const wakeAt = ['vigil', 'tend', 'bury'].includes(c.activity.detail?.kind) ? 7 : WAKE_IMPORTANCE;
        return c.inbox.some((s) => s.importance >= wakeAt) ? 'decide' : null;
      }
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
      if (n === 'habit') {
        const h = w.habits.autopilot(c);
        if (h && w.habits.run(c, h)) continue; // code carried out the habit: no LLM call
        due.push(c);                            // it couldn't: they decide
      } else if (n) due.push(c);
    }
    due.sort((a, b) => maxImportance(b.inbox) - maxImportance(a.inbox));
    for (const c of due) think(w, c, { mode: 'decide' }); // think() never rejects
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
