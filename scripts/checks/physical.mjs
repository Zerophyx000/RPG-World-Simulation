// Step 10 check, §1–§8: act_on, resolution, weapons, status effects, altercations, consequences, caring touch, objects,
// fire, restraint and killing, crime events. In-process world, no LLM; the contest dice are seeded for repeatability.
// node --disable-warning=ExperimentalWarning scripts/checks/physical.mjs .
import fs from 'node:fs';
import path from 'node:path';
const [,, rootArg = process.cwd(), dataDir = `${process.env.TEMP ?? '/tmp'}/aw-physical10`] = process.argv;
const root = path.resolve(rootArg).split(path.sep).join('/');
fs.rmSync(dataDir, { recursive: true, force: true });
Object.assign(process.env, { DATA_DIR: dataDir, SCENARIO: 'village', LLM_BASE_URL: 'http://localhost:9/v1', SPOT_WALKING: 'false' });
const imp = (p) => import(`file:///${root}/${p}`);
const { openDb, migrate } = await imp('server/db.js');
const { World } = await imp('server/world.js');
const { buildMessages } = await imp('server/agents/prompt.js');
const { buildTools } = await imp('server/agents/tools.js');
const { chooseTier } = await imp('server/agents/tiers.js');
const { combatProfile, weaponProfile, isDark } = await imp('server/physical/profile.js');
const { phys } = await imp('server/physical/props.js');
const { damageFor } = await imp('server/physical/acts.js');
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) pass++; else fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const db = openDb(); await migrate(db);
const w = new World(db);
w.scheduler.run = () => {}; w.scheduler.poke = () => {}; w.clock.running = true; w.habits.ensure = () => {};
// seeded dice
let seed = 12345;
const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
w.physical.rng = rng;
const C = (id) => w.citizens.get(id);
const move = (id, to) => w.directorEvent({ effects: [{ type: 'move', target: id, to, notify: false }] });
const advance = (m, step = 0.25) => { for (let t = 0; t < m; t += step) { w.clock.gameMinutes += step; for (const h of [...w.clock.handlers]) h(step, w.clock.gameMinutes); for (const c of w.citizens.values()) if (c.alive && c.needs) { c.needs.hunger = Math.min(c.needs.hunger, 10); c.needs.fatigue = Math.min(c.needs.fatigue, 20); } } };
const label = (viewer, target) => [...w.memory.labelsFor(C(viewer), [C(target)]).keys()][0];
const act = (a, t, action, extra = {}) => { w.setActivity(C(a), { type: 'idle' }); return w.applyAction(C(a), { name: 'act_on', arguments: { person: label(a, t), action, ...extra } }); };
const handle = (a, object, action, extra = {}) => { w.setActivity(C(a), { type: 'idle' }); return w.applyAction(C(a), { name: 'handle', arguments: { object: w.objects.alias(object), action, ...extra } }); };
const tool = (id, name) => buildTools(w, C(id)).find((t) => t.function.name === name);
const actsOf = (id) => tool(id, 'act_on')?.function.parameters.properties.action.enum ?? [];
const events = (type) => db.prepare('SELECT actor_id, data FROM events WHERE type = ? ORDER BY id').all(type).map((r) => ({ actor: r.actor_id, ...JSON.parse(r.data) }));
const reset = (id) => {
  const c = C(id);
  c.phys = {}; c.deeds = []; c.intents = {}; c.wary = {}; c.discovery = null; c.emotions = []; c.inbox = [];
  for (const b of w.physical.fire.burning()) w.physical.fire.extinguish(b);
  w.body.heal(id, { all: true, amount: 100, allowPermanent: true });
  c.body.blood = 100; c.body.vitality = 100; w.body.recompute(c);
  w.setActivity(c, { type: 'idle' });
};
const hold = (id, typeId, extra = {}) => {
  for (const o of w.objects.carriedBy(id)) w.objects.change(o.id, { roomId: C(id).location, placement: { relation: 'floor', of: null } }, { actorId: 'director', action: 'move', notify: false });
  const pool = [...w.objects.byId.values()].filter((x) => x.typeId === typeId && !x.data?.burnt && x.placement?.relation !== 'worn' && (extra.not ? !extra.not.includes(x.id) : true));
  const o = pool.find((x) => !x.holderId) ?? pool.find((x) => x.holderId !== id) ?? pool[0];
  w.objects.change(o.id, { holderId: id, ...(extra.state ? { state: extra.state } : {}) }, { actorId: 'director', action: 'give', notify: false });
  return w.objects.get(o.id);
};
// in a real run everyone answers a blow with a decision; here nobody calls the model, so mark it
const answered = () => { for (const c of w.citizens.values()) c.lastDecisionAt = w.now; };
const endAll = () => { for (const a of w.altercations.active()) w.altercations.end(a, 'director'); };
const ALL = ['tomas', 'jonas', 'lena', 'anselm', 'greta'];
// every light out to begin with (a knocked-over candle sets real fires; the fire tests light their own)
for (const o of w.objects.byId.values()) if (o.state === 'lit' && ['candle', 'lantern', 'torch'].includes(o.typeId)) w.objects.change(o.id, { state: 'unlit' }, { actorId: 'director', action: 'state', notify: false });
for (const id of ALL) { move(id, 'tavern'); reset(id); }
w.clock.gameMinutes = 1440 + 10 * 60; // day 2, 10:00

console.log('\n--- content and profiles');
ok(w.objects.types.get('sword')?.weapon?.damage?.length && w.objects.types.get('hammer').tags.includes('heavy') && w.objects.types.get('spirits_bottle').states.includes('broken'), 'object types carry weapon profiles, tags and new states');
ok(['tavern_sword', 'smithy_axe', 'tavern_club', 'lena_hunting_knife', 'tavern_lantern', 'tavern_stool_1', 'tavern_bottle'].every((id) => w.objects.get(id)), 'seeded weapons, lantern, stool, bottle');
ok(phys(w, w.objects.get('tavern_table_1')).durability === 45 && phys(w, w.objects.get('tavern_table_1')).pushable && phys(w, w.objects.get('greta_door')).lockable, 'old objects read their physical props from the type (no reseed)');
ok(w.rooms.get('tavern').construction === 'timber' && w.rooms.get('smithy').construction === 'stone', 'rooms know what they are built of');
const pT = combatProfile(w, C('tomas'));
const pJ = combatProfile(w, C('jonas'));
ok(['force', 'precision', 'evasion', 'toughness', 'grip', 'speed', 'reach', 'composure'].every((k) => k in pT), `combatProfile has every factor (${JSON.stringify(pT)})`);
ok(fs.existsSync(`${root}/server/physical/README.md`), 'server/physical/README.md documents the profiles and their future hooks');

console.log('\n--- §1 one tool, filtered');
let enumT = actsOf('tomas');
ok(enumT.includes('punch') && enumT.includes('embrace') && !enumT.includes('strike') && !enumT.includes('choke') && !enumT.includes('break_free') && !enumT.includes('help_up'), `only valid actions: ${enumT.join(',')}`);
const hammer = hold('tomas', 'hammer');
enumT = actsOf('tomas');
ok(enumT.includes('strike') && enumT.includes('throw_at') && tool('tomas', 'act_on').function.parameters.properties.with.enum.includes(w.objects.alias(hammer)), 'holding a hammer: strike / throw_at with it');
C('jonas').phys.prone = true;
ok(tool('jonas', 'get_up') && !actsOf('jonas').includes('punch') && actsOf('jonas').includes('kick'), `prone: get_up offered, little else (${actsOf('jonas').join(',')})`);
C('jonas').phys.prone = false;
C('jonas').phys.restraint = { kind: 'held', by: 'tomas', since: w.now }; C('tomas').phys.holding = 'jonas';
ok(JSON.stringify(actsOf('jonas').sort()) === JSON.stringify(['break_free', 'plead', 'yield']), `held: only break_free / plead / yield (${actsOf('jonas').join(',')})`);
ok(actsOf('tomas').includes('choke') && actsOf('tomas').includes('pin_down'), 'holding someone: choke and pin_down appear');
C('jonas').phys.restraint = null; C('tomas').phys.holding = null;

console.log('\n--- §2 resolution');
{
  // a strong, practiced, angry smith vs a frightened, exhausted apprentice
  reset('tomas'); reset('jonas');
  w.emotions.bump(C('tomas'), { type: 'anger', target: 'jonas', delta: 7, cause: 'x', source: 'director', raw: true });
  w.emotions.bump(C('jonas'), { type: 'fear', target: 'tomas', delta: 7, cause: 'x', source: 'director', raw: true });
  C('jonas').needs.fatigue = 85;
  const smith = combatProfile(w, C('tomas'), { opponentId: 'jonas' });
  const boy = combatProfile(w, C('jonas'), { opponentId: 'tomas' });
  C('jonas').needs.fatigue = 10;
  ok(smith.force > boy.force * 1.3 && smith.precision > boy.precision, `smith force ${smith.force} / precision ${smith.precision} vs apprentice ${boy.force} / ${boy.precision}`);
  const hits = (a, t, n, aim) => { let h = 0; let d = 0; for (let i = 0; i < n; i++) { const pa = combatProfile(w, C(a), { opponentId: t }); const pt = combatProfile(w, C(t), { opponentId: a }); const att = pa.precision * (aim === 'head' ? 0.7 : 1) * (0.75 + rng() * 0.5); const def = pt.evasion * (0.75 + rng() * 0.5); if (att > def) h++; d += damageFor(w, C(a), C(t), { action: 'punch', intent: 'hurt', aim }).amount; } return { h: h / n, d: d / n }; };
  C('jonas').needs.fatigue = 85; const s1 = hits('tomas', 'jonas', 300); C('jonas').needs.fatigue = 10;
  C('jonas').needs.fatigue = 85; const s2 = hits('jonas', 'tomas', 300); C('jonas').needs.fatigue = 10;
  ok(s1.h > s2.h && s1.d > s2.d, `the smith hits more often and harder (hit ${s1.h.toFixed(2)} dmg ${s1.d.toFixed(1)} vs ${s2.h.toFixed(2)} / ${s2.d.toFixed(1)})`);
  const body = hits('tomas', 'anselm', 400);
  const head = hits('tomas', 'anselm', 400, 'head');
  ok(head.h < body.h, `aiming at the head misses more often (${head.h.toFixed(2)} vs ${body.h.toFixed(2)})`);
  // a landed head blow dazes
  reset('anselm'); reset('tomas');
  let dazed = false;
  for (let i = 0; i < 80 && !dazed; i++) { act('tomas', 'anselm', 'punch', { aim: 'head', intent: 'hurt' }); dazed = (C('anselm').phys.dazedUntil ?? 0) > w.now; advance(0.5); }
  ok(dazed, 'a head blow that lands dazes');
  endAll(); reset('anselm'); reset('tomas');
  // a sleeping target is hit automatically and wakes
  w.applyAction(C('anselm'), { name: 'sleep', arguments: { until_rested: true } });
  w.setActivity(C('tomas'), { type: 'idle' });
  const before = events('physical').length;
  act('tomas', 'anselm', 'punch', { intent: 'hurt' });
  const last = events('physical').at(-1);
  ok(events('physical').length === before + 1 && last.hit && C('anselm').activity.type !== 'sleeping', `a sleeping target is hit and wakes (hit ${last.hit}, now ${C('anselm').activity.type})`);
  endAll(); reset('anselm'); reset('tomas'); reset('jonas');
}

console.log('\n--- §2.4 weapons');
{
  const bare = []; const ham = []; const knife = [];
  for (let i = 0; i < 200; i++) {
    bare.push(damageFor(w, C('tomas'), C('jonas'), { action: 'punch', intent: 'hurt' }));
    ham.push(damageFor(w, C('tomas'), C('jonas'), { action: 'strike', weapon: weaponProfile(w, w.objects.get('smithy_hammer') ?? hold('tomas', 'hammer')), intent: 'hurt' }));
    knife.push(damageFor(w, C('tomas'), C('jonas'), { action: 'strike', weapon: weaponProfile(w, w.objects.get('lena_hunting_knife')), intent: 'kill' }));
  }
  const avg = (l) => l.reduce((s, x) => s + x.amount, 0) / l.length;
  ok(avg(bare) < 8 && bare.every((x) => x.type === 'blunt'), `bare hands: blunt, low (avg ${avg(bare).toFixed(1)})`);
  ok(avg(ham) > avg(bare) * 2.2, `a hammer hits far harder (avg ${avg(ham).toFixed(1)})`);
  ok(knife.every((x) => ['cut', 'pierce'].includes(x.type)) && knife.filter((x) => ['head', 'neck', 'torso'].includes(x.part)).length > 150, 'a knife meant to kill: punctures and cuts, at head, neck or torso');
  const sword = weaponProfile(w, w.objects.get('tavern_sword'));
  ok(sword.quality === 0.6 && !sword.improvised && sword.reach === 'near', `a seeded sword uses its quality (${sword.quality}) and reach`);
  const stool = weaponProfile(w, w.objects.get('tavern_stool_1'));
  ok(stool.improvised && stool.damage[0].type === 'blunt', 'a stool is an improvised blunt weapon');
  // a bottle broken becomes sharp
  reset('tomas');
  const bottle = hold('tomas', 'bottle');
  for (let i = 0; i < 5 && w.objects.get(bottle.id).state !== 'broken'; i++) handle('tomas', w.objects.get(bottle.id), 'break');
  const broken = w.objects.get(bottle.id);
  ok(broken.state === 'broken' && weaponProfile(w, broken).damage.some((d) => d.type === 'cut'), `a broken bottle becomes sharp (${broken.state}, ${JSON.stringify(weaponProfile(w, broken).damage)})`);
  // bare-handed fights rarely kill
  reset('jonas'); reset('tomas');
  for (const o of w.objects.carriedBy('tomas')) w.objects.change(o.id, { roomId: 'tavern', placement: { relation: 'floor', of: null } }, { actorId: 'director', action: 'move', notify: false });
  for (let i = 0; i < 12; i++) { act('tomas', 'jonas', 'punch', { intent: 'hurt' }); advance(0.5); }
  ok(C('jonas').alive, `a dozen punches don't kill (vitality ${Math.round(C('jonas').body.vitality)})`);
  // weapon durability drops
  endAll(); reset('jonas'); reset('tomas');
  const h2 = hold('tomas', 'hammer');
  const d0 = phys(w, h2).durability;
  for (let i = 0; i < 30 && phys(w, w.objects.get(h2.id)).durability >= d0; i++) { act('tomas', 'jonas', 'strike', { with: w.objects.alias(h2), intent: 'subdue', aim: 'left_arm' }); advance(0.5); }
  ok(phys(w, w.objects.get(h2.id)).durability < d0, `the hammer wears with use (${d0} → ${phys(w, w.objects.get(h2.id)).durability})`);
  ok(C('jonas').alive && (C('jonas').body.chips ?? []).length >= 0, 'and a hammer meant to subdue leaves him alive');
  endAll(); reset('jonas'); reset('tomas');
}

console.log('\n--- §2.2 status effects');
{
  // knockdown by a shove on someone helpless
  w.applyAction(C('jonas'), { name: 'sleep', arguments: { until_rested: true } });
  act('tomas', 'jonas', 'shove', { intent: 'scare' });
  ok(C('jonas').phys.prone, 'a shove can knock someone down');
  ok(w.applyAction(C('jonas'), { name: 'get_up', arguments: {} }).ok && !C('jonas').phys.prone, 'get_up');
  endAll(); reset('jonas');
  // winded by a torso blow
  let winded = false;
  for (let i = 0; i < 20 && !winded; i++) { act('tomas', 'jonas', 'punch', { aim: 'torso', intent: 'hurt' }); winded = (C('jonas').phys.windedUntil ?? 0) > w.now; advance(0.5); }
  ok(winded, 'a torso blow winds');
  endAll(); reset('jonas'); reset('tomas');
  // disarm: a strike at the arm can knock the weapon out of the hand
  hold('jonas', 'knife');
  const h3 = hold('tomas', 'club');
  let disarmed = false;
  for (let i = 0; i < 80 && !disarmed; i++) { act('tomas', 'jonas', 'strike', { with: w.objects.alias(h3), aim: 'right_arm', intent: 'subdue' }); disarmed = !w.objects.carriedBy('jonas').length; advance(0.5); }
  ok(disarmed, 'a blow to the arm disarms');
  endAll(); reset('jonas'); reset('tomas');
  // grab → held → break_free
  w.applyAction(C('jonas'), { name: 'sleep', arguments: { until_rested: true } });
  act('tomas', 'jonas', 'grab', { intent: 'subdue' });
  w.setActivity(C('jonas'), { type: 'idle' });
  ok(C('jonas').phys.restraint?.kind === 'held' && C('jonas').phys.restraint.by === 'tomas', 'a grab holds');
  let free = false;
  for (let i = 0; i < 20 && !free; i++) { w.applyAction(C('jonas'), { name: 'act_on', arguments: { person: label('jonas', 'tomas'), action: 'break_free' } }); free = !C('jonas').phys.restraint; advance(0.3); }
  ok(free, 'break_free can get loose');
  // pin and choke: senseless after about 3 steps, dead if it goes on
  endAll(); reset('jonas'); reset('tomas');
  w.applyAction(C('jonas'), { name: 'sleep', arguments: { until_rested: true } });
  act('tomas', 'jonas', 'pin_down', { intent: 'kill' });
  ok(C('jonas').phys.restraint?.kind === 'pinned' && C('jonas').phys.prone, 'pinned to the floor');
  const steps = [];
  for (let i = 0; i < 10 && C('jonas').alive; i++) { act('tomas', 'jonas', 'choke', { intent: 'kill' }); steps.push(`${C('jonas').phys.asphyxia}:${C('jonas').activity.type}`); advance(0.5); }
  ok(steps[2]?.includes('collapsed') || steps[3]?.includes('collapsed'), `choking: senseless after about 3 steps (${steps.slice(0, 4).join(' ')})`);
  ok(!C('jonas').alive && steps.length >= 6 && steps.length <= 9, `dead after 6–8 continued steps (${steps.length})`);
  ok(/strangled/.test(C('jonas').body?.deathCause ?? C('jonas').deathCause ?? JSON.stringify(events('death').at(-1) ?? {})), 'the cause: strangled');
  ok(events('crime').some((e) => e.kind === 'murder' && e.actor === 'tomas'), 'a murder crime event');
  // the wounds tell: bruises at the throat
  const bodyObj = w.objects.get('body_jonas');
  ok(bodyObj && w.body.allOf('jonas').some((x) => x.partId === 'neck' && x.type === 'bruise'), 'the body shows bruises around the throat');
  ok(C('tomas').discovery?.deadId === 'jonas' && w.emotions.of(C('tomas')).some((e) => e.type === 'fear' && e.intensity >= 3), 'the killer fears discovery');
  const tp = buildMessages(w, C('tomas'))[1].content;
  ok(/# WHAT YOU'VE DONE[\s\S]*(choked|beat|pinned)[^\n]*Jonas[\s\S]*It stays with you/.test(tp) && /Nobody must find out/.test(tp), 'WHAT YOU\'VE DONE names it, and the fear of being found out');
  ok((C('tomas').onMyMind ?? []).some((m) => m.pinnedUntil > w.now), 'and it is pinned on his mind');
  endAll();
}

console.log('\n--- §2.2 tying up');
{
  reset('tomas'); reset('lena');
  const rope = hold('tomas', 'rope');
  w.applyAction(C('lena'), { name: 'sleep', arguments: { until_rested: true } });
  ok(actsOf('tomas').includes('tie_up'), 'tie_up offered with a cord in hand and someone helpless');
  act('tomas', 'lena', 'tie_up', { intent: 'subdue', with: w.objects.alias(rope) });
  ok(C('tomas').activity.detail?.act === 'tie_up' && Math.round((C('tomas').activity.until - w.now) * 10) / 10 === 2, 'tying takes two minutes');
  advance(2.25);
  ok(C('lena').phys.restraint?.kind === 'tied' && w.objects.get(rope.id).holderId === 'lena', 'tied: the rope is on her');
  ok(events('crime').some((e) => e.kind === 'unlawful_restraint'), 'unlawful restraint is a crime event');
  w.setActivity(C('lena'), { type: 'idle' });
  ok(JSON.stringify(actsOf('lena').sort()) === JSON.stringify(['break_free', 'plead', 'yield']) && !tool('lena', 'handle'), 'tied: she can only struggle, plead or yield');
  reset('anselm');
  ok(actsOf('anselm').includes('free'), 'someone else can free her');
  endAll();
  w.applyAction(C('anselm'), { name: 'act_on', arguments: { person: label('anselm', 'lena'), action: 'free' } });
  ok(!C('lena').phys.restraint, 'freed');
  endAll(); reset('lena'); reset('tomas'); reset('anselm');
}

console.log('\n--- §3 altercations');
{
  reset('greta'); reset('tomas'); reset('anselm'); reset('lena');
  move('greta', 'tavern');
  act('tomas', 'greta', 'punch', { intent: 'hurt', words: 'Pay day, is it?' });
  const alt = w.altercations.of('tomas');
  ok(alt && alt.participants.find((p) => p.id === 'tomas').side !== alt.participants.find((p) => p.id === 'greta').side && alt.participants.find((p) => p.id === 'tomas').intent === 'hurt', 'an altercation starts with sides and intents');
  const gIn = C('greta').inbox.find((s) => s.data?.altercation);
  ok(gIn?.importance === 9 && gIn.data.interrupt && chooseTier(C('greta'), { stimuli: [gIn] }, w).tier === 'full', 'the target gets a full-tier interrupt');
  const lIn = C('lena').inbox.find((s) => s.data?.altercation);
  ok(lIn?.importance === 8 && chooseTier(C('lena'), { stimuli: [lIn] }, w).reason === 'altercation', 'a bystander reacts at full on the first blow');
  const tIn = C('tomas').inbox.find((s) => s.data?.altercation);
  ok(tIn && chooseTier(C('tomas'), { stimuli: [tIn] }, w).tier === 'full', 'the aggressor decides the next act at full');
  // a friend holds the attacker back
  let held = false;
  for (let i = 0; i < 40 && !held; i++) { const rr = w.applyAction(C('anselm'), { name: 'act_on', arguments: { person: label('anselm', 'tomas'), action: 'hold_back', intent: 'care' } }); held = C('tomas').phys.restraint?.kind === 'held'; advance(0.3); }
  ok(held && w.altercations.part(w.altercations.of('tomas'), 'anselm')?.role === 'holder', 'Anselm holds Tomas back (and joins as the one holding)');
  ok(JSON.stringify(actsOf('tomas').sort()) === JSON.stringify(['break_free', 'plead', 'yield']), 'held back, Tomas can only break free, plead or yield (or speak)');
  answered(); advance(2.5);
  ok(!w.altercations.of('tomas') && w.altercations.list.find((a) => a.id === alt.id).endReason === 'separated', `it ends with a reason (${w.altercations.list.find((a) => a.id === alt.id).endReason})`);
  // yield, and the end when the other side stops
  reset('tomas'); reset('greta');
  act('tomas', 'greta', 'shove', { intent: 'scare' });
  w.applyAction(C('greta'), { name: 'act_on', arguments: { person: label('greta', 'tomas'), action: 'yield' } });
  ok(C('tomas').inbox.some((s) => /gives up/.test(s.text) && s.importance === 8), 'yielding is perceived');
  ok(/has given up\. Going on would be beating someone who yielded/.test(buildMessages(w, C('tomas'))[1].content), 'the attacker\'s prompt says so');
  answered(); advance(2.5);
  ok(w.altercations.list.at(-1).endReason === 'yielded', `ends: yielded (${w.altercations.list.at(-1).endReason})`);
  // fled
  reset('tomas'); reset('greta');
  act('tomas', 'greta', 'slap', { intent: 'scare' });
  move('greta', 'square');
  answered(); advance(0.5);
  ok(w.altercations.list.at(-1).endReason === 'fled', `ends: fled (${w.altercations.list.at(-1).endReason})`);
  move('greta', 'tavern');
  // cooled down
  reset('tomas'); reset('greta');
  act('tomas', 'greta', 'shove', { intent: 'scare' });
  answered(); advance(2.5);
  ok(w.altercations.list.at(-1).endReason === 'cooled', `ends: cooled (${w.altercations.list.at(-1).endReason})`);
  reset('tomas'); reset('greta');
  act('tomas', 'greta', 'shove', { intent: 'scare' });
  C('greta').lastDecisionAt = w.now - 5; // still thinking about it
  advance(3);
  ok(w.altercations.of('greta'), 'a fight does not "cool" while someone in it has not yet answered the last blow (decisions take real time)');
  answered(); advance(0.5);
  ok(!w.altercations.of('greta'), 'once everyone has answered, it can');
  ok(events('altercation_end').length >= 4, 'every end is logged with its reason');
}

console.log('\n--- §5 consequences');
{
  for (const id of ALL) if (C(id).alive) reset(id);
  move('lena', 'tavern'); move('anselm', 'tavern');
  w.relationships.change('anselm', 'greta', { affinity: 4 }, { reason: 'old friends', source: 'director' });
  const h = hold('tomas', 'hammer');
  let broke = false;
  for (let i = 0; i < 25 && !broke; i++) { act('tomas', 'greta', 'strike', { with: w.objects.alias(h), aim: 'left_arm', intent: 'hurt' }); broke = w.body.active('greta').some((x) => x.type === 'fracture'); advance(0.4); }
  ok(broke, 'Tomas breaks Greta\'s arm with his hammer');
  const tp = buildMessages(w, C('tomas'))[1].content;
  ok(/# WHAT YOU'VE DONE\n- [^\n]*you (beat|hit) Greta with your hammer, meaning to hurt her\. You broke her left/.test(tp), `WHAT YOU'VE DONE: "${(tp.match(/# WHAT YOU'VE DONE\n([^\n]*)/) ?? [])[1]}"`);
  ok(/You came at Greta to hurt her\./.test(tp), 'his intent stays in the prompt');
  ok(w.emotions.of(C('greta')).some((e) => e.type === 'fear' && e.target === 'tomas') && w.emotions.of(C('greta')).some((e) => e.type === 'anger' && e.target === 'tomas'), 'Greta: fear and anger aimed at him');
  const gRel = db.prepare("SELECT reason FROM relationship_events WHERE citizen_id = 'greta' AND other_id = 'tomas' ORDER BY id").all().map((r) => r.reason);
  ok(gRel.some((r) => /hit me with/.test(r)) && gRel.some((r) => /broke a bone/.test(r)), `relationship events with concrete reasons (${gRel.slice(-2).join(' | ')})`);
  const aRel = db.prepare("SELECT reason FROM relationship_events WHERE citizen_id = 'anselm' AND other_id = 'tomas' ORDER BY id DESC LIMIT 1").get();
  ok(/hit \{\{c:greta\}\}|hit Greta/.test(aRel?.reason ?? ''), `a witness holds it against him too (${aRel?.reason})`);
  ok(C('greta').wary?.tomas && /wary of him since he hit you/.test(buildMessages(w, C('greta'))[1].content), 'Greta is wary of him from now on');
  ok(events('crime').some((e) => e.kind === 'assault' && e.actor === 'tomas' && e.victimId === 'greta' && e.witnesses.includes('anselm')), 'an assault crime event with witnesses');
  // §5.3 the reversal needs a reason
  w.setActivity(C('tomas'), { type: 'idle' });
  const r1 = w.applyAction(C('tomas'), { name: 'act_on', arguments: { person: label('tomas', 'greta'), action: 'comfort' } });
  ok(!r1.ok && /meaning to hurt her\. If you mean to help now, say why/.test(r1.reason), `caring without a reason is refused: "${r1.reason}"`);
  const call = { name: 'act_on', arguments: { person: label('tomas', 'greta'), action: 'help_up' } };
  const msg = w.physical.consequences.coherenceCheck(C('tomas'), call);
  ok(/You meant to hurt her .* If you've changed your mind, say why/.test(msg ?? ''), `the plausibility guard asks once more: "${msg}"`);
  ok(!w.physical.consequences.coherenceCheck(C('tomas'), { name: 'act_on', arguments: { ...call.arguments, reason: "I didn't mean for it to go this far." } }), 'a stated change of mind passes');
  C('greta').inbox = [];
  C('greta').phys.prone = true;
  const r2 = w.applyAction(C('tomas'), { name: 'act_on', arguments: { person: label('tomas', 'greta'), action: 'help_up', reason: "I didn't mean for it to go this far." } });
  const seen = C('greta').inbox.find((s) => s.data?.reversal);
  ok(r2.ok && /Tomas, who (beat|hit) you (a moment ago|a few minutes ago|about \d+ minutes ago), reaches to help you up: "I didn't mean for it to go this far\."/.test(w.memory.resolveNames(C('greta'), seen?.text ?? '')), `Greta perceives it with the attack fresh: "${w.memory.resolveNames(C('greta'), seen?.text ?? '')}"`);
  ok(events('coherence').some((e) => e.kind === 'reversal' && e.reason), 'the reversal is in the coherence log');
  const rels = db.prepare("SELECT COUNT(*) n FROM relationship_events WHERE citizen_id = 'greta' AND other_id = 'tomas' AND d_affinity > 0").get().n;
  ok(rels === 0, 'help from the attacker resets nothing');
  // the aftermath when the fight is over
  endAll();
  const t = w.emotions.of(C('tomas'));
  ok(t.some((e) => e.type === 'fear') && (t.some((e) => e.type === 'pride') || t.some((e) => e.type === 'guilt')), `aftermath: adrenaline, then pride or guilt by personality (${t.map((e) => `${e.type} ${e.intensity.toFixed(1)}`).join(', ')})`);
  ok(events('aftermath').some((e) => e.actor === 'tomas'), 'logged as aftermath');
  ok(w.objects.get('tavern_door') && events('crime').length >= 3, 'crime events pile up for the law step');
}

console.log('\n--- §5.4 caring touch');
{
  for (const id of ['lena', 'anselm', 'greta', 'tomas']) reset(id);
  w.relationships.change('greta', 'anselm', { affinity: 5, trust: 4 }, { reason: 'an old friend', source: 'director' });
  w.emotions.bump(C('greta'), { type: 'sadness', target: null, delta: 6, cause: 'a hard day', source: 'director', raw: true });
  w.emotions.bump(C('greta'), { type: 'fear', target: null, delta: 5, cause: 'the dark', source: 'director', raw: true });
  const s0 = w.emotions.of(C('greta')).find((e) => e.type === 'sadness').intensity;
  w.applyAction(C('anselm'), { name: 'act_on', arguments: { person: label('anselm', 'greta'), action: 'embrace', intent: 'care' } });
  const s1 = w.emotions.of(C('greta')).find((e) => e.type === 'sadness')?.intensity ?? 0;
  ok(s1 < s0 && w.emotions.of(C('greta')).some((e) => e.type === 'affection' && e.target === 'anselm'), `a welcome embrace comforts (sadness ${s0.toFixed(1)} → ${s1.toFixed(1)}, affection up)`);
  w.relationships.change('lena', 'tomas', { affinity: -4, trust: -4 }, { reason: 'he frightens me', source: 'director' });
  C('lena').inbox = [];
  w.applyAction(C('tomas'), { name: 'act_on', arguments: { person: label('tomas', 'lena'), action: 'comfort', intent: 'care' } });
  w.setActivity(C('lena'), { type: 'idle' });
  ok(C('lena').inbox.some((s) => /You don't want it/.test(s.text)) && actsOf('lena').includes('pull_away'), 'unwelcome touch from someone distrusted: she can pull away');
  ok(db.prepare("SELECT COUNT(*) n FROM relationship_events WHERE citizen_id = 'lena' AND other_id = 'tomas' AND reason LIKE '%when I didn''t want it%'").get().n === 1, 'and a negative relationship event');
  w.applyAction(C('lena'), { name: 'act_on', arguments: { person: label('lena', 'tomas'), action: 'pull_away' } });
  ok(!C('lena').phys.touchedBy, 'pulled away');
  endAll();
}

console.log('\n--- §4 objects');
{
  for (const id of ['tomas', 'lena', 'anselm', 'greta']) reset(id);
  // a table pushed in front of a door blocks it; several can force it
  move('greta', 'house_greta'); move('anselm', 'square'); move('tomas', 'square'); move('lena', 'square');
  const table = [...w.objects.inRoom('house_greta')].find((o) => o.typeId === 'table');
  const door = w.objects.get('greta_door');
  w.objects.change(door.id, { state: 'closed' }, { actorId: 'director', action: 'state', notify: false });
  ok(tool('greta', 'handle')?.function.parameters.properties.action.enum.includes('push'), 'handle offers push for the table');
  handle('greta', table, 'push', { target: w.objects.alias(door) });
  ok(w.objects.get(table.id).data.barricade === door.id, 'the table is against the door');
  w.setActivity(C('tomas'), { type: 'idle' });
  const blocked = w.applyAction(C('tomas'), { name: 'move_to', arguments: { destination: 'house_greta' } });
  ok(!blocked.ok && /something heavy is pushed against it/.test(blocked.reason), `from outside: "${blocked.reason}"`);
  ok(tool('tomas', 'force_door')?.function.parameters.properties.destination.enum.includes('house_greta'), 'force_door is offered outside');
  let forced = false;
  for (let i = 0; i < 8 && !forced; i++) {
    for (const id of ['anselm', 'lena']) { w.setActivity(C(id), { type: 'doing', until: w.now + 1, detail: { kind: 'handle', handle: 'force', forcing: door.id, description: 'pushing', minutes: 1 } }); }
    w.setActivity(C('tomas'), { type: 'idle' });
    w.applyAction(C('tomas'), { name: 'force_door', arguments: { destination: 'house_greta' } });
    forced = !w.objects.get(table.id).data.barricade;
  }
  ok(forced, 'three of them force it (their strength adds up)');
  // a locked door needs its key
  w.objects.change(door.id, { state: 'locked' }, { actorId: 'director', action: 'state', notify: false });
  w.setActivity(C('tomas'), { type: 'idle' });
  const locked = w.applyAction(C('tomas'), { name: 'move_to', arguments: { destination: 'house_greta' } });
  ok(!locked.ok && /locked/.test(locked.reason), `a locked door: "${locked.reason}"`);
  ok(!tool('greta', 'handle')?.function.parameters.properties.action.enum.includes('unlock'), 'no key, no unlock');
  w.objects.change('greta_key', { holderId: 'greta' }, { actorId: 'director', action: 'give', notify: false });
  ok(tool('greta', 'handle')?.function.parameters.properties.action.enum.includes('unlock'), 'with her key: unlock');
  handle('greta', door, 'unlock', { with: w.objects.alias(w.objects.get('greta_key')) });
  ok(w.objects.get(door.id).state === 'closed', 'unlocked');
  // containers hide their contents
  const chest = w.objects.get('greta_chest');
  w.objects.change(chest.id, { state: 'open' }, { actorId: 'director', action: 'state', notify: false });
  const ledger = [...w.objects.byId.values()].find((o) => o.typeId === 'ledger');
  w.objects.change(ledger.id, { holderId: 'greta' }, { actorId: 'director', action: 'give', notify: false });
  handle('greta', chest, 'put_in', { with: w.objects.alias(ledger) });
  handle('greta', chest, 'close');
  ok(w.objects.get(ledger.id).placement?.of === chest.id && w.objects.effectivelyHidden(w.objects.get(ledger.id)), 'put in a closed chest: hidden');
  // a bucket filled at the well, poured on a fire
  move('lena', 'well');
  w.setActivity(C('lena'), { type: 'idle' });
  const bucket = hold('lena', 'bucket', { state: 'empty' });
  ok(tool('lena', 'handle')?.function.parameters.properties.action.enum.includes('fill'), 'at the well: fill');
  handle('lena', bucket, 'fill');
  ok(w.objects.get(bucket.id).state === 'full', 'the bucket is full');
  // lanterns matter at night
  w.clock.gameMinutes = 2 * 1440 + 23 * 60;
  move('tomas', 'house_tomas');
  for (const o of w.objects.inRoom('house_tomas')) if (['lit', 'hot'].includes(o.state)) w.objects.change(o.id, { state: w.objects.type(o).states.find((s) => ['unlit', 'cold'].includes(s)) }, { actorId: 'director', action: 'state', notify: false });
  ok(isDark(w, 'house_tomas'), 'a house at night without a light is dark');
  const pDark = combatProfile(w, C('tomas')).precision;
  ok(/It is dark in here/.test(buildMessages(w, C('tomas'))[1].content), 'the prompt says so');
  const candle = w.objects.get('tomas_candle');
  const torch = hold('tomas', 'torch', { state: 'lit' });
  handle('tomas', candle, 'light', { with: w.objects.alias(torch) });
  w.objects.change(torch.id, { roomId: 'smithy', placement: { relation: 'floor', of: null }, state: 'unlit' }, { actorId: 'director', action: 'move', notify: false });
  ok(w.objects.get(candle.id).state === 'lit' && !isDark(w, 'house_tomas') && combatProfile(w, C('tomas')).precision > pDark, 'a lit candle: light, and better aim');
  w.clock.gameMinutes = 2 * 1440 + 11 * 60;
}

console.log('\n--- §4.4 fire');
{
  for (const id of ['tomas', 'lena', 'anselm', 'greta']) if (C(id).alive) reset(id);
  move('tomas', 'bakery'); move('lena', 'bakery');
  const dread0 = w.deaths.dreadFor(C('tomas'));
  const torch = hold('tomas', 'torch', { state: 'lit' });
  const sack = [...w.objects.inRoom('bakery')].find((o) => o.typeId === 'flour_sack');
  ok(tool('tomas', 'handle')?.function.parameters.properties.action.enum.includes('ignite'), 'a lit torch in hand: ignite');
  C('lena').inbox = [];
  handle('tomas', sack, 'ignite', { with: w.objects.alias(torch) });
  ok(w.objects.get(sack.id).data.burning && C('lena').inbox.some((s) => /Fire!/.test(s.text) && s.importance === 9), 'a deliberate ignite starts a fire everyone sees');
  ok(events('crime').some((e) => e.kind === 'arson' && e.actor === 'tomas'), 'arson is a crime event');
  move('tomas', 'square'); // the one who set it slips out
  w.applyAction(C('lena'), { name: 'sleep', arguments: { until_rested: true } }); // asleep in the corner
  const out = () => ['collapsed', 'unconscious'].includes(C('lena').activity.type) || (C('lena').body.status ?? []).includes('unconscious');
  for (let i = 0; i < 40 && !(w.rooms.get('bakery').onFire); i++) advance(0.5, 0.5);
  const burningNow = w.physical.fire.burning('bakery').length;
  const burnt = [...w.objects.inRoom('bakery')].filter((o) => o.data?.burnt).length;
  ok(burningNow + burnt >= 2, `it spreads to nearby flammable things (${burningNow} burning, ${burnt} burnt)`);
  ok(w.rooms.get('bakery').onFire || events('room_fire').length, 'three burning things in a timber room: the room is on fire');
  ok((C('lena').phys.smoke ?? 0) > 0, `smoke builds (${C('lena').phys.smoke})`);
  let mins = 0;
  while (!out() && C('lena').alive && mins < 30) { advance(0.5, 0.5); mins += 0.5; }
  ok(out() && C('lena').alive, `heavy smoke knocks people out (${C('lena').activity.type}, smoke ${C('lena').phys.smoke}, alive ${C('lena').alive})`);
  if (C('lena').alive) { move('lena', 'square'); C('lena').phys.smoke = 0; w.body.recompute(C('lena')); } // carried out
  ok(w.deaths.dreadFor(C('tomas')) > dread0 && events('fire_start').length > 0, 'dread rises');
  ok(w.decals.list().some((d) => d.kind === 'soot' || d.kind === 'scorch'), 'soot and scorch marks');
  // put it out
  move('anselm', 'bakery'); move('greta', 'bakery');
  for (const id of ['anselm', 'greta']) { C(id).phys = {}; w.setActivity(C(id), { type: 'idle' }); }
  let rounds = 0;
  while (w.physical.fire.burning('bakery').length && rounds < 40) {
    rounds++;
    const b = hold('anselm', 'bucket', { state: 'full' });
    handle('anselm', b, 'pour');
    C('anselm').phys.smoke = 0;
  }
  ok(!w.physical.fire.burning('bakery').length, `buckets of water put it out (${rounds} buckets)`);
  ok(!w.rooms.get('bakery').onFire && w.rooms.get('bakery').effects.some((e) => /blackened/.test(e.text)), 'the room fire is out; the walls are blackened');
  // smother a small fire
  const cloth = [...w.objects.byId.values()].find((o) => o.typeId === 'cloth');
  const basket = [...w.objects.inRoom('tavern')].find((o) => phys(w, o).flammable && (w.objects.type(o)?.size ?? 1) === 1) ?? [...w.objects.byId.values()].find((o) => o.typeId === 'basket');
  move('greta', basket.roomId);
  w.physical.fire.ignite(basket, { cause: 'test' });
  w.objects.change(cloth.id, { holderId: 'greta' }, { actorId: 'director', action: 'give', notify: false });
  w.setActivity(C('greta'), { type: 'idle' });
  handle('greta', w.objects.get(basket.id), 'smother', { with: w.objects.alias(cloth) });
  ok(!w.objects.get(basket.id).data.burning, 'a cloth smothers a small fire');
  // the free-form path: "use the cloth to smother the flames" (as a GLM fire day tried it) does it
  w.physical.fire.ignite(w.objects.get(basket.id).data.burnt ? [...w.objects.inRoom(basket.roomId)].find((o) => phys(w, o).flammable && !o.data?.burning && !o.data?.burnt && (w.objects.type(o)?.size ?? 1) === 1) : w.objects.get(basket.id), { cause: 'test' });
  const burningNow2 = w.physical.fire.burning(basket.roomId)[0];
  w.setActivity(C('greta'), { type: 'idle' });
  const ru = w.applyAction(C('greta'), { name: 'use', arguments: { object: w.objects.alias(cloth), intent: 'smother the flames with the cloth' } });
  ok(ru.ok && burningNow2 && !w.objects.get(burningNow2.id).data.burning, 'use(cloth, "smother the flames") puts the fire out');
  // a knocked-over lantern
  move('tomas', 'tavern'); move('anselm', 'tavern');
  for (const id of ['tomas', 'anselm']) reset(id);
  const lantern = w.objects.get('tavern_lantern');
  w.objects.change(lantern.id, { state: 'lit', placement: { relation: 'floor', of: null }, data: { ...lantern.data, spot: C('anselm').spot } }, { actorId: 'director', action: 'state', notify: false });
  const stool = w.objects.get('tavern_stool_1');
  w.objects.change(stool.id, { placement: { relation: 'floor', of: null }, data: { ...stool.data, spot: C('anselm').spot } }, { actorId: 'director', action: 'move', notify: false });
  let caught = false;
  for (let i = 0; i < 30 && !caught; i++) {
    C('anselm').phys.prone = false;
    w.objects.change(lantern.id, { state: 'lit' }, { actorId: 'director', action: 'state', notify: false });
    w.applyAction(C('anselm'), { name: 'sleep', arguments: { until_rested: true } });
    act('tomas', 'anselm', 'shove', { intent: 'scare' });
    caught = events('light_knocked_over').some((e) => e.caught);
    endAll();
  }
  ok(caught, 'someone knocked down by a lit lantern can set things alight');
}

console.log('\n--- §6 killing a sleeper');
{
  for (const id of ['tomas', 'anselm', 'lena']) if (C(id).alive) reset(id);
  move('anselm', 'house_lena'); move('lena', 'house_lena'); move('tomas', 'square');
  for (const b of w.physical.fire.burning()) w.physical.fire.extinguish(b);
  w.applyAction(C('lena'), { name: 'sleep', arguments: { until_rested: true } });
  w.applyAction(C('anselm'), { name: 'sleep', arguments: { until_rested: true } });
  const knife = w.objects.get('lena_hunting_knife');
  w.objects.change(knife.id, { holderId: 'anselm' }, { actorId: 'director', action: 'give', notify: false });
  w.setActivity(C('anselm'), { type: 'idle' });
  let n = 0;
  while (C('lena').alive && n < 20) { n++; w.setActivity(C('anselm'), { type: 'idle' }); w.applyAction(C('anselm'), { name: 'act_on', arguments: { person: label('anselm', 'lena'), action: 'strike', with: w.objects.alias(knife), intent: 'kill', aim: n % 2 ? 'torso' : 'neck' } }); advance(0.5); }
  let waited = 0;
  while (C('lena').alive && waited < 120) { advance(1, 0.5); waited++; } // the wounds do the rest
  ok(!C('lena').alive, `a deliberate kill on a sleeping target is possible (${n} blows, dead ${waited} minutes later)`);
  ok(w.body.allOf('lena').some((x) => ['puncture', 'cut'].includes(x.type)), 'the body has stab or cut wounds');
  ok(events('crime').some((e) => e.kind === 'murder' && e.actor === 'anselm'), 'murder is logged');
  move('tomas', 'house_lena');
  advance(1);
  ok(w.deaths.knows(C('tomas'), 'lena') || /very still/.test(C('tomas').inbox.map((s) => s.text).join(' ')), 'whoever comes in finds her');
  ok(C('anselm').discovery?.deadId === 'lena', 'the killer fears discovery while she lies unburied');
}

console.log('\n--- the read models');
{
  const v = w.physical.profileView(C('anselm'));
  ok(v.profile && Array.isArray(v.weapons) && v.deeds.length && v.deeds[0].text, 'inspector view: profile, carried weapons, deeds with text');
  ok(Array.isArray(w.altercations.view()) && w.altercations.view().every((a) => a.participants.every((p) => Array.isArray(p.state))), 'altercation panel view');
}

console.log(`\n${pass} passed, ${fail} failed`);
w.stop();
process.exit(fail ? 1 : 0);
