// Step 7B: dedicated supply places. Bandage rolls, herbs, needles and spirits are ordinary objects that lose state
// when used; content/supplies.json says which ones are restocked where and how often. Code resets the EXISTING
// object to its refill state on a timer ("Lena's linen chest has clean strips again"). Nothing is ever created.
import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_DIR } from '../world/scenarios.js';
import { citizensIn } from '../world/rooms.js';

export function loadSupplies() {
  try {
    return JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'supplies.json'), 'utf8')).supplies ?? [];
  } catch {
    return [];
  }
}

/** Called every few game minutes. Returns how many objects were restocked. */
export function restock(world, now) {
  const list = world.body.supplies ?? (world.body.supplies = loadSupplies());
  let n = 0;
  for (const s of list) {
    const o = world.objects.get(s.objectId);
    if (!o) continue;
    const target = s.refill ?? 'full';
    if (o.state === target) {
      if (o.data?.restockAt != null) world.objects.change(o.id, { data: { restockAt: null } }, { actorId: 'code', action: 'edit', notify: false });
      continue;
    }
    if (o.data?.restockAt == null) {
      world.objects.change(o.id, { data: { restockAt: now + (s.everyGameHours ?? 24) * 60 } }, { actorId: 'code', action: 'edit', notify: false });
      continue;
    }
    if (now < o.data.restockAt) continue;
    world.objects.change(o.id, { state: target, data: { restockAt: null } }, { actorId: 'code', action: 'state', notify: false, text: `${world.objects.short(o)} is restocked` });
    n++;
    if (s.announce && o.roomId) {
      world.perceive(citizensIn(world.citizens, o.roomId).filter((c) => !['sleeping', 'collapsed'].includes(c.activity.type)).map((c) => c.id), { kind: 'notice', text: s.announce, importance: 3, roomId: o.roomId });
    }
    world.logEvent('restock', { location: o.roomId, objectId: o.id, state: target });
  }
  return n;
}
