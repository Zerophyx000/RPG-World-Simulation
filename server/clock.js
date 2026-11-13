// Continuous game clock. Game time is measured in game minutes since world start.
// It only advances while running, so pausing or a server shutdown never loses time.
//
// Every time-dependent system (hunger, emotion decay, aging...) must use
// `elapsedGameMinutes` passed to the tick handlers, never real seconds,
// so changing the speed can't break anything.
import { getState, setState } from './db.js';

const MINUTES_PER_DAY = 24 * 60;
const LOOP_MS = 200;
const SAVE_EVERY_MS = 5000;

export class Clock {
  constructor(db, bus, { dayLengthRealMinutes }) {
    this.db = db;
    this.bus = bus;
    // Game minutes that pass per real second at 1x speed.
    this.baseRate = MINUTES_PER_DAY / (dayLengthRealMinutes * 60);

    const saved = getState(db, 'clock', { gameMinutes: 6 * 60, running: false, speed: 1 });
    this.gameMinutes = saved.gameMinutes; // new worlds start on day 1 at 06:00
    this.running = saved.running;
    this.speed = saved.speed;
    this.quietMultiplier = 1;  // automatic quiet-time speed-up (world/quiet.js), never persisted
    this.bodyMultiplier = 1;   // step 7B: CRITICAL_SLOWDOWN while a critical bleed has someone to act (never persisted)
    this.horizonFn = null;     // () => next scheduled game time; a tick never jumps past it

    this.handlers = [];
    this.lastReal = Date.now();
    this.lastSave = Date.now();
    this.timer = null;
  }

  // Register a function called every loop with (elapsedGameMinutes, nowGameMinutes).
  onTick(fn) {
    this.handlers.push(fn);
  }

  start() {
    this.lastReal = Date.now();
    this.timer = setInterval(() => this.#loop(), LOOP_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.save();
  }

  #loop() {
    const now = Date.now();
    const realSeconds = (now - this.lastReal) / 1000;
    this.lastReal = now;

    if (this.running) {
      let elapsed = realSeconds * this.baseRate * this.speed * this.quietMultiplier * this.bodyMultiplier;
      // Never jump past the next scheduled event (a timer, a need crossing): land just after it.
      const horizon = this.horizonFn?.();
      if (horizon != null && this.gameMinutes + elapsed > horizon) elapsed = Math.max(0, horizon - this.gameMinutes) + 1e-6;
      this.gameMinutes += elapsed;
      for (const fn of [...this.handlers]) { // a copy: a handler may unregister itself (test days)
        try {
          fn(elapsed, this.gameMinutes);
        } catch (err) {
          console.error('[clock] tick handler failed:', err);
        }
      }
    }

    if (now - this.lastSave >= SAVE_EVERY_MS) this.save();
  }

  save() {
    setState(this.db, 'clock', { gameMinutes: this.gameMinutes, running: this.running, speed: this.speed });
    this.lastSave = Date.now();
  }

  pause() {
    this.running = false;
    this.save();
    this.bus.emit('clock', this.snapshot());
  }

  resume() {
    this.lastReal = Date.now();
    this.running = true;
    this.save();
    this.bus.emit('clock', this.snapshot());
  }

  setSpeed(speed) {
    const s = Number(speed);
    if (!Number.isFinite(s) || s <= 0 || s > 1000) throw new Error('speed must be between 0 and 1000');
    this.speed = s;
    this.save();
    this.bus.emit('clock', this.snapshot());
  }

  setBodyMultiplier(m) {
    if (m === this.bodyMultiplier) return;
    this.bodyMultiplier = m;
    this.bus.emit('clock', this.snapshot());
  }

  setQuietMultiplier(m) {
    if (m === this.quietMultiplier) return;
    this.quietMultiplier = m;
    this.bus.emit('clock', this.snapshot());
  }

  snapshot() {
    const day = Math.floor(this.gameMinutes / MINUTES_PER_DAY) + 1;
    const minuteOfDay = this.gameMinutes % MINUTES_PER_DAY;
    const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
    const mm = String(Math.floor(minuteOfDay % 60)).padStart(2, '0');
    return {
      gameMinutes: this.gameMinutes,
      day,
      time: `${hh}:${mm}`,
      running: this.running,
      speed: this.speed,
      quietMultiplier: this.quietMultiplier,
      effectiveSpeed: this.speed * this.quietMultiplier * this.bodyMultiplier,
      realSecondsPerGameHour: 60 / (this.baseRate * this.speed * this.quietMultiplier),
    };
  }
}
