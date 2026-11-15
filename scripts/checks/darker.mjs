// Step 11.5 self-check: characters true to their worst sides (A: grievances, author framing, the five choices,
// flaws and grudge), hunger and feeding (B: the days-without-food clock, stages, faint spells, meals, visibility) and
// crime classification (C: care, defence, unwanted touch, deaths not from the act). No LLM.
//   node --disable-warning=ExperimentalWarning scripts/checks/darker.mjs <repoRoot> [dataDir]
import fs from 'node:fs';
import path from 'node:path';
const [,, rootArg = process.cwd(), dataDir = `${process.env.TEMP ?? '/tmp'}/aw-darker115`] = process.argv;
const root = path.resolve(rootArg).split(path.sep).join('/');
fs.rmSync(dataDir, { recursive: true, force: true });
Object.assign(process.env, { DATA_DIR: dataDir, SCENARIO: 'village', LLM_BASE_URL: 'http://localhost:9/v1', SPOT_WALKING: 'false', SPEECH_CHARS_PER_SECOND: '0' });
const imp = (p) => import(`file:///${root}/${p}`);
const { openDb, migrate } = await imp('server/db.js');
const { World } = await imp('server/world.js');
const { buildMessages } = await imp('server/agents/prompt.js');
const { buildTools } = await imp('server/agents/tools.js');
const { grievanceBlock, grievanceAgainst, topGrievances } = await imp('server/scheming/grievances.js');
const { CHOICES } = await imp('server/scheming/schemes.js');
const starvation = await imp('server/body/starvation.js');
const { combatProfile } = await imp('server/physical/profile.js');
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) pass++; else fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const db = openDb(); await migrate(db);
const w = new World(db);
w.scheduler.run = () => {}; w.scheduler.poke = () => {}; w.clock.running = true; w.habits.ensure = () => {};
const C = (id) => w.citizens.get(id);
const move = (id, to) => w.directorEvent({ effects: [{ type: 'move', target: id, to, notify: false }] });
const label = (a, b) => [...w.memory.labelsFor(C(a), [C(b)]).keys()][0];
const events = (type) => db.prepare('SELECT actor_id, data FROM events WHERE type = ? ORDER BY id').all(type).map((r) => ({ actor: r.actor_id, ...JSON.parse(r.data) }));
const tool = (id, name) => buildTools(w, C(id)).find((t) => t.function.name === name);
w.clock.gameMinutes = 2 * 1440 + 10 * 60; // day 3, 10:00
for (const c of w.citizens.values()) if (c.needs) { c.needs.fedAt = w.now - 120; c.needs.hunger = 10; }
for (const id of ['tomas', 'jonas', 'lena', 'anselm', 'greta']) move(id, 'tavern');

console.log('--- A: grievances, author framing, choices, flaws');
{
  const j = C('jonas');
  // a beating in front of people, through the step-10 path
  w.logEvent('physical', { actorId: 'tomas', location: 'tavern', targetId: 'jonas', act: 'punch', hit: true, part: 'head', effects: ['knocked down'], intent: 'hurt', words: 'Stay down, boy.' });
  w.logEvent('crime', { actorId: 'tomas', location: 'tavern', kind: 'assault', victimId: 'jonas', witnesses: ['lena', 'anselm'], severity: 2 });
  w.body.damage('jonas', { damageType: 'blunt', part: 'head', amount: 4, cause: "Tomas's fist", sourceId: 'tomas' });
  w.relationships.change('jonas', 'tomas', { affinity: -3, trust: -3 }, { reason: 'Tomas knocked me down in the Tilted Cup in front of everyone.', source: 'witness' });
  w.emotions.bump(j, { type: 'anger', target: 'tomas', delta: 7, cause: 'the beating', source: 'director', raw: true });
  const g = grievanceAgainst(w, j, 'tomas');
  ok(g.score >= 5, `a beating is a grievance (score ${g.score.toFixed(1)})`);
  const block = grievanceBlock(w, j, 'tomas', { voice: 'first', heading: '# WHAT TOMAS DID', named: false });
  ok(/punched me/.test(block) && /Stay down, boy/.test(block) && /saw it/.test(block), 'the grievance is told as it happened: the act, the words, who saw');
  ok(/I still feel it/.test(block) && /knocked me down in the Tilted Cup/.test(block), 'wounds still felt and what it cost, in the first person');
  ok(!/conflict/i.test(block), 'not softened into "a conflict"');
  ok(topGrievances(w, j).some((x) => x.id === 'tomas'), 'topGrievances finds him');
  const built = await w.scheming.schemes.buildPlanCall(j, null, 'test', { aboutId: 'tomas' });
  const sys = built.messages[0].content; const user = built.messages[1].content;
  ok(/author of one villager's inner life/.test(sys) && !/^You are Jonas/m.test(sys), 'planning: author framing, not "You are Jonas"');
  ok(sys.startsWith('# HOW THIS WORKS\nYou are the author'), 'the static author part comes first (prefix cache)');
  const enumC = built.tools[0].function.parameters.properties.choice.enum;
  ok(JSON.stringify(enumC) === JSON.stringify(CHOICES), `five equal choices in a fixed order (${enumC.join(', ')})`);
  ok(/1\. confront[\s\S]*2\. get_even[\s\S]*3\. go_to_others[\s\S]*4\. wait_and_watch[\s\S]*5\. let_go/.test(user) && /equal options; none is the right one/.test(user), 'the options are listed as equals');
  ok(built.tools[0].function.parameters.required.includes('why'), '`why` is required');
  ok(!/Many people would rather wait and see/.test(user), 'the step-11 "no plan is common" wording is gone');
  ok(/# WHAT TOMAS DID/.test(user) && /punched me/.test(user), 'the grievance is in the planning input');
  // choices applied
  const S = w.scheming.schemes;
  S.applyChoice(j, null, { choice: 'confront', why: 'He knocked me down in front of everyone.', how: 'Tell him to his face at the forge.' }, { ...built, trigger: 'test' });
  ok((j.intentions ?? []).some((i) => i.source === 'resolve' && /Tell him to his face/.test(i.text) && i.about.includes('tomas')), 'confront becomes an intention the decisions carry');
  ok(events('scheme_choice').some((e) => e.actor === 'jonas' && e.choice === 'confront' && e.targetId === 'tomas'), 'the choice is logged');
  ok(j.grievanceChoices?.tomas?.choice === 'confront', 'and remembered, so the same grievance is not asked about again');
  ok(S.grievanceToDecide(j) == null, 'no new planning call about the same grievance');
  const before = w.scheming.ambitions.of('jonas').length;
  const r2 = S.applyChoice(j, null, { choice: 'get_even', why: 'He made me small.', goal: "Ruin Tomas's name with the miller.", steps: [{ text: 'Tell the miller Tomas waters his iron', kind: 'talk' }, { text: 'Leave the bent tongs where the miller will see', kind: 'act' }] }, { ...built, trigger: 'test' });
  ok(r2?.schemeId && S.get(r2.schemeId)?.targetIds.includes('tomas'), 'get_even with steps becomes a scheme aimed at him');
  ok(w.scheming.ambitions.of('jonas').length === before + 1 && w.scheming.ambitions.of('jonas').some((a) => a.kind === 'revenge' && a.origin === 'grievance'), 'with a revenge ambition behind it');
  S.applyChoice(C('lena'), null, { choice: 'let_go', why: "He's not worth the grief." }, { ...built, aboutId: 'tomas', trigger: 'test' });
  ok(db.prepare("SELECT 1 FROM memories WHERE citizen_id = 'lena' AND text LIKE '%let%go%' LIMIT 1").get(), 'let it go is remembered (a memory), not a gap');
  const cut = S.applyChoice(C('anselm'), null, { choice: 'get_even', why: 'x', goal: 'Something' }, { ...built, aboutId: 'tomas', trigger: 'test' });
  ok(cut == null && events('scheme_none').some((e) => e.actor === 'anselm' && e.cutOff), 'a plan without steps is a cut-off, not a choice');
  // flaws, grudge
  w.scheming.traits.set(C('greta'), { grudge: 9, flaws: [{ flaw: 'vindictive', serious: true }], worst_self: 'When she is cheated, she never lets it go.' }, 'test');
  const msgs = buildMessages(w, C('greta'), { tier: 'full' });
  const sysG = msgs[0].content;
  ok(/Your faults: vindictive/.test(sysG) && /At your worst: When she is cheated/.test(sysG), 'faults and worst self in their own prompt');
  ok(/never forget a wrong/.test(sysG), 'grudge in words');
  ok(/Act as this person would, not as a good example would\./.test(sysG), 'A6: the one decision line');
  const call = w.scheming.traits.buildCall(C('greta'));
  ok(call.purpose === 'persona_flaws' && !call.tools[0].function.parameters.properties.honesty, 'a citizen with traits gets persona_flaws (honesty and cunning kept)');
  ok(/about one in five people has a serious flaw/.test(call.messages[0].content), 'the cast context keeps about one in five');
  // grudge slows anger toward a person
  const decay = (grudge) => {
    const c = C('anselm'); c.persona.traits.grudge = grudge; c.emotions = [];
    w.emotions.bump(c, { type: 'anger', target: 'tomas', delta: 6, cause: 'x', source: 'director', raw: true });
    for (let i = 0; i < 4; i++) w.emotions.tick(60, w.now);
    return w.emotions.get(c, 'anger', 'tomas')?.intensity ?? 0;
  };
  const hi = decay(10); const lo = decay(1);
  ok(hi > lo, `grudge 10 keeps anger longer than grudge 1 (${hi.toFixed(2)} vs ${lo.toFixed(2)})`);
}

console.log('--- B: hunger and feeding');
{
  const t = C('tomas');
  move('tomas', 'house_tomas');
  t.needs.fedAt = w.now - 2 * 1440; t.needs.hunger = 100;
  ok(starvation.stageName(w, t) === 'fed' && starvation.vitalityDrain(w, t) === 0, 'two days without food: hungry, not starving (no vitality drain)');
  const vit = t.body.vitality;
  for (let i = 0; i < 48; i++) w.body.tick?.(60, w.now);
  ok(t.alive && t.body.vitality >= vit - 1, `a full urge for two more game days does not kill (vitality ${Math.round(t.body.vitality)})`);
  t.needs.fedAt = w.now - 3.2 * 1440; t.needs.starveRecover = null;
  ok(starvation.stageName(w, t) === 'weak' && starvation.forceFactor(w, t) < 1 && starvation.fatigueFactor(w, t) > 1, 'three days: weak (less force, tires faster)');
  const full = combatProfile(w, C('jonas'), C('tomas')).force; const weakF = combatProfile(w, t, C('jonas')).force;
  ok(weakF < full * 1.2, `combatProfile carries it (force ${weakF} vs ${full})`);
  ok(/pale and shaking/.test(starvation.cueFor(w, t)), 'others can see it');
  t.needs.fedAt = w.now - 7.5 * 1440;
  ok(starvation.stageName(w, t) === 'faint' && starvation.healFactor(w, t) < 1, 'seven days: faint spells, slower healing');
  ok(starvation.maybeFaint(w, t, { rng: () => 0 }) && t.activity.type === 'collapsed' && t.activity.detail?.reason === 'fainted', 'a faint spell when exerting');
  w.clock.gameMinutes += 20; starvation.tick(w, t);
  ok(t.activity.type !== 'collapsed', 'and it passes');
  t.needs.fedAt = w.now - 15 * 1440;
  ok(starvation.vitalityDrain(w, t) > 0 && starvation.illnessFactor(w, t) > 1, 'fourteen days: vitality fails, illness comes easier');
  ok(t.alive, `alive at 15 days (death at ${starvation.deathDays()})`);
  // host
  move('jonas', 'house_tomas'); C('jonas').home = 'house_tomas';
  const roof = buildMessages(w, C('jonas'), { tier: 'full' })[1].content;
  ok(/# UNDER YOUR ROOF[\s\S]*needs food/.test(roof), 'the host is told someone under their roof needs food');
  // meals
  move('jonas', 'bakery'); move('greta', 'bakery');
  const stock0 = w.stock.level('bakery', 'food');
  ok(tool('jonas', 'take_meal'), 'take_meal at the bakery while Greta is there');
  w.setActivity(C('jonas'), { type: 'idle' });
  const res = w.applyAction(C('jonas'), { name: 'take_meal', arguments: {} });
  const meal = w.objects.carriedBy('jonas').find((o) => o.typeId === 'meal');
  ok(res?.ok && meal && meal.origin === 'code' && meal.data?.from === 'bakery', 'a portion is handed over (service output, made by code)');
  ok(w.stock.level('bakery', 'food') === stock0 - 1, 'out of real stock');
  move('greta', 'well');
  ok(!tool('jonas', 'take_meal'), 'no take_meal when nobody is there to serve');
  move('jonas', 'house_tomas');
  ok(tool('jonas', 'feed'), 'feed offered at home with the portion');
  w.setActivity(C('jonas'), { type: 'idle' });
  const fed = w.applyAction(C('jonas'), { name: 'feed', arguments: { who: label('jonas', 'tomas') } });
  ok(fed?.ok && starvation.daysWithout(w, t) < 0.01 && !w.objects.get(meal.id), 'Tomas is fed at home; the clock resets; the portion is gone');
  w.clock.gameMinutes += 360;
  ok(starvation.stageOf(w, t) > 0 && starvation.stageOf(w, t) < 3, `the effects lift over the next day (stage ${starvation.stageOf(w, t).toFixed(2)} six hours after the meal)`);
  w.clock.gameMinutes += 1200;
  ok(starvation.stageOf(w, t) === 0, 'and are gone a day later');
  // spoiling
  move('jonas', 'bakery'); move('greta', 'bakery'); w.setActivity(C('jonas'), { type: 'idle' });
  w.applyAction(C('jonas'), { name: 'take_meal', arguments: {} });
  const m2 = w.objects.carriedBy('jonas').find((o) => o.typeId === 'meal');
  w.clock.gameMinutes += 400; w.meals.last = -Infinity; w.meals.tick();
  ok(w.objects.get(m2.id).state === 'spoiled', 'a portion spoils after six hours');
}

console.log('--- C: crime classification');
{
  for (const id of ['tomas', 'jonas', 'lena', 'anselm']) { move(id, 'square'); const c = C(id); c.phys = {}; c.deeds = []; c.intents = {}; c.emotions = []; w.setActivity(c, { type: 'idle' }); }
  const crimes0 = events('crime').length;
  w.setActivity(C('lena'), { type: 'idle' });
  w.applyAction(C('lena'), { name: 'act_on', arguments: { person: label('lena', 'jonas'), action: 'grab', intent: 'care', reason: 'pulling him back from the well' } });
  ok(events('crime').length === crimes0, 'a grab meant as care is never a crime');
  ok(!(C('lena').deeds ?? []).length, 'and not a deed');
  ok(events('touch').some((e) => e.actor === 'lena' && e.rough), 'it is a touch, welcome or not');
  // defence against an aggressor
  for (const id of ['tomas', 'anselm']) { const c = C(id); c.phys = {}; c.deeds = []; w.setActivity(c, { type: 'idle' }); }
  for (let i = 0; i < 6 && !events('crime').some((e) => e.actor === 'tomas' && e.victimId === 'anselm'); i++) { w.setActivity(C('tomas'), { type: 'idle' }); w.applyAction(C('tomas'), { name: 'act_on', arguments: { person: label('tomas', 'anselm'), action: 'shove', intent: 'hurt' } }); }
  const n1 = events('crime').length;
  w.setActivity(C('anselm'), { type: 'idle' });
  w.applyAction(C('anselm'), { name: 'act_on', arguments: { person: label('anselm', 'tomas'), action: 'shove', intent: 'defend' } });
  ok(!events('crime').slice(n1).some((e) => e.actor === 'anselm'), 'defending against the aggressor is no crime');
  w.setActivity(C('anselm'), { type: 'idle' });
  const n2 = events('crime').length;
  for (let i = 0; i < 6 && !events('crime').slice(n2).length; i++) { w.setActivity(C('anselm'), { type: 'idle' }); w.applyAction(C('anselm'), { name: 'act_on', arguments: { person: label('anselm', 'jonas'), action: 'shove', intent: 'defend' } }); }
  ok(events('crime').slice(n2).some((e) => e.actor === 'anselm' && e.victimId === 'jonas' && e.claimed === 'self-defense'), '"defending" against someone who did nothing: assault, claimed self-defense');
  // a starvation death is nobody's
  const k0 = events('crime').filter((e) => ['murder', 'manslaughter'].includes(e.kind)).length;
  C('jonas').deeds = [{ id: 'x', at: w.now, lastAt: w.now, victimId: 'greta', altId: null, acts: { shove: 1 }, with: [], effects: [], parts: [], intent: 'hurt', serious: false, until: w.now + 60, place: 'square', pinned: false }];
  w.physical.consequences.onDeath(C('greta'), { cause: 'starvation' });
  ok(events('crime').filter((e) => ['murder', 'manslaughter'].includes(e.kind)).length === k0, 'a death from hunger is not blamed on a shove the day before');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
