// Step 10 check, Part 0: tiers by change (0.1), the habit calm check (0.2), vigils in turns (0.3), live-world safety
// (0.5). In-process world, no LLM. node --disable-warning=ExperimentalWarning scripts/checks/step10.mjs .
import fs from 'node:fs';
import path from 'node:path';
const [,, rootArg = process.cwd(), dataDir = `${process.env.TEMP ?? '/tmp'}/aw-step10`] = process.argv;
const root = path.resolve(rootArg).split(path.sep).join('/');
fs.rmSync(dataDir, { recursive: true, force: true });
Object.assign(process.env, { DATA_DIR: dataDir, SCENARIO: 'village', LLM_BASE_URL: 'http://localhost:9/v1', SPOT_WALKING: 'false' });
const imp = (p) => import(`file:///${root}/${p}`);
const { openDb, migrate } = await imp('server/db.js');
const { World } = await imp('server/world.js');
const { buildMessages } = await imp('server/agents/prompt.js');
const { chooseTier, refreshTierSnapshot, TIER_RULES } = await imp('server/agents/tiers.js');
const { calmMarkFor, isRoutineStimulus } = await imp('server/agents/habits.js');
const { makeStimulus } = await imp('server/world/perception.js');
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) pass++; else fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const db = openDb(); await migrate(db);
const w = new World(db);
w.scheduler.run = () => {}; w.scheduler.poke = () => {}; w.clock.running = true;
w.habits.ensure = () => {};
for (const c of w.citizens.values()) { c.thinkCooldownUntil = 1e9; c.needs.hunger = 5; c.needs.fatigue = 5; }
const C = (id) => w.citizens.get(id);
const advance = (m, step = 0.5) => { for (let t = 0; t < m; t += step) { w.clock.gameMinutes += step; for (const h of [...w.clock.handlers]) h(step, w.clock.gameMinutes); } };
const move = (id, to) => w.directorEvent({ effects: [{ type: 'move', target: id, to, notify: false }] });
const S = (p) => makeStimulus(p, w.now);
const tier = (id, stimuli) => chooseTier(C(id), { purpose: 'decide', stimuli }, w);
const calmEmotions = (id) => { for (const e of w.emotions.of(C(id))) e.intensity = Math.min(e.intensity, 2); };
const events = (type, actor) => db.prepare('SELECT data FROM events WHERE type = ? AND (? IS NULL OR actor_id = ?) ORDER BY id').all(type, actor ?? null, actor ?? null).map((r) => JSON.parse(r.data));

console.log('\n--- 0.5 live-world safety');
{
  const main = fs.readFileSync(`${root}/server/main.js`, 'utf8');
  const { config } = await imp('server/config.js');
  ok(config.worldRole === 'dev', `WORLD_ROLE defaults to dev (${config.worldRole})`);
  ok(/worldRole === 'live' && watched/.test(main) && /WATCH_REPORT_DEPENDENCIES/.test(main) && /process\.exit\(1\)/.test(main), 'main.js refuses to start a live world under --watch');
  ok(fs.readFileSync(`${root}/.env.example`, 'utf8').includes('WORLD_ROLE=dev'), '.env.example documents WORLD_ROLE');
}

console.log('\n--- 0.1 tiers by change');
ok(db.prepare('PRAGMA table_info(llm_calls)').all().some((c) => c.name === 'tier_reason'), 'llm_calls has tier_reason');
ok(TIER_RULES.fullImportance === 6 && TIER_RULES.emotionJump === 3 && TIER_RULES.fullPerGameHour === 2 && TIER_RULES.capExemptImportance === 8, `defaults ${JSON.stringify(TIER_RULES)}`);
move('greta', 'bakery'); move('tomas', 'bakery');
for (const id of ['greta', 'tomas', 'lena']) calmEmotions(id);
{
  const g = C('greta');
  g.tierSnap = null; g.fullAt = [];
  let r = tier('greta', [S({ kind: 'timer', text: 'You finish kneading the dough.', importance: 6, roomId: 'bakery' })]);
  ok(r.tier === 'none' && r.reason === 'routine', `an activity ending, nothing else: none/routine (${r.tier}/${r.reason})`);
  const spoken = S({ kind: 'speech', text: 'Tomas says to you: "Greta, a word."', importance: 9, sourceId: 'tomas', roomId: 'bakery', data: { addressed: true, wake: true, interrupt: true } });
  r = tier('greta', [spoken]);
  ok(r.tier === 'full' && r.reason === 'new_stimulus', `addressed speech (9): full/new_stimulus (${r.tier}/${r.reason})`);
  r = tier('greta', [spoken]);
  ok(r.tier !== 'full', `the same stimulus again (already decided on): not full (${r.tier}/${r.reason})`);
  advance(2);
  r = tier('greta', [S({ kind: 'speech', text: 'Tomas says to you: "About the debt."', importance: 9, sourceId: 'tomas', roomId: 'bakery', data: { addressed: true, wake: true, interrupt: true } })]);
  ok(r.tier === 'light', `the next turn of the same exchange: light (${r.tier}/${r.reason})`);
  r = tier('greta', [S({ kind: 'speech', text: 'Lena says to you: "Greta!"', importance: 9, sourceId: 'lena', roomId: 'bakery', data: { addressed: true, wake: true, interrupt: true } })]);
  ok(r.tier === 'full' && r.reason === 'new_stimulus', `someone else opening an exchange: full (${r.tier}/${r.reason})`);
  advance(31);
  r = tier('greta', [S({ kind: 'speech', text: 'Tomas says to you: "Me again."', importance: 9, sourceId: 'tomas', roomId: 'bakery', data: { addressed: true, wake: true, interrupt: true } })]);
  ok(r.tier === 'full', `after half an hour, a new exchange: full (${r.tier}/${r.reason})`);
  g.fullAt = [];
  r = tier('greta', [S({ kind: 'speech', text: 'Tomas says to Lena: "Nice weather."', importance: 5, sourceId: 'tomas', roomId: 'bakery', data: { addressed: false } })]);
  ok(r.tier === 'light' && r.reason === 'conversation', `chatter nearby (5): light/conversation (${r.tier}/${r.reason})`);
  // a sustained strong feeling that doesn't change → light
  w.emotions.bump(g, { type: 'sadness', target: 'jonas', delta: 7, cause: 'Jonas left', source: 'director', raw: true });
  r = tier('greta', [S({ kind: 'action', text: 'Tomas sweeps the floor.', importance: 3, roomId: 'bakery' })]);
  ok(r.tier === 'full' && r.reason === 'emotion_jump', `a new feeling at >= 5: full/emotion_jump (${r.tier}/${r.reason}; ${r.detail})`);
  r = tier('greta', [S({ kind: 'action', text: 'Tomas sweeps the floor again.', importance: 3, roomId: 'bakery' })]);
  ok(r.tier === 'light', `the same feeling, unchanged: light (${r.tier}/${r.reason})`);
  w.emotions.bump(g, { type: 'sadness', target: 'jonas', delta: 1, cause: 'still', source: 'director', raw: true });
  r = tier('greta', [S({ kind: 'action', text: 'Tomas leans on the counter.', importance: 3, roomId: 'bakery' })]);
  ok(r.tier === 'light', `a rise of 1: still light (${r.tier}/${r.reason})`);
  // a self-report applied after the decision is folded into the snapshot (no jump next time)
  w.emotions.bump(g, { type: 'anger', target: 'tomas', delta: 2, cause: 'his tone', source: 'self', raw: true });
  const before = tier('greta', [S({ kind: 'action', text: 'x', importance: 2, roomId: 'bakery' })]);
  w.emotions.bump(g, { type: 'anger', target: 'tomas', delta: 3, cause: 'he said it again', source: 'self', raw: true });
  refreshTierSnapshot(w, g);
  r = tier('greta', [S({ kind: 'action', text: 'y', importance: 2, roomId: 'bakery' })]);
  ok(r.tier === 'light', `their own reported feeling is no jump at the next decision (${before.tier} → ${r.tier}/${r.reason})`);
  g.fullAt = []; // (the cap is checked separately below)
  w.emotions.of(g).find((e) => e.type === 'anger' && e.target === 'tomas').intensity += 3.2; // he shoved the tray
  r = tier('greta', [S({ kind: 'action', text: 'z', importance: 2, roomId: 'bakery' })]);
  ok(r.tier === 'full' && r.reason === 'emotion_jump', `a rise of >= 3: full/emotion_jump (${r.tier}/${r.reason}; ${r.detail})`);
  // waking
  r = tier('greta', [S({ kind: 'timer', text: 'You wake up.', importance: 6, data: { wakeUp: true, longSleep: true } })]);
  ok(r.tier === 'full' && r.reason === 'waking', `the waking decision: full/waking (${r.tier}/${r.reason})`);
}
{
  // the per-citizen cap: two full per rolling game hour; importance >= 8, waking and altercations exempt
  const t = C('tomas');
  t.tierSnap = null; t.fullAt = [];
  calmEmotions('tomas');
  tier('tomas', []); // first snapshot
  const six = (n) => S({ kind: 'action', text: `Something odd happens (${n}).`, importance: 6, roomId: 'bakery' });
  const a = tier('tomas', [six(1)]); advance(5);
  const b = tier('tomas', [six(2)]); advance(5);
  const capped = tier('tomas', [six(3)]);
  ok(a.tier === 'full' && b.tier === 'full' && capped.tier === 'light' && capped.reason === 'tier_capped', `third full in an hour → light/tier_capped (${a.tier}, ${b.tier}, ${capped.tier}/${capped.reason})`);
  ok(events('tier_capped', 'tomas').some((e) => e.wanted === 'new_stimulus'), 'tier_capped is logged with what it wanted');
  const eight = tier('tomas', [S({ kind: 'action', text: 'A scream from outside!', importance: 8, roomId: 'bakery' })]);
  ok(eight.tier === 'full', `importance 8 is exempt from the cap (${eight.tier}/${eight.reason})`);
  const fight = tier('tomas', [S({ kind: 'action', text: 'Kael comes at you.', importance: 8, roomId: 'bakery', data: { altercation: 'alt1', role: 'target' } })]);
  ok(fight.tier === 'full' && fight.reason === 'altercation', `an altercation is full and exempt (${fight.tier}/${fight.reason})`);
  advance(61);
  const later = tier('tomas', [six(4)]);
  ok(later.tier === 'full', `an hour later the cap has rolled off (${later.tier}/${later.reason})`);
}

console.log('\n--- 0.1 "Still with you"');
{
  const g = C('greta');
  const e = w.emotions.of(g).find((x) => x.type === 'sadness' && x.target === 'jonas');
  e.since = w.now - 1440; e.intensity = 7;
  const user = buildMessages(w, g)[1].content;
  ok(/Still with you: sadness for Jonas \(since yesterday\)\./.test(user), `an old strong feeling is named: "${(user.match(/Still with you:[^\n]*/) ?? ['—'])[0]}"`);
  e.since = w.now - 30;
  ok(!/Still with you/.test(buildMessages(w, g)[1].content), 'a fresh one is not');
}

console.log('\n--- 0.2 habit calm check');
{
  const lena = C('lena');
  move('lena', 'bakery'); move('tomas', 'bakery'); move('greta', 'bakery'); move('anselm', 'bakery');
  for (const id of ['lena', 'greta', 'tomas', 'anselm']) calmEmotions(id);
  lena.calmMarks = {}; lena.inbox = []; lena.thinkingInbox = []; lena.habitStreak = 0;
  w.setActivity(lena, { type: 'idle' });
  lena.tierSnap = { at: w.now, emotions: Object.fromEntries(w.emotions.of(lena).map((e) => [`${e.type}|${e.target ?? ''}`, e.intensity])), seen: [], deaths: '' };
  ok(isRoutineStimulus(S({ kind: 'body', text: 'You feel tired.', importance: 5, data: { need: 'fatigue', level: 'tired', levelIndex: 2 } }))
    && !isRoutineStimulus(S({ kind: 'body', text: 'You are exhausted.', importance: 7, data: { need: 'fatigue', level: 'exhausted', levelIndex: 3 } })), 'need reminders below level 3 are routine (by levelIndex, not the level name)');
  ok(w.habits.calm(lena).ok, `calm at first (${w.habits.calm(lena).why ?? 'ok'})`);
  const perceive = (p) => w.perceive([lena.id], p);
  perceive({ kind: 'speech', text: 'Tomas says to Anselm: "The wheel needs a new rim."', importance: 5, sourceId: 'tomas', roomId: 'bakery', data: { addressed: false, toId: 'anselm' } });
  ok(w.habits.calm(lena).ok, `chatter that doesn't concern her doesn't block (${w.habits.calm(lena).why ?? 'ok'})`);
  ok(calmMarkFor(w, lena, S({ kind: 'speech', text: 'Tomas says: "Lena should hear this."', importance: 5, roomId: 'bakery', data: {} })) === 'overheard', 'her name in overheard talk → overheard');
  perceive({ kind: 'speech', text: 'Tomas says to Anselm: "Has anyone seen Lena today?"', importance: 5, sourceId: 'tomas', roomId: 'bakery', data: { addressed: false, toId: 'anselm' } });
  let calm = w.habits.calm(lena);
  ok(!calm.ok && calm.why === 'overheard talk that concerns them', `her name overheard blocks (${calm.why})`);
  advance(31);
  ok(w.habits.calm(lena).ok, `half an hour later it no longer blocks (${w.habits.calm(lena).why ?? 'ok'})`);
  perceive({ kind: 'speech', text: 'Greta says to you: "Lena, the bread."', importance: 9, sourceId: 'greta', roomId: 'bakery', data: { addressed: true, wake: true } });
  lena.inbox = [];
  calm = w.habits.calm(lena);
  ok(!calm.ok && calm.why === 'spoken to lately', `spoken to blocks (${calm.why})`);
  advance(31);
  perceive({ kind: 'action', text: 'A shelf crashes down in the corner.', importance: 6, roomId: 'bakery' });
  lena.inbox = [];
  calm = w.habits.calm(lena);
  ok(!calm.ok && calm.why === 'something happened here lately', `an event >= 5 in her room blocks (${calm.why})`);
  advance(31);
  perceive({ kind: 'action', text: 'Someone shouts in the distance.', importance: 6, roomId: 'square' });
  lena.inbox = [];
  ok(w.habits.calm(lena).ok, `an event in another room doesn't (${w.habits.calm(lena).why ?? 'ok'})`);
  w.emotions.bump(lena, { type: 'fear', target: null, delta: 7.5, cause: 'a sound', source: 'director', raw: true });
  calm = w.habits.calm(lena);
  ok(!calm.ok && (calm.why === 'a strong feeling' || calm.why === 'a feeling that just rose'), `an emotion >= 7 blocks (${calm.why})`);
  for (const e of w.emotions.of(lena)) e.intensity = 4;
  lena.tierSnap = { at: w.now, emotions: Object.fromEntries(w.emotions.of(lena).map((e) => [`${e.type}|${e.target ?? ''}`, 1])), seen: [], deaths: '' };
  calm = w.habits.calm(lena);
  ok(!calm.ok && calm.why === 'a feeling that just rose', `an emotion jump since the last decision blocks (${calm.why})`);
  // a blocked due habit is logged with its blocker
  lena.habits = [{ id: 'h1', what: 'bake bread', doing: 'baking bread', kind: 'work', window: ['00:00', '23:59'], place: 'bakery', action: { type: 'do', minutes: 60 }, strength: 0.8, lastDone: null, history: [] }];
  ok(w.habits.autopilot(lena) === null, 'a due habit is not run while blocked');
  const blocked = events('habit_blocked', 'lena');
  ok(blocked.length === 1 && blocked[0].blocker === 'a feeling that just rose' && blocked[0].id === 'h1', `habit_blocked logged with the blocker (${JSON.stringify(blocked[0] ?? {})})`);
  w.habits.autopilot(lena);
  ok(events('habit_blocked', 'lena').length === 1, 'not logged twice for the same blocker');
  lena.tierSnap.emotions = Object.fromEntries(w.emotions.of(lena).map((e) => [`${e.type}|${e.target ?? ''}`, e.intensity]));
  ok(w.habits.autopilot(lena)?.id === 'h1', 'calm again: the habit runs by code');
  lena.habits = [];
}

console.log('\n--- 0.3 vigils in turns');
{
  for (const id of ['greta', 'tomas', 'lena', 'anselm', 'jonas']) calmEmotions(id);
  move('jonas', 'bakery'); move('greta', 'bakery'); move('lena', 'bakery'); move('anselm', 'square'); move('tomas', 'smithy');
  w.body.die(C('jonas'), { cause: 'a fall', reason: 'blood' });
  const body = w.objects.get('body_jonas');
  ok(Boolean(body), 'Jonas dies; his body lies in the bakery');
  for (const id of ['greta', 'lena']) w.deaths.learn(C(id), 'jonas', { how: 'found', certainty: 'certain', quiet: true });
  const g = C('greta');
  const l = C('lena');
  w.setActivity(g, { type: 'idle' }); w.setActivity(l, { type: 'idle' });
  let r = w.applyAction(g, { name: 'keep_vigil', arguments: { body: w.objects.alias(body) } });
  ok(r.ok && g.activity.detail?.kind === 'vigil' && Math.round(g.activity.until - w.now) === 180, `keep_vigil defaults to 3 hours (${r.ok}, ${Math.round((g.activity.until ?? 0) - w.now)} min)`);
  r = w.applyAction(g, { name: 'keep_vigil', arguments: { body: w.objects.alias(body), hours: 8 } });
  ok(Math.round(g.activity.until - w.now) === 240, `at most 4 hours (${Math.round(g.activity.until - w.now)} min)`);
  g.inbox = [];
  r = w.applyAction(l, { name: 'keep_vigil', arguments: { body: w.objects.alias(body), hours: 3 } });
  ok(r.ok && g.activity.type === 'idle' && g.inbox.some((s) => /takes over the watch/.test(s.text) && s.data?.relieved), `Lena takes over: Greta is relieved and told ("${g.inbox.find((s) => s.data?.relieved)?.text ?? '—'}")`);
  ok(JSON.stringify(w.objects.get('body_jonas').data.vigil) === JSON.stringify(['lena']), `the body's watch list: ${JSON.stringify(w.objects.get('body_jonas').data.vigil)}`);
  ok(events('vigil_relieved', 'greta').length === 1, 'vigil_relieved logged');
  // tiredness speaks one level earlier during a vigil
  l.needs.fatigue = 64; l.needs.levels.fatigue = 1; l.needs.lastReminderAt.fatigue = w.now; l.inbox = [];
  advance(15);
  const tired = l.inbox.find((s) => s.data?.need === 'fatigue' && s.data.level === 'tired');
  ok(tired && tired.importance === 7 && tired.data.level === 'tired', `during a vigil the "tired" reminder comes at importance 7 (${tired ? `${tired.data.level}/${tired.importance}` : 'none'})`);
  ok(l.inbox.some((s) => s.importance >= 7), 'which is enough to break the vigil for a decision (vigils wake on >= 7)');
  // the vigil's end: a decision about staying, handing over, going
  l.needs.fatigue = 20; l.needs.levels.fatigue = 0;
  w.applyAction(l, { name: 'keep_vigil', arguments: { body: w.objects.alias(w.objects.get('body_jonas')), hours: 1 } });
  l.inbox = [];
  advance(61);
  const end = l.inbox.find((s) => s.data?.vigilEnd);
  ok(end && /kept watch over Jonas for an hour\. You could stay longer, hand the watch to someone, or go and rest\./.test(end.text), `vigil end: "${end?.text ?? '—'}"`);
  r = tier('lena', [end]);
  ok(r.tier !== 'none', `the vigil's end is a decision, not mechanical (${r.tier}/${r.reason})`);
  // the prompt: hours awake, who else could take a turn
  l.wokeAt = w.now - 19 * 60;
  w.memory.rel('lena', 'greta') && db.prepare('SELECT 1').get();
  move('greta', 'bakery'); w.setActivity(g, { type: 'idle' });
  const relLG = w.memory.rel('lena', 'greta');
  const user = buildMessages(w, l)[1].content;
  ok(/You've been awake 19 hours\./.test(user), 'the vigil prompt says plainly how long they have been awake');
  const gClose = w.deaths.closeness(g, C('jonas'));
  ok(!(relLG?.nameKnown) || !(gClose.tie || gClose.affinity >= 2 || gClose.grief >= 6) || /Who else could take a turn watching over Jonas: [^\n]*Greta \(here\)/.test(user),
    `who else could take a turn (${(user.match(/Who else could take a turn[^\n]*/) ?? ['— (no close relation awake nearby)'])[0]})`);
  // ON WAKING names what's still owed to the dead
  const t = C('tomas');
  // death news: the first decision after learning of a death, then not again
  calmEmotions('tomas'); t.fullAt = []; t.tierSnap = null; tier('tomas', []);
  w.deaths.learn(t, 'jonas', { how: 'told', certainty: 'certain', by: 'lena', quiet: true });
  for (const e of w.emotions.of(t)) e.intensity = Math.min(e.intensity, 2); // isolate the death-news rule
  refreshTierSnapshot(w, t);
  r = tier('tomas', [S({ kind: 'action', text: 'A bird lands.', importance: 2, roomId: 'smithy' })]);
  ok(r.tier === 'full' && r.reason === 'death_news', `first decision after learning of a death: full/death_news (${r.tier}/${r.reason})`);
  r = tier('tomas', [S({ kind: 'action', text: 'Another bird.', importance: 2, roomId: 'smithy' })]);
  ok(r.tier !== 'full', `the next one: not full again (${r.tier}/${r.reason})`);
  t.lastSleep = { minutes: 400, quality: 'rough', reason: 'collapse' };
  t.inbox = [S({ kind: 'timer', text: 'You wake up.', importance: 6, data: { wakeUp: true, longSleep: true } })];
  const waking = buildMessages(w, t, { mode: 'decide' })[1].content;
  ok(/# ON WAKING[\s\S]*Jonas lies in [^\n]*, not yet buried\./.test(waking), `ON WAKING: "${(waking.match(/Jonas lies in[^\n]*/) ?? ['—'])[0]}"`);
  // a grave half dug stays half dug (a GLM run: every piece of digging broken off, every bury from nothing)
  move('tomas', 'chapel_yard'); w.setActivity(t, { type: 'idle' });
  w.objects.change('body_jonas', { roomId: 'chapel_yard', holderId: null, placement: { relation: 'floor', of: null } }, { actorId: 'code', action: 'move', notify: false });
  const spade = [...w.objects.byId.values()].find((o) => (w.objects.type(o)?.tags ?? []).includes('digging') && o.roomId === 'chapel_yard');
  ok(Boolean(spade), 'a spade lies in the chapel yard');
  let b = w.applyAction(t, { name: 'bury', arguments: { body: w.objects.alias(w.objects.get('body_jonas')) } });
  ok(b.ok && t.activity.detail?.kind === 'bury' && Math.round(t.activity.until - w.now) === 180, `bury: 3 hours from nothing (${Math.round((t.activity.until ?? 0) - w.now)} min)`);
  advance(60);
  w.setActivity(t, { type: 'idle' }); // broken off (an exhausted reminder, a decision)
  ok(Math.round(w.objects.get('body_jonas').data.dug) === 60, `an hour's digging stays on the body (dug ${w.objects.get('body_jonas').data.dug})`);
  w.applyAction(t, { name: 'do', arguments: { action: 'digging the grave under the yew', minutes: 30 } });
  advance(31);
  ok(Math.round(w.objects.get('body_jonas').data.dug) === 90, `a 'do' that digs there counts too (dug ${w.objects.get('body_jonas').data.dug})`);
  w.setActivity(t, { type: 'idle' });
  b = w.applyAction(t, { name: 'bury', arguments: { body: w.objects.alias(w.objects.get('body_jonas')) } });
  ok(b.ok && Math.round(t.activity.until - w.now) === 90 && t.activity.detail.description === 'digging on at the grave', `bury again: only the rest (${Math.round(t.activity.until - w.now)} min, "${t.activity.detail.description}")`);
  t.needs.fatigue = 10;
  advance(91);
  ok(!w.objects.get('body_jonas') && w.objects.get('grave_jonas'), 'the grave is finished; Jonas is buried');
  ok(/turns of a few hours/.test(buildMessages(w, t)[0].content) && /second or third day/.test(buildMessages(w, t)[0].content), 'customs: vigils in turns, burial on the second or third day');
}

console.log(`\n${pass} passed, ${fail} failed`);
w.stop();
process.exit(fail ? 1 : 0);
