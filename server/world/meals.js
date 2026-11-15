// Step 11.5 (B3): meal portions — the one food object. Step 5's rule was "no food objects": eating happens at a food
// service. To feed someone who can't get there, a food service can now hand over ONE portion (`take_meal`): the
// service's operator gives it (or, where the service has none, you take it yourself), it comes out of the service's real
// stock (world/stock.js), and code creates the object — never a citizen's imagination (AGENTS.md: citizens never
// create objects; service output from real stock is the exception, like corpses and graves).
//
//   type `meal` (content/object-types.json, tags food + perishable), data { relief, description, from, madeAt, spoilsAt }
//   spoils after SPOIL_MINUTES (fresh → spoiled; a spoiled one feeds nobody)
//   eaten (`eat` while holding one, anywhere) or fed (`feed` someone, anywhere): removed
import { citizensIn } from './rooms.js';

export const SPOIL_MINUTES = 360;
const CHECK_EVERY = 10;

/** Fresh meal portions this citizen carries. */
export function heldMeals(world, c) {
  return world.objects.carriedBy(c.id).filter((o) => o.typeId === 'meal' && o.state === 'fresh');
}

/** The operator of a food service is here and able to serve (or the service has none). */
export function serverPresent(world, room, svc, c) {
  if (!svc.operator || svc.operator === c.id) return true;
  return citizensIn(world.citizens, room.id).some((o) => o.id === svc.operator && o.alive && !['sleeping', 'collapsed'].includes(o.activity.type));
}

/** Create one portion from a service (stock already taken). → the object view */
export function createMeal(world, c, room, svc) {
  const id = `meal_${world.now.toFixed(0)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  return world.objects.create({
    id, type: 'meal', holder: c.id, state: 'fresh', visibility: 'obvious',
    surfaceText: `a meal portion wrapped in a cloth (${svc.description ?? 'food'})`,
    data: { relief: svc.hungerRelief ?? 40, description: svc.description ?? 'food', from: room.id, madeAt: world.now, spoilsAt: world.now + SPOIL_MINUTES },
  }, { actorId: svc.operator ?? c.id, origin: 'code', action: 'serve' }); // code-made (service output from real stock), never 'citizen'
}

export class Meals {
  constructor(world) {
    this.world = world;
    this.last = -Infinity;
  }

  /** Fresh portions past their time go sour. */
  tick() {
    const w = this.world;
    if (w.now - this.last < CHECK_EVERY) return;
    this.last = w.now;
    for (const o of w.objects.byId.values()) {
      if (o.typeId !== 'meal' || o.state !== 'fresh') continue;
      if (w.now >= (o.data?.spoilsAt ?? Infinity)) w.objects.change(o.id, { state: 'spoiled' }, { actorId: 'code', action: 'spoil' });
    }
  }
}
