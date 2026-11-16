// Step 9.5 (B6.1): services need people. A room service may name an operator and a stock:
//
//   "services": { "food": { ..., "operator": "greta", "stock": { "current": 12, "max": 30, "perWorkHour": 4,
//                                                               "work": ["oven", "counter"], "words": "bak|knead|dough|bread" } } }
//
// Eating uses 1. Working at the service — a `do` (or a habit) targeting one of the `work` object types there, or whose
// words match — refills `perWorkHour` per hour worked, for ANYONE who does the work (who bakes now that Greta is dead
// becomes a story). Nobody working: the stock only goes down. At 0: "The shelves are empty."
// Current stock is runtime state in world_state 'stock' ({ roomId: { food: n } }); content gives the starting value.
import { getState, setState } from '../db.js';

export class Stock {
  constructor(world) {
    this.world = world;
    this.state = {};
  }

  load() {
    this.state = getState(this.world.db, 'stock', {}) ?? {};
  }

  #cfg(roomId, service) {
    return this.world.rooms.get(roomId)?.services?.[service]?.stock ?? null;
  }

  /** Current stock of a service, or null if the service has no stock. */
  level(roomId, service = 'food') {
    const cfg = this.#cfg(roomId, service);
    if (!cfg) return null;
    const cur = this.state[roomId]?.[service];
    return Number.isFinite(cur) ? cur : Number(cfg.current ?? cfg.max ?? 0);
  }

  #set(roomId, service, v) {
    const cfg = this.#cfg(roomId, service);
    const max = Number(cfg?.max ?? 30);
    this.state[roomId] = { ...(this.state[roomId] ?? {}), [service]: Math.max(0, Math.min(max, Math.round(v * 10) / 10)) };
    setState(this.world.db, 'stock', this.state);
    this.world.bus.emit('room', this.world.roomView(this.world.rooms.get(roomId)));
  }

  /** Words for the eat tool and the place line: '' / ' (the shelves are nearly empty)'. */
  note(roomId, service = 'food') {
    const n = this.level(roomId, service);
    if (n == null) return '';
    if (n < 1) return ' (the shelves are empty)';
    if (n < 4) return ' (the shelves are nearly empty)';
    return '';
  }

  /** Eating takes one; false when there is nothing left. */
  take(roomId, service = 'food') {
    const n = this.level(roomId, service);
    if (n == null) return true;
    if (n < 1) return false;
    this.#set(roomId, service, n - 1);
    return true;
  }

  /** A finished `do`: work at the service refills it (anyone may take over the work). */
  onWork(c, activity) {
    const roomId = c.location;
    const room = this.world.rooms.get(roomId);
    if (!room) return;
    const minutes = Math.max(0, (activity.until ?? this.world.now) - activity.since);
    for (const [service, def] of Object.entries(room.services ?? {})) {
      const cfg = def?.stock;
      if (!cfg) continue;
      const target = activity.detail?.targetId ? this.world.objects.get(activity.detail.targetId) : null;
      const byObject = target && target.roomId === roomId && (cfg.work ?? []).includes(target.typeId);
      const byWords = cfg.words && new RegExp(cfg.words, 'i').test(String(activity.detail?.description ?? ''));
      if (!byObject && !byWords) continue;
      const add = (Number(cfg.perWorkHour) || 4) * (minutes / 60);
      if (add <= 0) continue;
      const before = this.level(roomId, service);
      this.#set(roomId, service, before + add);
      this.world.logEvent('stock', { actorId: c.id, location: roomId, service, before, after: this.level(roomId, service), operator: def.operator ?? null, byOperator: def.operator === c.id });
    }
  }

  view() {
    const out = {};
    for (const room of this.world.rooms.values()) {
      for (const [service, def] of Object.entries(room.services ?? {})) {
        if (!def?.stock) continue;
        out[room.id] = { ...(out[room.id] ?? {}), [service]: { level: this.level(room.id, service), max: def.stock.max ?? null, operator: def.operator ?? null } };
      }
    }
    return out;
  }
}
