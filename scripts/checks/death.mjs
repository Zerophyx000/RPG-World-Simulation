// Step 9.5 check: reactive living and death that matters. In-process world, no LLM (habit generation falls back to
// code defaults). Reproduces the day-15 sequence — two deaths in the bakery at night, the others elsewhere — and walks
// through finding, telling, grief, fear, customs, decay and consequences, plus intentions, habits, tiers and the governor.
import fs from 'node:fs';
const [,, root = process.cwd(), dataDir = `${process.env.TEMP ?? '/tmp'}/aw-death95`] = process.argv;
fs.rmSync(dataDir, { recursive: true, force: true });
Object.assign(process.env, { DATA_DIR: dataDir, SCENARIO: 'village', LLM_BASE_URL: 'http://localhost:9/v1', SPOT_WALKING: 'false', GOVERNOR_MIN_STATE_MINUTES: '10' });
const imp = (p) => import(`file:///${root}/${p}`);
const { openDb, migrate } = await imp('server/db.js');
const { World } = await imp('server/world.js');
const { buildMessages } = await imp('server/agents/prompt.js');
const { buildTools } = await imp('server/agents/tools.js');
const { chooseTier } = await imp('server/agents/tiers.js');
const { findLeaks } = await imp('server/social/leak.js');
const { parseFeeling } = await imp('server/emotions/report.js');
const { feelingPeople } = await imp('server/emotions/report.js');
const { applyEdits, fade, addIntention } = await imp('server/agents/intentions.js');
const { Governor } = await imp('server/agents/governor.js');
const { fallbackUse } = await imp('server/keeper/index.js');
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) pass++; else fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const db = openDb(); await migrate(db);
const w = new World(db);
w.scheduler.run = () => {}; w.scheduler.poke = () => {}; w.clock.running = true;
w.habits.ensure = () => {};
for (const c of w.citizens.values()) { c.thinkCooldownUntil = 1e9; }
const C = (id) => w.citizens.get(id);
const keepFed = () => { for (const c of w.citizens.values()) if (c.alive && c.needs) { c.needs.hunger = Math.min(c.needs.hunger, 10); c.needs.fatigue = Math.min(c.needs.fatigue, 20); } };
const advance = (m, step = 0.5) => { for (let t = 0; t < m; t += step) { w.clock.gameMinutes += step; for (const h of [...w.clock.handlers]) h(step, w.clock.gameMinutes); keepFed(); } };
const move = (id, to) => w.directorEvent({ effects: [{ type: 'move', target: id, to, notify: false }] });
const act = (id, name, args) => w.applyAction(C(id), { name, arguments: args });
const prompt = (id) => { const m = buildMessages(w, C(id)); return { text: `${m[0].content}\n${m[1].content}`, user: m[1].content }; };
const leaks = (id) => { const p = prompt(id).text; const t = JSON.stringify(buildTools(w, C(id))); return findLeaks(w, `${p}\n${t}`, id).filter((l) => l.kind === 'unknownDeath'); };
const inbox = (id) => [...C(id).inbox, ...C(id).thinkingInbox].map((s) => s.text).join(' | ');
const clear = (id) => { C(id).inbox = []; C(id).thinkingInbox = []; };
const alias = (o) => w.objects.alias(o);

console.log('\n--- C1: caps, governor, doors, feelings');
const { TIER_MAX_TOKENS } = await imp('server/llm.js');
ok(TIER_MAX_TOKENS.full === 3000 && TIER_MAX_TOKENS.light === 1000 && TIER_MAX_TOKENS.none === 300, `tier caps ${JSON.stringify(TIER_MAX_TOKENS)}`);
ok(w.governor.budget === 1000000, `token budget ${w.governor.budget}`);
ok(Governor.target('green', 0.74) === 'green' && Governor.target('green', 0.76) === 'yellow' && Governor.target('yellow', 0.7) === 'yellow' && Governor.target('yellow', 0.6) === 'green'
  && Governor.target('red', 0.9) === 'red' && Governor.target('red', 0.8) === 'yellow' && Governor.target('yellow', 1.0) === 'red', 'hysteresis: yellow 75/65, red 100/85');
{
  const g = w.governor; g.budget = 100; g.enteredAt = 0; g.samples.set('school', [{ t: Date.now(), tokens: 101 }]); g.evaluate(); const s1 = g.state;
  g.samples.set('school', [{ t: Date.now(), tokens: 70 }]); g.evaluate(); const s2 = g.state;
  g.samples.set('school', [{ t: Date.now(), tokens: 10 }]); g.evaluate(); const s3 = g.state;
  ok(s1 === 'red' && s2 === 'red' && s3 === 'green', `holds a state 10 min unless it falls below 50% (${s1} → ${s2} → ${s3})`);
  g.state = 'red'; g.enteredAt = Date.now();
  ok(g.adjust({ tier: 'full', protect: true }).tier === 'full' && g.adjust({ tier: 'full', maxTokens: 3000 }).maxTokens === 3000 && g.adjust({ tier: 'full' }).tier === 'light', 'red: protected full stays full, no 1,200 cap, others go light');
  g.state = 'green'; g.budget = 1000000; g.samples.set('school', []);
}
const door = w.objects.get('tomas_door');
ok(fallbackUse(w, door, 'bar the door').newState === 'barred' && fallbackUse(w, { ...door, state: 'open' }, 'wedge it shut').newState === 'barred' && fallbackUse(w, door, 'lock it').newState === 'locked', 'keeper fallback: bar / wedge it shut / lock it');
w.objects.change('tomas_door', { state: 'barred' }, { actorId: 'code', action: 'state', notify: false });
move('anselm', 'square'); clear('anselm');
const barredIn = act('anselm', 'move_to', { destination: 'house_tomas' });
ok(!barredIn.ok && /barred from the inside/.test(barredIn.reason), `a barred door keeps people out: "${barredIn.reason}"`);
w.objects.change('tomas_door', { state: 'closed' }, { actorId: 'code', action: 'state', notify: false });
const people = feelingPeople(w, C('lena'));
const rep = parseFeeling(w, C('lena'), `{"emotion":"sadness","target":"Greta","direction":"stronger","amount":2,"why":"she is gone"`, people);
ok(rep?.type === 'sadness' && rep.target === 'greta', 'a broken feeling (missing brace) is repaired and aimed');

console.log('\n--- B1: day 15 — two deaths in the bakery at night, the others elsewhere');
w.clock.gameMinutes = Math.floor(w.now / 1440) * 1440 + 1440 + 2 * 60; // 02:00 next night
move('greta', 'bakery'); move('jonas', 'bakery'); move('tomas', 'house_tomas'); move('lena', 'house_lena'); move('anselm', 'tavern');
for (const id of ['tomas', 'lena', 'anselm']) { w.applyAction(C(id), { name: 'sleep', arguments: { until_rested: true } }); }
for (const id of ['greta', 'jonas']) w.setActivity(C(id), { type: 'idle' });
w.body.die(C('greta'), { cause: 'bled out from a gash in the spine', reason: 'blood' });
ok(!C('greta').alive && w.objects.get('body_greta'), 'Greta dies in the bakery; a body object lies there');
ok(w.deaths.entry(C('jonas'), 'greta')?.how === 'witnessed' && w.deaths.griefFor(C('jonas'), 'greta') >= 0, 'Jonas was there awake: witnessed, certain');
ok(['tomas', 'lena', 'anselm'].every((id) => !w.deaths.knows(C(id), 'greta')), 'nobody else knows');
ok(['tomas', 'lena', 'anselm'].every((id) => !w.emotions.of(C(id)).some((e) => e.target === 'greta' && e.data?.grief)), 'no grief anywhere else (step 7 grieved everyone at once)');
ok(!w.memory.nameFor(C('lena'), 'greta').includes('dead') && w.memory.nameFor(C('jonas'), 'greta').includes('(dead)'), `"(dead)" only for those who know: lena "${w.memory.nameFor(C('lena'), 'greta')}", jonas "${w.memory.nameFor(C('jonas'), 'greta')}"`);
advance(60);
w.body.die(C('jonas'), { cause: 'bled out from a fracture in the right forearm', reason: 'blood' });
advance(5);
ok(['tomas', 'lena', 'anselm'].every((id) => !w.deaths.knows(C(id), 'jonas') && !w.deaths.knows(C(id), 'greta')), 'the second death: still nobody knows');
ok(['tomas', 'lena', 'anselm'].every((id) => leaks(id).length === 0), `leak check: no unknown death in their prompts or tools (${['tomas', 'lena', 'anselm'].map((id) => leaks(id).length).join('/')})`);

console.log('\n--- B1/B2: finding');
for (const id of ['tomas', 'lena', 'anselm']) w.applyAction(C(id), { name: 'wait', arguments: { reason: 'up', minutes: 1 } });
w.setActivity(C('lena'), { type: 'idle' }); clear('lena');
move('lena', 'bakery'); advance(2);
ok(w.deaths.certainty(C('lena'), 'greta') === 'suspected' && /Greta is lying very still/.test(inbox('lena')), `Lena walks in: "${inbox('lena').match(/Greta is lying[^|]*/)?.[0]}"`);
ok(!w.deaths.knows(C('lena'), 'greta') && w.deaths.griefFor(C('lena'), 'greta') === 0 && leaks('lena').length === 0, `suspected is not knowing: no grief yet, no leak ${JSON.stringify(leaks('lena'))}`);
const bodyHandle = alias(w.objects.get('body_greta'));
{
  const u = prompt('lena').user; const here = (u.split("# WHAT'S HERE")[1] ?? '').split('\n# ')[0];
  ok(buildTools(w, C('lena')).some((t) => t.function.name === 'tend_body') && here.includes('Greta, lying very still on the floor'), `WHAT'S HERE: ${here.split('\n').find((l) => /Greta|stranger|still/.test(l))?.trim()}; tend_body offered`);
}
clear('lena');
act('lena', 'examine', { object: bodyHandle }); advance(3);
ok(w.deaths.entry(C('lena'), 'greta')?.certainty === 'certain' && /Greta is dead/.test(inbox('lena')), `examined: "${inbox('lena').match(/[^|]*Greta is dead\./)?.[0]?.trim()}"`);
const lenaGrief = w.deaths.griefFor(C('lena'), 'greta');
ok(lenaGrief >= 5, `Lena's grief starts now, aimed at Greta (${lenaGrief.toFixed(1)}; affinity 2 → 6)`);
ok((C('lena').onMyMind ?? []).some((m) => m.deathOf === 'greta' && /at the bakery/.test(m.text) && m.pinnedUntil > w.now + 6 * 1440), 'pinned on her mind for 7 days, with the place');
ok(w.deaths.mortalityFear(C('lena')) > 0, `fear for her own life (${w.deaths.mortalityFear(C('lena')).toFixed(1)})`);
ok(chooseTier(C('lena'), { stimuli: [{ kind: 'timer', importance: 3, data: {} }] }, w).tier === 'full', 'a grieving, frightened Lena decides at full');
ok(prompt('lena').user.includes('Greta (dead)') || prompt('lena').user.includes("Greta's body"), 'her prompt now names Greta as dead');
const fp = buildTools(w, C('lena'))[0].function.parameters.properties.feeling.properties.target.enum;
ok(fp.includes('Greta'), 'feeling targets include the known dead');
act('lena', 'examine', { object: alias(w.objects.get('body_jonas')) }); advance(3);
ok(w.deaths.dreadFor(C('lena')) >= 4, `village dread ${w.deaths.dreadFor(C('lena'))} once both deaths are known (+3, and +4 for the one nobody saw)`);

console.log('\n--- B5: breaking the news');
clear('lena');
w.applyAction(C('tomas'), { name: 'wait', arguments: { reason: 'x', minutes: 1 } }); w.setActivity(C('tomas'), { type: 'idle' });
move('tomas', 'bakery'); move('lena', 'square'); move('tomas', 'square'); clear('tomas'); clear('lena'); advance(2);
// Tomas is close to Jonas (household) — Lena is prompted
ok(/Tomas doesn't know about Jonas yet/.test(inbox('lena')), `the knower is prompted: "${inbox('lena').match(/[^|]*doesn't know[^|]*/)?.[0]?.trim()}"`);
const tn = buildTools(w, C('lena')).find((t) => t.function.name === 'tell_news');
ok(tn && tn.function.parameters.properties.person.enum.includes('Jonas'), 'tell_news is offered with the dead she knows of');
act('lena', 'tell_news', { to: 'Tomas', person: 'Jonas', news: 'died', how_much: 'In the bakery, in the night. His arm.' });
ok(w.deaths.entry(C('tomas'), 'jonas')?.how === 'told:lena' && ['believed', 'doubted'].includes(w.deaths.certainty(C('tomas'), 'jonas')), `Tomas is told: ${JSON.stringify(w.deaths.entry(C('tomas'), 'jonas'))}`);
ok(w.deaths.griefFor(C('tomas'), 'jonas') >= 4, `his grief starts at that moment (${w.deaths.griefFor(C('tomas'), 'jonas').toFixed(1)}, household)`);
ok(chooseTier(C('tomas'), { stimuli: [] }, w).tier === 'full' && chooseTier(C('lena'), { stimuli: [] }, w).tier === 'full', 'both decide at full');
ok(db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'learned_death'").get().n >= 5, 'the timeline can show the news travelling (learned_death events)');
ok(!w.deaths.knows(C('anselm'), 'greta') && leaks('anselm').length === 0, `Anselm, in the tavern, still knows nothing ${JSON.stringify(C('anselm').knownDeaths)} ${JSON.stringify(leaks('anselm'))} @${C('anselm').location}`);
const anselmTier = chooseTier(C('anselm'), { stimuli: [{ kind: 'timer', importance: 6, data: {} }] }, w);
ok(anselmTier.tier === 'none' || anselmTier.tier === 'light', `Anselm's mechanical moment: ${anselmTier.tier} (${anselmTier.reason})`);

console.log('\n--- B2: grief over days');
const floorBefore = w.deaths.griefFor(C('tomas'), 'jonas');
advance(2 * 1440, 10);
ok(w.deaths.griefFor(C('tomas'), 'jonas') >= 5, `household grief holds its floor of 5 for three days (${floorBefore.toFixed(1)} → ${w.deaths.griefFor(C('tomas'), 'jonas').toFixed(1)})`);
ok(w.deaths.mealFactor(C('tomas')) === 0.8 && w.deaths.fatigueFactor(C('tomas')) === 1.1, 'grief >= 6: meals relieve less, fatigue builds faster');
ok((C('tomas').onMyMind ?? []).some((m) => m.deathOf === 'jonas'), 'Jonas stays on his mind');

console.log('\n--- B4: decay, customs');
const body = w.objects.get('body_greta');
ok(['smelling', 'decaying'].includes(body.state) && w.rooms.get('bakery').effects.some((e) => e.smell), `after two days unburied: "${body.state}", a smell in the bakery`);
w.applyAction(C('anselm'), { name: 'wait', arguments: { reason: 'x', minutes: 1 } }); w.setActivity(C('anselm'), { type: 'idle' });
move('anselm', 'bakery'); advance(11);
ok(w.emotions.of(C('anselm')).some((e) => e.type === 'disgust'), 'disgust for whoever is in the room');
clear('anselm');
act('anselm', 'examine', { object: alias(body) }); advance(3);
act('anselm', 'tend_body', { body: alias(body), how: 'cover', with: alias(w.objects.get('bakery_cloth')) }); advance(3);
ok(w.objects.get('body_greta').data.covered && w.objects.get('bakery_cloth').placement?.of === 'body_greta', 'tend_body cover: the cloth lies on the body');
act('anselm', 'keep_vigil', { body: alias(body), hours: 2 });
ok(C('anselm').activity.detail?.kind === 'vigil' && chooseTier(C('anselm'), { stimuli: [] }, w).tier === 'full', 'keep_vigil: a watch over the body (and the first decision with a body in the room is full)');
w.setActivity(C('anselm'), { type: 'idle' });
// take Greta's things before the burial, with Lena watching
move('lena', 'bakery'); w.applyAction(C('lena'), { name: 'wait', arguments: { reason: 'watching', minutes: 30 } });
const trustBefore = w.memory.rel('lena', 'anselm')?.trust ?? 0;
const gretaThing = w.objects.inRoom('bakery').find((o) => o.ownerId === 'greta' && w.objects.type(o)?.portable && o.typeId !== 'cloth');
if (gretaThing) { w.objects.change(gretaThing.id, { visibility: 'obvious' }, { actorId: 'code', action: 'edit', notify: false }); act('anselm', 'take', { object: alias(gretaThing) }); }
ok(gretaThing && (w.memory.rel('lena', 'anselm')?.trust ?? 0) < trustBefore, `taking from the dead before the burial, witnessed: Lena's trust drops (${trustBefore} → ${w.memory.rel('lena', 'anselm')?.trust})`);
if (gretaThing) act('anselm', 'put', { object: alias(gretaThing), relation: 'floor' });
// carry her to the chapel yard and bury her
w.setActivity(C('anselm'), { type: 'idle' });
const r1 = act('anselm', 'carry_person', { person: alias(w.objects.get('body_greta')) });
ok(r1.ok && w.objects.get('body_greta').holderId === 'anselm', 'carry_person lifts the body');
const t0 = w.now;
act('anselm', 'travel_to', { destination: 'chapel_yard' });
const tripMinutes = C('anselm').activity.until - t0;
advance(20);
ok(C('anselm').location === 'chapel_yard' && tripMinutes >= 2, `carried to the chapel yard (${tripMinutes} min for the first leg, doubled)`);
w.setActivity(C('anselm'), { type: 'idle' });
const gy = w.objects.inRoom('chapel_yard');
ok(gy.some((o) => o.typeId === 'spade'), 'spades wait at the chapel yard');
const br = act('anselm', 'bury', { body: alias(w.objects.get('body_greta')), words: 'She fed us all.' });
ok(br.ok && C('anselm').activity.detail?.kind === 'bury', 'bury: digging begins (3 h alone)');
advance(185, 1);
ok(!w.objects.get('body_greta') && w.objects.get('grave_greta')?.typeId === 'grave' && C('greta').buriedAt != null, `buried: a grave object exists ("${w.objects.get('grave_greta')?.surfaceText}")`);
ok(db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'burial'").get().n === 1, 'a burial event is logged');
const gg = act('anselm', 'propose_gathering', { place: 'chapel_yard', time: 'noon', purpose: 'to say farewell to Greta' });
ok(gg.ok && /gather at the chapel yard/.test(inbox('tomas')), 'propose_gathering reaches everyone who knows the proposer');
ok(w.deaths.knows(C('anselm'), 'greta'), 'Anselm knows (he examined her body)');

console.log('\n--- B3: own mortality');
C('tomas').body.blood = 50; C('tomas').body.vitality = 40;
advance(11);
ok(C('tomas').mortal?.state === 'critical' && /You're getting colder|You're dying/.test(prompt('tomas').user.split('\n')[0]), `critical: "${prompt('tomas').user.split('\n')[0].slice(0, 70)}"`);
ok(chooseTier(C('tomas'), { stimuli: [] }, w).tier === 'full' && !w.habits.calm(C('tomas')).ok, 'decides at full, no autopilot');
C('tomas').body.blood = 100; C('tomas').body.vitality = 100; advance(11);

console.log('\n--- B6: the bakery without its baker');
move('lena', 'bakery'); w.setActivity(C('lena'), { type: 'idle' });
w.stock.state = { bakery: { food: 1 } };
const e1 = act('lena', 'eat', {}); w.setActivity(C('lena'), { type: 'idle' });
const e2 = act('lena', 'eat', {});
ok(e1.ok && !e2.ok && /shelves are empty/.test(e2.reason), `stock runs out: "${e2.reason}"`);
w.setActivity(C('lena'), { type: 'idle' });
act('lena', 'do', { action: 'baking bread at the oven', minutes: 60, target: alias(w.objects.get('bakery_oven')) }); advance(61);
ok(w.stock.level('bakery') >= 4, `someone else takes over the baking: stock ${w.stock.level('bakery')}`);

console.log('\n--- A1: intentions instead of plans');
const tools = buildTools(w, C('lena'));
ok(!tools.some((t) => /plan/.test(t.function.name)) && tools.every((t) => t.function.parameters.properties.intentions), 'no plan tools; every tool carries the intentions field');
C('lena').intentions = [];
applyEdits(w, C('lena'), { add: [{ text: 'Tell Anselm what happened to Greta', about: ['Anselm', 'Greta'] }, { text: 'Bake for the village', place: 'bakery' }, { text: 'a third' }] });
ok(C('lena').intentions.length === 2 && C('lena').intentions[0].about.includes('greta'), 'at most 2 adds per decision; about resolves names (the dead included)');
const id0 = C('lena').intentions[0].id;
applyEdits(w, C('lena'), { done: [id0], drop: ['i999'] });
ok(C('lena').intentions.length === 1, 'done removes; unknown ids are ignored');
for (let i = 0; i < 10; i++) addIntention(w, C('lena'), { text: `thing number ${i} to do`, source: 'self' });
ok(C('lena').intentions.length === 8, 'at most 8');
C('lena').intentions = C('lena').intentions.slice(0, 2);
addIntention(w, C('lena'), { text: 'Fix the shutters, as promised', about: ['tomas'], source: 'promise' });
const p0 = C('lena').intentions.find((i) => i.source === 'promise');
const s0 = C('lena').intentions.find((i) => i.source === 'self');
C('lena').intentionsFadedAt = w.now; w.clock.gameMinutes += 1440 * 2; fade(w, C('lena'));
ok(p0 && s0 && p0.weight > s0.weight, `untouched intentions fade; promises half as fast (${p0?.weight.toFixed(2)} vs ${s0?.weight.toFixed(2)})`);
ok(/THINGS YOU'D MEANT TO DO \(only if they still matter to you\)/.test(prompt('lena').user), 'THINGS YOU\'D MEANT TO DO in the prompt');

console.log('\n--- A2/A3: habits, calm-only autopilot');
w.habits.set(C('anselm'), w.habits.defaults(C('anselm')), { origin: 'generated' });
ok(C('anselm').habits.length >= 3 && C('anselm').habits.every((h) => h.window && h.action), `defaults: ${C('anselm').habits.map((h) => `${h.window[0]} ${h.what}`).join('; ')}`);
const day0 = Math.floor(w.now / 1440) * 1440 + 1440;
w.clock.gameMinutes = day0 + 12 * 60; // noon
w.deaths.setDread(w.maps.maps[0].id, 0);
const a = C('anselm'); move('anselm', 'tavern'); w.setActivity(a, { type: 'idle' }); a.emotions = []; a.inbox = []; a.calmMarks = {}; a.tierSnap = { at: w.now, emotions: {}, seen: [], deaths: '' }; a.habitStreak = 0;
a.mortal = null;
const calm = w.habits.calm(a);
const due = w.habits.autopilot(a);
ok(calm.ok && due?.what === 'eat at midday', `calm and due: ${due?.what} (${calm.why ?? 'calm'})`);
const ran = due && w.habits.run(a, due);
ok(ran && a.activity.detail?.kind === 'eat' && /out of habit, you eat at midday/.test(prompt('anselm').user), 'carried out by code, and the prompt says "out of habit, you …"');
w.setActivity(a, { type: 'idle' });
a.habitStreak = 2;
ok(!w.habits.calm(a).ok, 'at most two in a row');
a.habitStreak = 0;
w.deaths.setDread(w.maps.maps[0].id, 5);
ok(!w.habits.calm(a).ok && /edge/.test(w.habits.calm(a).why), 'dread >= 4 blocks the autopilot');
w.deaths.setDread(w.maps.maps[0].id, 0);
w.emotions.bump(a, { type: 'anger', target: null, delta: 7, source: 'director', raw: true });
ok(!w.habits.calm(a).ok, 'an emotion >= 5 blocks it');
a.emotions = [];
const changes = w.habits.applyChanges(a, [{ op: 'add', habit: { what: "visit Greta's grave at dusk", kind: 'social', window: ['18:00', '19:30'], place: 'chapel_yard', action: { type: 'do', minutes: 20 } }, why: "I can't let a day pass without going." }, { op: 'modify', id: a.habits[0].id, changes: { window: ['20:00', '21:00'] }, why: 'Home before dark.' }, { op: 'drop', id: a.habits[1].id, why: 'no' }]);
ok(changes.length === 2 && db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'habit_change'").get().n >= 2, `consolidation habit changes: at most 2, logged (${changes.map((x) => x.op).join(', ')})`);

console.log('\n--- A4/A5: the waking decision, tiers');
w.applyAction(a, { name: 'sleep', arguments: { until_rested: true } });
a.activity.since = w.now - 5 * 60; a.activity.detail.startedAt = a.activity.since; a.inbox = [];
{ const { wake } = await imp('server/world/actions.js'); wake(w, a, { reason: 'rested' }); }
const wakeTier = chooseTier(a, { stimuli: a.inbox }, w);
ok(wakeTier.tier === 'full' && /waking/.test(wakeTier.reason), `the first decision after a long sleep: ${wakeTier.tier} (${wakeTier.reason})`);
ok(/# ON WAKING/.test(prompt('anselm').user) && /what matters to you today/.test(prompt('anselm').user), 'ON WAKING block and its instruction');
a.inbox = []; a.emotions = []; a.mortal = null; move('anselm', 'well');
ok(chooseTier(a, { stimuli: [{ kind: 'timer', importance: 6, data: {} }] }, w).tier === 'none', 'none only for a mechanical moment');
ok(chooseTier(a, { stimuli: [{ kind: 'speech', importance: 5, data: { conversationId: 'x' } }] }, w).tier === 'light', 'light is the default');

console.log('\n--- leak check on every living citizen, end of the run');
ok([...w.citizens.values()].filter((c) => c.alive).every((c) => leaks(c.id).length === 0), 'no prompt names a death its citizen does not know about');
w.stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
