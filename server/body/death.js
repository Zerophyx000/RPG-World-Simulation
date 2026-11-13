// Step 7B: death. Triggers (vitality <= 0, blood < 35%, a vital part destroyed) all end here, in one go:
// thinks aborted, conversation and plan and party memberships ended, a body object created (the ONLY thing code
// creates in this step), carried things dropped beside it (worn garments and aids stay on the body), witnesses told,
// grief for the people who loved them (step 6). LETHAL=false turns it into permanent unconsciousness.
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
    c.plan = null;
    c.needsPlan = false;
    for (const m of w.groups.of(c.id)) w.groups.leave(m.group.id, c.id, { dissolveSmallParty: true });

    const others = roomId ? citizensIn(w.citizens, roomId, { exceptId: c.id }) : [];
    const worn = wornGarments(w, c.id).concat(w.objects.wornBy(c.id).filter((o) => !wornGarments(w, c.id).includes(o)));
    // the body object
    const id = `body_${c.id}`;
    if (roomId && !w.objects.get(id)) {
      w.objects.create({
        id, type: 'corpse', room: roomId, name: `${c.name}'s body`, state: 'still', visibility: 'obvious',
        surfaceText: 'a body lying where it fell',
        trueText: `${c.name} died of ${cause}.${worn.length ? ` Still wearing: ${worn.map((o) => w.objects.short(o)).join(', ')}.` : ''}`,
        data: { citizenId: c.id, diedAt: w.now, short: `${c.name}'s body` },
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
    grieve(body, c, others, cause);
  } finally {
    body.dying.delete(c.id);
  }
  return true;
}

// Step 6 hooks: grief aimed at the dead (long half-life, strength from affinity), fear in witnesses, a mood drop for
// close people. No-ops when the emotion system isn't there.
function grieve(body, dead, witnesses, cause) {
  const w = body.world;
  if (!w.emotions?.bump) return;
  const witnessIds = new Set(witnesses.map((x) => x.id));
  for (const c of w.citizens.values()) {
    if (!c.alive || c.id === dead.id || c.kind !== 'citizen') continue;
    const rel = w.memory.rel(c.id, dead.id);
    const affinity = rel?.affinity ?? 0;
    if (affinity >= 3) {
      const strength = Math.min(9, 6 + (affinity - 3) * 1.5);
      w.emotions.bump(c, {
        type: 'sadness', target: dead.id, delta: strength, cause: `${dead.name} is dead`, source: 'death', raw: true, rule: 'grief',
        data: { grief: true, halfLifeHours: 24 * 10 },
      });
      w.emotions.directorMood?.({ citizenId: c.id, valence: -Math.min(4, affinity - 1), tension: 1 });
    }
    if (witnessIds.has(c.id) && /bled|blood|killed|slain|wound|stab|cut|blast|burn|fell/i.test(cause)) {
      w.emotions.bump(c, { type: 'fear', target: null, delta: 5, cause: `I watched ${dead.name} die`, source: 'death', raw: true, rule: 'witnessed_death' });
    }
  }
}
