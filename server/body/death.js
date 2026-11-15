// Step 7B: death. Triggers (vitality <= 0, blood < 35%, a vital part destroyed) all end here, in one go:
// thinks aborted, conversation and party memberships ended, a body object created (code creates bodies and, step 9.5,
// graves), carried things dropped beside it (worn garments and aids stay on the body), witnesses told. Step 9.5: grief
// and fear no longer reach everyone at once — world.deaths.onDeath() tells the awake witnesses, and everybody else
// learns by finding the body or being told. LETHAL=false turns it into permanent unconsciousness.
import { config } from '../config.js';
import { citizensIn } from '../world/rooms.js';
import { ref } from '../memory/index.js';
import { pronouns } from '../world/citizens.js';
import { wornGarments } from './garments.js';
import { dropCarried } from './treat.js';

export function killCitizen(body, c, { cause = 'injury', reason = 'injury' } = {}) {
  const w = body.world;
  if (!c.alive || body.dying.has(c.id)) return false;
  if (!config.body.lethal) {
    // debugging mode: never dies, stays unconscious until the director revives them
    c.body.vitality = Math.max(c.body.vitality, 1);
    c.body.blood = Math.max(c.body.blood, (body.content.bleeding.deathBlood ?? 35) + 1);
    c.body.permanentlyDown = true;
    body.knockOut(c, { reason: 'unconscious' });
    return false;
  }
  body.dying.add(c.id);
  try {
    if (c.carryingPerson) dropCarried(w, c, 'dropped');
    if (c.carriedBy) { const carrier = w.citizens.get(c.carriedBy); if (carrier) dropCarried(w, carrier, 'dropped'); }
    w.cancelThink(c);
    if (!c.location && c.activity.type === 'moving') {
      const d = c.activity.detail ?? {};
      c.location = w.rooms.has(d.to) ? d.to : d.from;
    }
    const roomId = c.location;
    if (c.conversationId) w.conversations.leave(c, { reason: 'died' });
    const others = roomId ? citizensIn(w.citizens, roomId, { exceptId: c.id }) : [];
    w.deaths.onDeath(c, { roomId, cause, witnesses: [] }); // ties first, while the groups still list them
    for (const m of w.groups.of(c.id)) w.groups.leave(m.group.id, c.id, { dissolveSmallParty: true });

    const worn = wornGarments(w, c.id).concat(w.objects.wornBy(c.id).filter((o) => !wornGarments(w, c.id).includes(o)));
    // the body object
    const id = `body_${c.id}`;
    if (roomId && !w.objects.get(id)) {
      w.objects.create({
        id, type: 'corpse', room: roomId, name: `${c.name}'s body`, state: 'still', visibility: 'obvious',
        surfaceText: 'someone lying very still',
        trueText: `${c.name} died of ${cause}.${worn.length ? ` Still wearing: ${worn.map((o) => w.objects.short(o)).join(', ')}.` : ''}`,
        data: { citizenId: c.id, diedAt: w.now, short: 'body', spot: c.spot ?? null },
      }, { actorId: 'code', origin: 'code' });
      // what they were carrying falls to the floor beside the body
      for (const o of w.objects.carriedBy(c.id)) {
        w.objects.change(o.id, { roomId, placement: { relation: 'beside', of: id } }, { actorId: 'code', action: 'move', notify: false, text: `${w.objects.short(o)} falls from ${c.name}'s hands` });
      }
    }
    c.alive = false;
    c.diedAt = w.now;
    w.setActivity(c, { type: 'collapsed', detail: { reason, dead: true, cause } });
    w.logEvent('death', { actorId: c.id, location: roomId, reason, cause });
    // witnesses: importance 10
    w.perceive(others.map((o) => o.id), {
      kind: 'action', text: `${ref(c)} goes still and stops breathing.`,
      importance: 10, sourceId: c.id, roomId, data: { interrupt: true, death: true },
    });
    w.saveCitizen(c);
    // step 9.5: awake witnesses know at once (grief and fear for them now); everyone else finds out later
    w.deaths.onDeath(c, { roomId, cause, witnesses: others });
    w.physical?.consequences.onDeath(c, { cause }); // step 10: a death from someone's blows is theirs (murder, deeds, fear of discovery)
    for (const o of others) {
      if (['sleeping', 'collapsed'].includes(o.activity.type)) continue;
      if (/bled|blood|killed|slain|wound|stab|cut|blast|burn|fell/i.test(cause)) {
        w.emotions.bump(o, { type: 'fear', target: null, delta: 5, cause: `I watched ${ref(c)} die`, source: 'death', raw: true, rule: 'witnessed_death' });
      }
    }
  } finally {
    body.dying.delete(c.id);
  }
  return true;
}
