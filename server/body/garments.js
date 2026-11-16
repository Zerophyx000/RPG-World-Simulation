// Step 7B: basic worn clothing. Garments are ordinary objects (type tag "garment", a `covers` list of body parts)
// worn by a citizen (holder_id set, placement.relation 'worn', no carry slot). Damage hitting a covered part wears the
// garment down a state; a garment over a bleeding wound gets data.bloodied. There is no protection yet: the RPG step
// adds armor values on top of `covers`.

const STATES = ['intact', 'worn', 'torn', 'rags', 'destroyed'];

const isGarment = (world, o) => world.objects.type(o)?.tags?.includes('garment');

/** Garments (not aids) a citizen wears. */
export function wornGarments(world, citizenId) {
  return world.objects.wornBy(citizenId).filter((o) => isGarment(world, o));
}

/** Garments covering a part, outermost first (a cloak before a tunic); destroyed ones cover nothing. */
export function garmentsCovering(world, citizenId, partId) {
  const order = { cloak: 0, hood: 1, tunic: 2, skirt: 2, trousers: 2, cap: 1, boots: 2, gloves: 2 };
  return wornGarments(world, citizenId)
    .filter((o) => o.state !== 'destroyed' && world.objects.type(o)?.covers?.includes(partId))
    .sort((a, b) => (order[a.typeId] ?? 5) - (order[b.typeId] ?? 5));
}

/** Wear a garment down `steps` states (cut / burn > blunt). Returns the new state. */
export function degradeGarment(world, g, steps, { cause = null, actorId = 'code' } = {}) {
  const i = STATES.indexOf(g.state);
  if (i < 0 || steps <= 0) return g.state;
  const next = STATES[Math.min(STATES.length - 1, i + steps)];
  if (next === g.state) return g.state;
  world.objects.change(g.id, { state: next }, { actorId, action: 'state', notify: false, text: `${world.objects.short(g)} is ${next}${cause ? ` (${cause})` : ''}`, extra: { body: true } });
  return next;
}

export function setBloodied(world, g, bloodied = true) {
  if (Boolean(g.data?.bloodied) === bloodied) return;
  world.objects.change(g.id, { data: { bloodied } }, { actorId: 'code', action: 'edit', notify: false, text: `${world.objects.short(g)} ${bloodied ? 'is stained with blood' : 'has been washed clean'}` });
}

/** The first garment of a given set that is good enough to tear a strip from (state better than rags). */
export function tearable(world, citizenId) {
  return wornGarments(world, citizenId).filter((g) => g.state === 'intact' || g.state === 'worn' || g.state === 'torn');
}

// A few garments per citizen, once (idempotent): content decides who wears what; the default is tunic, trousers or
// skirt and boots, a cloak for some, gloves for smiths. Origin 'content', never invented later.
export function ensureGarments(world, c) {
  if (!c.alive || c.kind !== 'citizen' || c.body?.garmentsSeeded) return 0;
  c.body.garmentsSeeded = true;
  if (wornGarments(world, c.id).length) return 0;
  const persona = c.persona ?? {};
  const set = Array.isArray(persona.clothing) && persona.clothing.length ? persona.clothing : null;
  const hash = [...c.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const female = String(persona.sex ?? '').toLowerCase().startsWith('f');
  const list = set ?? [
    'tunic', female ? 'skirt' : 'trousers', 'boots',
    ...(hash % 3 === 0 ? ['cloak'] : hash % 3 === 1 ? ['cap'] : []),
    ...(/smith|forge/i.test(String(persona.occupation ?? '')) ? ['gloves'] : []),
  ];
  let n = 0;
  for (const type of list) {
    const id = `${c.id}_${type}`;
    if (world.objects.get(id) || !world.objects.types.has(type)) continue;
    world.objects.create({
      id, type, holder: c.id, owner: c.id, placement: { relation: 'worn' }, state: 'worn', short: world.objects.types.get(type).name,
    }, { actorId: 'code', origin: 'content', action: 'seed' });
    n++;
  }
  return n;
}
