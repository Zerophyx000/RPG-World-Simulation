// Step 10: action and reaction. world.physical is the facade World and the action layer call; world.altercations holds
// the fights. Everything resolves through combatProfile() and weapon profiles (profile.js) — see README.md here.
//
//   physical.rng                 Math.random by default; checks replace it for reproducible contests
//   physical.consequences        deeds, intents, aftermath, reversal, welcomeness, crimes (consequences.js)
//   physical.fire                ignition, spread, smoke, putting out (fire.js)
//   physical.tools(c, fn, INNER) act_on, get_up, handle, force_door — only what applies right now
//   physical.apply(c, call, h)   the actions (validated again against the state as it is now)
//   physical.tick(elapsed)       holds and chokes, fights ending, fire, fear of discovery
import { actOnTools, actOn, getUp, finishAct, comingAt, tickBodies, isDown } from './acts.js';
import { handleTool, handle, forceDoor } from './handle.js';
import { Consequences } from './consequences.js';
import { Fire } from './fire.js';
import { combatProfile, weaponProfile, isDark } from './profile.js';
import { phys } from './props.js';

export class Physical {
  constructor(world) {
    this.world = world;
    this.rng = Math.random;
    this.consequences = new Consequences(world);
    this.fire = new Fire(world);
    this.waterRooms = ['well'];
    this.acc = 0;
  }

  tools(c, fn, INNER) {
    const w = this.world;
    const out = [...actOnTools(w, c, fn, INNER)];
    const h = handleTool(w, c, fn, INNER);
    if (h) out.push(h);
    const fd = this.forceDoorTool(c, fn, INNER);
    if (fd) out.push(fd);
    return out;
  }

  forceDoorTool(c, fn, INNER) {
    const w = this.world;
    if (!c.location || isDown(c) || ['sleeping', 'collapsed'].includes(c.activity.type)) return null;
    const room = w.rooms.get(c.location);
    const blocked = [];
    for (const e of room?.exits ?? []) {
      const b = w.maps.doorBetween?.(c.location, e.to);
      if (!b || b.insideRoom === c.location) continue;
      const shut = ['barred', 'locked'].includes(b.door.state) || w.objects.inRoom(b.insideRoom).some((x) => x.data?.barricade === b.door.id);
      if (shut) blocked.push(e.to);
    }
    if (!blocked.length) return null;
    return fn('force_door', `Throw your weight against a door that is shut against you from the inside (barred, locked, or with something pushed against it). Others pushing with you add their strength. Doors to: ${blocked.map((id) => `"${id}" = ${w.rooms.get(id)?.name}`).join('; ')}.`, {
      destination: { type: 'string', enum: blocked, description: 'Which door: the place behind it.' },
      inner_thought: INNER,
    }, ['destination']);
  }

  /** → a result, or null if the call is not a physical one. h = { stale, logAction, remember, findPerson } */
  apply(c, call, h) {
    const w = this.world;
    switch (call.name) {
      case 'act_on': return actOn(w, c, call, h);
      case 'get_up': return getUp(w, c, call, h);
      case 'handle': return handle(w, c, call, h);
      case 'force_door': {
        const b = w.maps.doorBetween?.(c.location, call.arguments.destination);
        if (!b || b.insideRoom === c.location) return h.stale(w, c, call, 'There is no door shut against you there.');
        h.logAction(w, c, call, { doorId: b.door.id });
        const r = forceDoor(w, c, b.door);
        w.setActivity(c, { type: 'doing', until: w.now + 1, detail: { kind: 'handle', handle: 'force', forcing: b.door.id, description: 'throwing your weight against the door', minutes: 1 } });
        w.perceive([c.id], { kind: 'action', text: r.won ? 'The door gives way.' : 'The door holds.', importance: r.won ? 7 : 6, roomId: c.location, data: { door: b.door.id } });
        h.remember(w, c, r.won ? 'You forced the door.' : 'You threw your weight against the door; it held.');
        return { ok: true };
      }
      default: return null;
    }
  }

  actOn(world, c, call, h) {
    return actOn(world, c, call, h);
  }

  /** Before a walk to someone you mean to attack: they see you coming. */
  comingAt(c, call) {
    if (call.name !== 'act_on') return;
    const w = this.world;
    const here = [...w.citizens.values()].filter((o) => o.location === c.location && o.id !== c.id);
    const t = w.memory.labelsFor(c, here).get(call.arguments?.person) ?? here.find((o) => o.name === call.arguments?.person);
    if (t) comingAt(w, c, t, call.arguments?.action);
  }

  finishes(kind) {
    return kind === 'act';
  }

  finish(c, a) {
    return finishAct(this.world, c, a);
  }

  tick(elapsed) {
    const w = this.world;
    tickBodies(w, elapsed);
    w.altercations.tick();
    this.acc += elapsed;
    if (this.acc >= 1) {
      const step = this.acc;
      this.acc = 0;
      this.fire.tick(step);
      this.consequences.tick();
    }
  }

  // read models
  profileView(c) {
    const w = this.world;
    const held = w.objects.carriedBy(c.id);
    return {
      profile: combatProfile(w, c),
      dark: isDark(w, c.location),
      phys: c.phys ?? {},
      weapons: held.map((o) => ({ id: o.id, alias: w.objects.alias(o), name: w.objects.surfaceText(o), profile: weaponProfile(w, o), props: phys(w, o) })),
      intents: c.intents ?? {},
      deeds: (c.deeds ?? []).map((d) => ({ ...d, text: w.memory.resolveNames(c, this.consequences.deedLines({ ...c, deeds: [d], discovery: null })[0] ?? '') })),
      wary: c.wary ?? {},
      discovery: c.discovery ?? null,
    };
  }
}
