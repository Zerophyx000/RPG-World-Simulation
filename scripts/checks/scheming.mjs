// Step 11 check: traits, ambitions, lies (alibi, contradictions, tells, verdicts, retelling, confession, framing),
// schemes (validation, due steps, the decision field, accomplices, exposure), the leak checks. In-process, no LLM (the
// leak judge is stubbed). node --disable-warning=ExperimentalWarning scripts/checks/scheming.mjs .
import fs from 'node:fs';
import path from 'node:path';
const [,, rootArg = process.cwd(), dataDir = `${process.env.TEMP ?? '/tmp'}/aw-scheming11`] = process.argv;
const root = path.resolve(rootArg).split(path.sep).join('/');
fs.rmSync(dataDir, { recursive: true, force: true });
Object.assign(process.env, { DATA_DIR: dataDir, SCENARIO: 'village', LLM_BASE_URL: 'http://localhost:9/v1', SPOT_WALKING: 'false', SPEECH_CHARS_PER_SECOND: '0' }); // no reading floor: every line is spoken at once
const imp = (p) => import(`file:///${root}/${p}`);
const { openDb, migrate } = await imp('server/db.js');
const { World } = await imp('server/world.js');
const { buildMessages } = await imp('server/agents/prompt.js');
const { buildTools } = await imp('server/agents/tools.js');
const { chooseTier } = await imp('server/agents/tiers.js');
const { findLeaks } = await imp('server/social/leak.js');
const { resolveWhen, resolvePlace } = await imp('server/scheming/common.js');
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) pass++; else fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const db = openDb(); await migrate(db);
const w = new World(db);
w.scheduler.run = () => {}; w.scheduler.poke = () => {}; w.clock.running = true; w.habits.ensure = () => {};
const S = w.scheming;
const C = (id) => w.citizens.get(id);
const move = (id, to) => w.directorEvent({ effects: [{ type: 'move', target: id, to, notify: false }] });
const at = (day, h) => { w.clock.gameMinutes = (day - 1) * 1440 + h * 60; };
const label = (a, b) => [...w.memory.labelsFor(C(a), [C(b)]).keys()][0];
const say = (a, to, text, extra = {}) => { w.setActivity(C(a), { type: 'idle' }); return w.applyAction(C(a), { name: 'say', arguments: { to: label(a, to), text, ...extra } }); };
const events = (type) => db.prepare('SELECT actor_id, data FROM events WHERE type = ? ORDER BY id').all(type).map((r) => ({ actor: r.actor_id, ...JSON.parse(r.data) }));
const here = (id, room) => w.logEvent('activity', { actorId: id, location: room, from: 'idle', to: 'doing' });
for (const id of ['greta', 'tomas', 'lena', 'anselm', 'jonas']) for (const o of ['greta', 'tomas', 'lena', 'anselm', 'jonas']) if (id !== o) w.memory.learnName(id, o, 1);

console.log('\n--- traits and ambitions');
ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ambitions','schemes','lies')").all().length === 3, 'tables ambitions, schemes, lies');
for (const c of w.citizens.values()) if (c.alive) await S.traits.generate(c);
const t = C('tomas').persona.traits;
ok(['greta', 'tomas', 'lena', 'anselm', 'jonas'].every((id) => C(id).persona.traits.honesty >= 1 && C(id).persona.traits.cunning >= 1), `every citizen has honesty and cunning (tomas ${t.honesty}/${t.cunning}; estimated without a model)`);
C('jonas').persona.traits.honesty = 8; C('jonas').persona.traits.cunning = 2;
C('anselm').persona.traits.honesty = 3; C('anselm').persona.traits.cunning = 8;
ok(/Lying doesn't come easily to you/.test(buildMessages(w, C('jonas'))[0].content) && /good at telling people what they want to hear/.test(buildMessages(w, C('anselm'))[0].content), 'traits in words in the system prompt, never as numbers');
ok(!/honesty|cunning/i.test(buildMessages(w, C('jonas'))[0].content.replace(/HOW THIS WORKS[\s\S]*?WHO YOU ARE/, '')), 'no trait names or numbers shown');
const secretBefore = [...w.citizens.values()].some((c) => (c.persona.secretGoals ?? []).length);
for (const c of w.citizens.values()) S.ambitions.moveSecretGoals(c);
const migrated = db.prepare("SELECT COUNT(*) n FROM ambitions WHERE origin = 'migrated_secret_goal' AND secrecy = 'secret'").get().n;
ok(!secretBefore || migrated > 0, `5.5 secret goals became secret ambitions (${migrated})`);
const kael = C('kael');
const lab = w.memory.labelsFor(C('tomas'), [C('jonas'), C('greta')]);
ok(S.ambitions.normalize(C('tomas'), { kind: 'status', text: 'Make Bartholomew the cooper my friend.', intensity: 5 }, lab).bad, 'an ambition naming someone who isn\'t here is rejected');
ok(S.ambitions.normalize(C('tomas'), { kind: 'revenge', text: 'Make him pay.', targets: ['Nobody Real'], intensity: 5 }, lab).bad, 'an unknown target is rejected');
const a1 = S.ambitions.add(C('tomas'), S.ambitions.normalize(C('tomas'), { kind: 'mastery', text: 'Be the smith the whole valley sends for.', intensity: 7, secrecy: 'open' }, lab), { why: 'test' });
const a2 = S.ambitions.add(C('tomas'), S.ambitions.normalize(C('tomas'), { kind: 'revenge', text: 'See Jonas thrown out of the village for good.', targets: [label('tomas', 'jonas')], intensity: 8, secrecy: 'secret' }, lab), { why: 'test' });
ok(a1 && a2 && a2.targetIds.includes('jonas'), 'ambitions with real targets are stored');
while (S.ambitions.of('tomas').length < 3) S.ambitions.add(C('tomas'), { kind: 'other', text: 'Something else entirely, for a while.', intensity: 3 });
ok(!S.ambitions.add(C('tomas'), { kind: 'other', text: 'One too many wants.', intensity: 2 }), 'at most 3 active');
w.memory.pushOnMind = w.memory.pushOnMind.bind(w.memory);
const fullP = buildMessages(w, C('tomas'), { tier: 'full' })[1].content;
const lightP = buildMessages(w, C('tomas'), { tier: 'light' })[1].content;
ok(/# YOUR AMBITIONS\n[\s\S]*thrown out of the village for good\. \(you'd never admit this\)[\s\S]*they don't decide for you/.test(fullP), 'full tier: YOUR AMBITIONS, secret ones marked, "they don\'t decide for you"');
ok((lightP.match(/# YOUR AMBITIONS\n([^#]*)/)?.[1].split('\n').filter((l) => l.startsWith('- ')).length ?? 0) === 1, 'light tier: only the strongest');
ok(!/YOUR AMBITIONS/.test(buildMessages(w, C('tomas'), { tier: 'none' })[1].content), 'none tier: nothing');
const ch = S.ambitions.applyChanges(C('tomas'), {
  update: [{ id: a1.id, intensity: 9, note: 'Lena praised my work in front of everyone.' }],
  transform: [{ id: a2.id, into: { kind: 'revenge', text: 'Make Jonas suffer for what he took from me.', targets: [label('tomas', 'jonas')], intensity: 8, secrecy: 'secret' }, why: 'Wanting him gone turned into wanting him to suffer.' }],
});
ok(ch.some((x) => x.op === 'transform') && S.ambitions.get(a2.id).status === 'transformed' && S.ambitions.get(a1.id).data.history.some((h) => /praised/.test(h.why ?? '')), 'consolidation changes: update and transform, each with its reason in the history');
ok(S.ambitions.applyChanges(C('tomas'), { abandon: [{ id: a1.id }] }).length === 0, 'abandoning needs a why');

console.log('\n--- the alibi (lies, contradictions, verdicts)');
at(2, 1);
move('jonas', 'smithy'); move('lena', 'smithy');
here('jonas', 'smithy'); here('lena', 'smithy');
at(2, 1.5); here('jonas', 'smithy'); here('lena', 'smithy');
at(2, 3); move('jonas', 'house_tomas'); move('lena', 'house_lena'); here('jonas', 'house_tomas'); here('lena', 'house_lena');
at(2, 8);
move('jonas', 'square'); move('lena', 'square'); move('anselm', 'square'); move('greta', 'bakery');
for (const id of ['jonas', 'lena', 'anselm']) { C(id).inbox = []; w.setActivity(C(id), { type: 'idle' }); }
const win = resolveWhen(w, 'last night');
ok(win && win.from < 2 * 1440 - 1440 + 1 * 60 + 1 && win.to >= 1440 + 3 * 60, `"last night" → a window over the night (${win?.from}–${win?.to})`);
ok(resolvePlace(w, C('jonas'), 'home') === 'house_tomas' && resolvePlace(w, C('jonas'), 'the forge') === 'smithy', 'places as said: "home", "the forge"');
const r = say('jonas', 'lena', 'I was home all night, Lena. Never left the house.', { deceive: { truth: 'I was at the forge, breaking his tools.', kind: 'self', why: 'If he finds out, he will kill me.', check: { who: 'me', where: 'home', when: 'last night' } } });
const lie = db.prepare('SELECT * FROM lies ORDER BY id DESC LIMIT 1').get();
ok(r.ok && lie && lie.truth.includes('forge') && lie.check_who === 'jonas' && lie.check_where === 'house_tomas' && lie.check_from != null, `the lie row: truth, kind, why, resolved check (${lie?.check_who} @ ${lie?.check_where})`);
const hb = JSON.parse(lie.heard_by);
ok(hb.some((h) => h.citizen_id === 'lena' && h.how === 'told') && hb.some((h) => h.citizen_id === 'anselm' && h.how === 'overheard'), 'heard_by: Lena told, Anselm overheard');
ok(C('lena').inbox.some((s) => /That doesn't match: you saw Jonas at .*(smithy|forge)/i.test(s.text) && s.importance === 7), `Lena: "${C('lena').inbox.find((s) => s.data?.contradiction)?.text ?? '—'}"`);
ok(!C('anselm').inbox.some((s) => s.data?.contradiction), 'Anselm (who saw nothing) gets no contradiction');
ok(chooseTier(C('lena'), { stimuli: C('lena').inbox }, w).tier === 'full', 'the contradiction makes Lena\'s next decision full');
ok(w.emotions.of(C('jonas')).some((e) => e.type === 'guilt') && w.emotions.of(C('jonas')).some((e) => e.type === 'fear'), 'an honest liar feels guilt and fear');
ok(/# YOUR STORIES\n- You told [^:]+: "I was home all night[\s\S]*\(The truth: I was at the forge/.test(buildMessages(w, C('jonas'), { tier: 'full' })[1].content), 'YOUR STORIES for the liar (full tier)');
ok(/Careful: you told/.test(buildMessages(w, C('jonas'), { tier: 'light' })[1].content), 'light tier: one careful line');
const lt = buildTools(w, C('lena'));
ok(lt.find((x) => x.function.name === 'say')?.function.parameters.properties.trust_claim?.properties.from.enum.length, 'Lena may judge what she was told (trust_claim)');
w.applyAction(C('lena'), { name: 'wait', arguments: { reason: 'thinking', minutes: 1 } });
S.afterDecision(C('lena'), { name: 'wait', arguments: { trust_claim: { from: label('lena', 'jonas'), verdict: 'disbelieve', why: 'I saw him at the forge.' } } });
const caught = db.prepare('SELECT status FROM lies WHERE id = ?').get(lie.id);
ok(caught.status === 'caught' && db.prepare("SELECT COUNT(*) n FROM relationship_events WHERE citizen_id = 'lena' AND other_id = 'jonas' AND reason LIKE '%lied to me%' AND d_trust <= -3").get().n === 1, 'disbelieved with a contradiction: caught, a strong relationship event with the concrete reason');
// a true claim doubted
say('greta', 'lena', 'The bread is up a penny since the mill trouble.');
w.setActivity(C('lena'), { type: 'idle' });
move('greta', 'square'); say('greta', 'lena', 'The bread is up a penny since the mill trouble.');
S.afterDecision(C('lena'), { name: 'wait', arguments: { trust_claim: { from: label('lena', 'greta'), verdict: 'doubt', why: 'she always says that' } } });
ok(events('trust_claim').some((e) => e.actor === 'lena' && e.verdict === 'doubt' && !e.lieId), 'doubting a TRUE claim is possible and recorded (suspicion of an honest person)');
// retelling (Greta elsewhere, so she can only hear it retold)
move('greta', 'bakery');
const lie2 = say('jonas', 'anselm', 'Lena was home all night too, I saw her light.', { deceive: { truth: 'I saw her at the forge.', kind: 'cover', why: 'keep her out of it', check: { who: 'Lena', where: 'her house', when: 'last night' } } });
move('anselm', 'bakery');
w.setActivity(C('anselm'), { type: 'idle' });
say('anselm', 'greta', 'Jonas says Lena was home all night.');
const l2 = JSON.parse(db.prepare('SELECT heard_by FROM lies ORDER BY id DESC LIMIT 1').get().heard_by);
ok(l2.some((h) => h.citizen_id === 'greta' && h.how === 'retold' && h.from === 'anselm'), 'retelling recorded with from');
// told otherwise: two lies that don't match
move('tomas', 'bakery'); move('greta', 'bakery'); C('greta').inbox = [];
say('tomas', 'greta', 'Lena was at the tavern last night, drinking late.', { deceive: { truth: 'I have no idea where she was.', kind: 'fact', why: 'to look like I know things', check: { who: 'Lena', where: 'the tavern', when: 'last night' } } });
ok(C('greta').inbox.some((s) => s.data?.contradiction && /told you/.test(s.text)), `told otherwise: "${C('greta').inbox.find((s) => s.data?.contradiction)?.text ?? '—'}"`);

console.log('\n--- tells');
{
  const liarHonest = C('jonas'); const liarCunning = C('anselm');
  move('lena', 'square'); move('jonas', 'square'); move('anselm', 'square');
  w.emotions.bump(liarHonest, { type: 'fear', delta: 6, cause: 'x', source: 'director', raw: true });
  const fakeLie = { kind: 'cover' };
  let seed = 3; S.lies.rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const count = (c) => { let n = 0; for (let i = 0; i < 400; i++) n += S.lies.tells(c, [C('lena')], { lie: fakeLie }).length; return n; };
  const nH = count(liarHonest); const nC = count(liarCunning);
  let nT = 0; for (let i = 0; i < 400; i++) nT += S.lies.tells(liarHonest, [C('lena')], { lie: null, nervous: true }).length;
  ok(nH > nC * 1.5 && nT > 0 && nT < nH, `tells: honest frightened liar ${nH}/400, cunning liar ${nC}/400, nervous truths ${nT}/400`);
  ok(!events('tell').length || C('lena').inbox.filter((s) => s.data?.tell).every((s) => !/\blying\b|\blie\b|\bliar\b/i.test(s.text)), 'a tell never says "lying"');
  S.lies.rng = Math.random;
}

console.log('\n--- confession, framing, accusation');
{
  const before = Math.max(0, ...w.emotions.of(C('jonas')).filter((e) => e.type === 'guilt').map((e) => e.intensity));
  move('lena', 'square'); w.setActivity(C('jonas'), { type: 'idle' });
  const sayTool = buildTools(w, C('jonas')).find((x) => x.function.name === 'say');
  ok(sayTool.function.parameters.properties.confess?.enum.length, 'confess offered for standing lies');
  const own = db.prepare("SELECT id FROM lies WHERE liar_id = 'jonas' AND status != 'confessed' ORDER BY id LIMIT 1").get().id;
  say('jonas', 'lena', "I lied to you. I was at the forge last night.", { confess: own });
  const after = Math.max(0, ...w.emotions.of(C('jonas')).filter((e) => e.type === 'guilt').map((e) => e.intensity));
  ok(db.prepare('SELECT status FROM lies WHERE id = ?').get(own).status === 'confessed' && after < before, `confessed: guilt ${before.toFixed(1)} → ${after.toFixed(1)}`);
  // framing: plant Tomas's hammer in Jonas's house
  move('anselm', 'smithy');
  const hammer = [...w.objects.byId.values()].find((o) => o.typeId === 'hammer');
  w.objects.change(hammer.id, { holderId: 'anselm' }, { actorId: 'director', action: 'give', notify: false });
  move('anselm', 'house_tomas');
  w.setActivity(C('anselm'), { type: 'idle' });
  const pr = w.applyAction(C('anselm'), { name: 'put', arguments: { object: w.objects.alias(w.objects.get(hammer.id)), deceive: { truth: 'I took it and put it here myself.', kind: 'frame', why: 'so they blame the boy', check: { who: 'Jonas' } } } });
  const hist = db.prepare("SELECT actor_id FROM object_history WHERE object_id = ? AND action = 'put' ORDER BY id DESC LIMIT 1").get(hammer.id);
  ok(pr.ok && hist?.actor_id === 'anselm' && !/anselm/i.test(w.objects.surfaceText(w.objects.get(hammer.id))), 'a planted object: object_history keeps the true actor, the surface shows only where it is');
  ok(events('crime').some((e) => e.kind === 'framing' && e.actor === 'anselm'), 'framing is a crime event with the true perpetrator');
  ok(/# WHAT YOU'VE DONE[\s\S]*made Jonas look guilty[\s\S]*it isn't true/.test(buildMessages(w, C('anselm'))[1].content), 'framing stays in WHAT YOU\'VE DONE');
}

console.log('\n--- schemes');
{
  const c = C('kael') ?? C('anselm');
  const owner = C('anselm');
  const amb = S.ambitions.add(owner, { kind: 'revenge', text: 'See Tomas brought low in front of the whole village.', targetIds: ['tomas'], intensity: 8, secrecy: 'secret' }, { why: 'test' }) ?? S.ambitions.of('anselm')[0];
  const labels = w.memory.labelsFor(owner, [C('tomas'), C('jonas'), C('lena')]);
  const places = Object.keys(owner.knownPlaces ?? {});
  const types = [...w.objects.types.keys()];
  const s = S.schemes.create(owner, amb, {
    goal: 'Make the village believe Tomas stole the flour.', targets: [label('anselm', 'tomas')],
    steps: [
      { text: "Get Tomas's apron from the forge while he's at the tavern.", kind: 'obtain', at_place: 'smithy', absent: [label('anselm', 'tomas')], object_type: 'tunic' },
      { text: 'Obtain poison for his ale.', kind: 'obtain', object_type: 'poison' },
      { text: 'Steal something.', kind: 'obtain' },
      { text: 'Leave the apron by the flour sacks.', kind: 'act', at_place: 'bakery' },
      { text: 'Tell Greta I saw Tomas by her storeroom.', kind: 'deceive', with: [label('anselm', 'jonas')] },
    ],
  }, { trigger: 'test', labels, places: places.length ? places : [...w.rooms.keys()], types });
  ok(s && s.steps.length === 3 && s.data.rejected.length === 2, `invalid steps rejected (${s?.data.rejected.map((x) => x.why).join('; ')})`);
  ok(S.schemes.create(owner, amb, { goal: 'x', steps: [{ text: 'Obtain poison.', kind: 'obtain', object_type: 'poison' }] }, { trigger: 'test', labels, places, types }) === null, 'a scheme without a valid step is discarded');
  // due steps
  move('anselm', 'smithy'); move('tomas', 'smithy');
  S.schemes.lastDue = -Infinity; S.schemes.tick();
  ok(!owner.schemeStepNew, 'not due while Tomas is there (absent)');
  move('tomas', 'tavern'); S.schemes.lastDue = -Infinity; S.schemes.tick();
  ok(owner.schemeStepNew?.stepId === 's1', 'due once he is gone');
  ok(chooseTier(owner, { stimuli: [] }, w).reason === 'scheme_step', 'the first decision with a newly due step is full (scheme_step)');
  owner.schemeStepNew = null;
  ok(/# YOUR PLAN\nYour plan \(secret\): Make the village believe Tomas stole the flour[\s\S]*Now would be the moment: 1\. Get Tomas's apron/.test(buildMessages(w, owner, { tier: 'full' })[1].content), 'YOUR PLAN shows the goal and the due step');
  ok(owner.activity.type !== 'doing' || !/apron/.test(owner.activity.detail?.description ?? ''), 'code never performs the step');
  const st = buildTools(w, owner).find((x) => x.function.name === 'wait');
  ok(st.function.parameters.properties.scheme?.properties.step_done, 'the scheme field is offered');
  S.afterDecision(owner, { name: 'wait', arguments: { scheme: { id: s.id, step_done: 's1', reason: 'Got it from the peg.' } } });
  S.afterDecision(owner, { name: 'wait', arguments: { scheme: { id: s.id, abandon: true } } });
  const s1 = S.schemes.get(s.id);
  ok(s1.steps[0].status === 'done' && s1.status === 'active', 'step done; abandoning without a reason does nothing');
  S.afterDecision(owner, { name: 'wait', arguments: { scheme: { id: s.id, revise: { replace_step: 's4', with: { text: 'Hang the apron in the storeroom instead.' } }, reason: 'the sacks are watched' } } });
  ok(S.schemes.get(s.id).steps.find((x) => x.id === 's4').text.includes('storeroom') && S.schemes.get(s.id).data.history.some((h) => h.op === 'revise' && /watched/.test(h.why)), 'revise one step, with the reason in the history');
  // confiding and the proposal
  move('jonas', 'smithy'); move('lena', 'smithy');
  for (const id of ['jonas', 'lena']) { C(id).inbox = []; w.setActivity(C(id), { type: 'idle' }); }
  w.setActivity(owner, { type: 'idle' });
  const sayT = buildTools(w, owner).find((x) => x.function.name === 'say');
  ok(sayT.function.parameters.properties.confide?.properties.scheme.enum.includes(s.id), 'confide offered to the owner');
  say('anselm', 'jonas', 'Listen, lad. Tomas has had this coming. Help me make the village see what he is.', { confide: { scheme: s.id, reveal: 'full', ask: 'join' } });
  const s2 = S.schemes.get(s.id);
  ok(s2.exposedTo.includes('jonas') && s2.exposedTo.includes('lena'), 'everyone who heard is exposed (Jonas asked, Lena overheard)');
  ok(chooseTier(C('jonas'), { stimuli: C('jonas').inbox }, w).reason === 'proposal', 'the one asked decides at full (proposal)');
  ok(/asked you to join a plan/.test(buildMessages(w, C('jonas'))[1].content) && buildTools(w, C('jonas'))[0].function.parameters.properties.proposal, 'the proposal is in the prompt and offered as a field');
  ok(db.prepare("SELECT COUNT(*) n FROM memories WHERE citizen_id = 'lena' AND text LIKE '%overheard%'").get().n === 1, 'exposure leaves a memory with its source');
  S.afterDecision(C('jonas'), { name: 'wait', arguments: { proposal: { scheme: s.id, answer: 'join', reason: 'Tomas beats me.' } } });
  const acc = S.schemes.get(s.id).accomplices.find((a) => a.citizen_id === 'jonas');
  ok(acc?.status === 'in' && acc.commitment != null, `joined, commitment ${acc?.commitment}`);
  ok(/You're in on \S+'s plan/.test(buildMessages(w, C('jonas'))[1].content), 'the accomplice sees the plan in their prompt');
  // wavering
  w.relationships.change('jonas', 'tomas', { affinity: 6 }, { reason: 'he took me in', source: 'director' });
  w.emotions.bump(C('jonas'), { type: 'fear', delta: 8, cause: 'x', source: 'director', raw: true });
  w.emotions.bump(C('jonas'), { type: 'guilt', delta: 8, cause: 'x', source: 'director', raw: true });
  S.onReflection(C('jonas'));
  const acc2 = S.schemes.get(s.id).accomplices.find((a) => a.citizen_id === 'jonas');
  ok(acc2.status === 'wavering' && /having doubts/.test(buildMessages(w, C('jonas'))[1].content), `wavering below 3 (commitment ${acc2.commitment}), doubts in the prompt`);
  // betrayal: the accomplice tells the target (via the leak judge, stubbed)
  const realChat = w.llm.chat.bind(w.llm);
  w.llm.chat = async (o) => (o.purpose === 'leak_check' ? { toolCalls: [{ name: 'judge', arguments: { leaked: 'full', which: 1, what: 'the plan' } }], content: '' } : realChat(o));
  move('tomas', 'smithy'); w.setActivity(C('tomas'), { type: 'idle' });
  say('jonas', 'tomas', "Anselm means to pin the flour on you, master. Watch your apron.");
  await new Promise((r) => setTimeout(r, 20));
  const s3 = S.schemes.get(s.id);
  ok(s3.exposedTo.includes('tomas') && s3.status === 'exposed' && s3.accomplices.find((a) => a.citizen_id === 'jonas').status === 'betrayed', `the accomplice warned the target: exposed, betrayed (${s3.status})`);
  ok(events('leak').some((e) => e.actor === 'jonas' && e.leaked === 'full'), 'the leak check ran (a name in the words, then the judge)');
  w.llm.chat = realChat;
  // no plan more than once a day
  owner.schemePlans = { day: Math.floor(w.now / 1440), n: 1 };
  let planned = false; const realPlan = S.schemes.plan.bind(S.schemes); S.schemes.plan = async () => { planned = true; return null; };
  S.schemes.maybePlan(owner, { trigger: 'reflection' });
  ok(!planned, 'at most one planning call per citizen per game day');
  S.schemes.plan = realPlan;
}

console.log('\n--- the prompt-leak check (5.5, now with secret ambitions)');
{
  const sec = S.ambitions.of('tomas').find((a) => a.secrecy === 'secret');
  const leaks = findLeaks(w, `Some prompt that says: ${sec.text}`, 'lena');
  ok(leaks.some((l) => l.kind === 'secretGoal'), 'a secret ambition in someone else\'s prompt is caught');
}

console.log(`\n${pass} passed, ${fail} failed`);
w.stop();
process.exit(fail ? 1 : 0);
