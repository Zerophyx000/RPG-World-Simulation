// Step 10 §4.4: fire (basic). Burning is per object (o.data.burning = { since, until, by }), so no type needs extra
// states; when it is over the object is burnt (durability 0, "the charred remains of…"), or 'broken' if the type has it.
//
//   ignition   ignite (a held flame to something flammable), a knocked-over lit lantern or candle, a director event
//   spread     every game minute: same spot 12%, a near spot 3% (a GLM run: faster spread killed before anyone could decide); a TIMBER room (room.construction) with 3+ burning
//              objects is on fire as a whole (a room effect), then catches its flammables and, slowly, connected timber rooms
//   people     smoke builds per room (c.phys.smoke; it lowers breathing and consciousness like choking — senseless after
//              about 10 minutes of heavy smoke, dead at 6); standing at a burning spot burns
//   putting out  pour water (a bucket per burning object; a room fire needs several), smother a small fire, burn out
//   after      soot and scorch decals, a smoke-blackened room, village dread
import { citizensIn } from '../world/rooms.js';
import { ref } from '../memory/index.js';
import { phys, isFlame } from './props.js';

const ROOM_FIRE_AT = 3;
const ROOM_FIRE_WATER = 6;
const SMOKE_DEATH = 6;
const NOTICE_EVERY = 5;
const burnMinutes = (world, o) => ({ 1: 12, 2: 35 }[world.objects.type(o)?.size ?? 1] ?? 20);

export class Fire {
  constructor(world) {
    this.world = world;
    this.lastTick = null;
  }

  rng() { return (this.world.physical?.rng ?? Math.random)(); }

  burning(roomId = null) {
    const out = [];
    for (const o of this.world.objects.byId.values()) if (o.data?.burning && (!roomId || o.roomId === roomId)) out.push(o);
    return out;
  }

  /** Something catches fire. → true if it does. */
  ignite(o, { by = null, cause = 'fire', quiet = false } = {}) {
    const w = this.world;
    const p = phys(w, o);
    if (!p.flammable || p.burning || p.burnt || !o.roomId) return false;
    w.objects.change(o.id, { data: { ...o.data, burning: { since: w.now, until: w.now + burnMinutes(w, o), by: by?.id ?? null, cause } } }, { actorId: by?.id ?? 'code', action: 'ignite', notify: false });
    w.logEvent('fire_start', { actorId: by?.id ?? null, location: o.roomId, objectId: o.id, cause });
    w.decals?.add({ kind: 'scorch', roomId: o.roomId, spot: w.maps.objectSpot(o), intensity: 0.6, source: `fire-${o.id}` });
    const room = w.rooms.get(o.roomId);
    if (!quiet) {
      const here = citizensIn(w.citizens, o.roomId).filter((x) => x.alive);
      w.perceive(here.map((x) => x.id), { kind: 'action', text: `Fire! ${w.objects.surfaceText(o).replace(/^./, (x) => x.toUpperCase())} is burning.`, importance: 9, roomId: o.roomId, data: { fire: o.id, interrupt: true, wake: true } });
      for (const e of room?.exits ?? []) {
        const near = citizensIn(w.citizens, e.to).filter((x) => x.alive);
        w.perceive(near.map((x) => x.id), { kind: 'action', text: `Smoke is rising from ${room.name}.`, importance: 7, roomId: e.to, data: { fire: o.id } });
      }
    }
    const mapId = w.maps.mapOf?.(o.roomId);
    if (mapId && w.deaths && !this.dreadRaised?.[o.roomId]) {
      this.dreadRaised = { ...(this.dreadRaised ?? {}), [o.roomId]: w.now };
      w.deaths.raiseDread(mapId, 1, `a fire in ${room?.name ?? 'the village'}`);
    }
    return true;
  }

  /** A lit lantern or candle goes over (someone knocked down at its spot). */
  knockedOver(light, by) {
    const w = this.world;
    const spot = w.maps.objectSpot(light);
    const fuel = w.objects.inRoom(light.roomId).filter((x) => x.id !== light.id && phys(w, x).flammable && !phys(w, x).burning && w.maps.objectSpot(x) === spot);
    const target = fuel.sort((a, b) => (w.objects.type(b)?.size ?? 1) - (w.objects.type(a)?.size ?? 1))[0];
    w.logEvent('light_knocked_over', { actorId: by?.id ?? null, location: light.roomId, objectId: light.id, caught: target?.id ?? null });
    if (light.state === 'lit' && (w.objects.type(light)?.transitions?.lit ?? []).includes('unlit')) w.objects.change(light.id, { state: 'unlit', roomId: light.roomId, placement: { relation: 'floor', of: null } }, { actorId: 'code', action: 'state', notify: false });
    if (target) return this.ignite(target, { by, cause: 'a lamp knocked over' });
    return false;
  }

  /** Water on a burning object (one bucket each) or on a room fire (several). → 'out' | 'less' | 'nothing' */
  pour(o, by) {
    const w = this.world;
    if (o?.data?.burning) { this.extinguish(o, { by, how: 'water' }); return 'out'; }
    return 'nothing';
  }

  pourRoom(roomId, by) {
    const w = this.world;
    const room = w.rooms.get(roomId);
    const list = this.burning(roomId);
    if (!list.length) return 'nothing';
    if (room?.onFire) {
      room.onFire.water = (room.onFire.water ?? 0) + 1;
      w.saveRoom(room);
      // each bucket knocks out one burning thing; the room fire itself dies when nothing is left burning
      this.extinguish(list.sort((a, b) => a.data.burning.since - b.data.burning.since)[0], { by, how: 'water' });
      return this.burning(roomId).length ? 'less' : 'out';
    }
    this.extinguish(list[0], { by, how: 'water' });
    return this.burning(roomId).length ? 'less' : 'out';
  }

  smother(o, by) {
    const w = this.world;
    if (!o?.data?.burning) return 'nothing';
    const small = (w.objects.type(o)?.size ?? 1) <= 1 || w.now - o.data.burning.since < 5; // caught early, even a rack can be beaten out
    if (!small || w.rooms.get(o.roomId)?.onFire) return 'too big';
    this.extinguish(o, { by, how: 'smothered' });
    return 'out';
  }

  extinguish(o, { by = null, how = 'water' } = {}) {
    const w = this.world;
    const p = phys(w, o);
    const left = Math.max(0, Math.round(p.durability * 0.6));
    w.objects.change(o.id, { data: { ...o.data, burning: null, durability: left, scorched: true }, surfaceText: `${w.objects.surfaceText(o)}, scorched black`.slice(0, 160) }, { actorId: by?.id ?? 'code', action: 'extinguish', notify: false });
    w.logEvent('fire_out', { actorId: by?.id ?? null, location: o.roomId, objectId: o.id, how });
    const here = citizensIn(w.citizens, o.roomId).filter((x) => x.alive);
    w.perceive(here.map((x) => x.id), { kind: 'action', text: `The fire on ${w.objects.surfaceText(o)} hisses out${how === 'water' ? ' in a cloud of steam' : ''}.`, importance: 6, sourceId: by?.id ?? null, roomId: o.roomId, data: { fire: o.id, out: true } });
    this.#roomCheck(o.roomId);
  }

  #burnOut(o) {
    const w = this.world;
    const t = w.objects.type(o) ?? {};
    const patch = { data: { ...o.data, burning: null, burnt: true, durability: 0 }, surfaceText: `the charred remains of ${t.name ? `a ${t.name}` : 'something'}` };
    if (t.states?.includes('broken') && (t.transitions?.[o.state] ?? []).includes('broken')) patch.state = 'broken';
    w.objects.change(o.id, patch, { actorId: 'code', action: 'burnt', notify: false });
    w.logEvent('fire_burnt', { location: o.roomId, objectId: o.id });
    w.decals?.add({ kind: 'soot', roomId: o.roomId, spot: w.maps.objectSpot(o), intensity: 0.8, source: `burnt-${o.id}` });
  }

  #roomCheck(roomId) {
    const w = this.world;
    const room = w.rooms.get(roomId);
    if (!room?.onFire || this.burning(roomId).length) return;
    room.onFire = null;
    room.effects = (room.effects ?? []).filter((e) => e.id !== `fire-${roomId}`);
    room.effects.push({ id: `burnt-${roomId}`, text: 'The walls are blackened with smoke and the air stinks of wet ash.', until: w.now + 3 * 1440, source: 'fire' });
    w.saveRoom(room);
    w.logEvent('room_fire_out', { location: roomId });
  }

  /** Every game minute (or so). */
  tick(elapsed) {
    const w = this.world;
    const now = w.now;
    const burning = this.burning();
    const rooms = new Set(burning.map((o) => o.roomId));
    for (const o of burning) {
      if (!o.roomId) { w.objects.change(o.id, { data: { ...o.data, burning: null } }, { actorId: 'code', action: 'extinguish', notify: false }); continue; }
      if (now >= o.data.burning.until) { this.#burnOut(o); continue; }
      const spot = w.maps.objectSpot(o);
      for (const x of w.objects.inRoom(o.roomId)) {
        const px = phys(w, x);
        if (x.id === o.id || !px.flammable || px.burning || px.burnt) continue;
        const cls = w.maps.distanceClass(o.roomId, spot, w.maps.objectSpot(x));
        const p = (cls === 'same' ? 0.12 : cls === 'near' ? 0.03 : 0) * elapsed * (px.accelerant ? 2 : 1);
        if (p > 0 && this.rng() < p) this.ignite(x, { cause: 'spreading fire', quiet: true });
      }
    }
    // rooms
    for (const roomId of new Set([...rooms, ...[...w.rooms.values()].filter((r) => r.onFire).map((r) => r.id)])) {
      const room = w.rooms.get(roomId);
      if (!room) continue;
      const list = this.burning(roomId);
      if (!list.length) { this.#roomCheck(roomId); continue; }
      if (!room.onFire && room.construction === 'timber' && list.length >= ROOM_FIRE_AT) {
        room.onFire = { since: now, water: 0 };
        room.effects = (room.effects ?? []).filter((e) => e.id !== `fire-${roomId}`);
        room.effects.push({ id: `fire-${roomId}`, text: 'The room is on fire: flames run up the timber walls.', until: null, source: 'fire', visual: { kind: 'fire', at: now } });
        w.saveRoom(room);
        w.logEvent('room_fire', { location: roomId, burning: list.length });
        const here = citizensIn(w.citizens, roomId).filter((x) => x.alive);
        w.perceive(here.map((x) => x.id), { kind: 'action', text: 'The whole room is catching fire! Flames are running up the walls.', importance: 10, roomId, data: { fire: roomId, interrupt: true, wake: true } });
        const mapId = w.maps.mapOf?.(roomId);
        if (mapId && w.deaths) w.deaths.raiseDread(mapId, 2, `${room.name} burning`);
        w.decals?.add({ kind: 'soot', roomId, intensity: 1, source: `roomfire-${roomId}` });
      }
      if (room.onFire) {
        for (const x of w.objects.inRoom(roomId)) if (phys(w, x).flammable && !phys(w, x).burning && !phys(w, x).burnt && this.rng() < 0.1 * elapsed) this.ignite(x, { cause: 'the room fire', quiet: true });
        for (const e of room.exits ?? []) {
          const next = w.rooms.get(e.to);
          if (next?.construction !== 'timber' || next.onFire) continue;
          if (this.rng() < 0.02 * elapsed) {
            const fuel = w.objects.inRoom(next.id).filter((x) => phys(w, x).flammable && !phys(w, x).burning && !phys(w, x).burnt);
            if (fuel.length) this.ignite(fuel[Math.floor(this.rng() * fuel.length)], { cause: `the fire spreading from ${room.name}` });
          }
        }
      }
    }
    this.#smoke(elapsed);
  }

  smokeLevel(roomId) {
    const room = this.world.rooms.get(roomId);
    // heavy smoke is 3 at most: about 10 game minutes to senseless, however much burns
    return Math.min(3, this.burning(roomId).length * 0.4 + (room?.onFire ? 2 : 0));
  }

  #smoke(elapsed) {
    const w = this.world;
    const now = w.now;
    for (const c of w.citizens.values()) {
      if (!c.alive || !c.location) continue;
      const level = this.smokeLevel(c.location);
      const p = (c.phys ??= {});
      const before = p.smoke ?? 0;
      if (level > 0) p.smoke = Math.round((before + level * 0.1 * elapsed) * 100) / 100;
      else if (before > 0) p.smoke = Math.max(0, Math.round((before - 0.5 * elapsed) * 100) / 100);
      else continue;
      if (Math.floor(before * 2) !== Math.floor(p.smoke * 2)) w.body.recompute(c);
      if (p.smoke >= SMOKE_DEATH) { w.body.die(c, { cause: 'the smoke of a fire', reason: 'injury' }); continue; }
      if (level <= 0) continue;
      // burning at a burning spot
      const atSpot = this.burning(c.location).filter((o) => w.maps.objectSpot(o) === c.spot);
      if (atSpot.length) {
        w.body.damage(c.id, { damageType: 'burn', part: 'random', amount: Math.min(6, 2.5 * elapsed), cause: 'the flames', sourceId: null });
      }
      // what they notice, now and then
      if (['sleeping', 'collapsed', 'unconscious'].includes(c.activity.type) && level < 3) continue;
      if (now - (p.smokeNoticeAt ?? -Infinity) < NOTICE_EVERY) continue;
      p.smokeNoticeAt = now;
      const room = w.rooms.get(c.location);
      const text = room?.onFire ? 'Flames are spreading toward the door. The smoke is thick; every breath burns.' : level >= 1 ? 'Smoke stings your eyes and catches in your throat.' : 'There is a smell of smoke.';
      w.perceive([c.id], { kind: 'action', text, importance: room?.onFire ? 8 : level >= 1 ? 7 : 5, roomId: c.location, data: { fire: c.location, smoke: true, interrupt: Boolean(room?.onFire) } });
    }
  }

  view() {
    return this.burning().map((o) => ({ id: o.id, roomId: o.roomId, since: o.data.burning.since, until: o.data.burning.until, spot: this.world.maps.objectSpot(o) }));
  }
}

export { isFlame };
