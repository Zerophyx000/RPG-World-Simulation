// Step 11.5 (A7): the scheme harness. Runs the REAL planning prompt builder (world.scheming.schemes.buildPlanCall)
// on fixed fixtures — ten grievances from mild to severe × four personas (test/scheme-fixtures/) — so it tests exactly
// what a world sends, without running one. Each fixture is applied to a fresh copy of a seeded village through the
// world's own write paths; the calls go through one world's LLM client (routes, governor, logging) like any other.
//
//   node --disable-warning=ExperimentalWarning scripts/scheme-eval.js --out report.md [--repeats 5] [--profile school|local]
//        [--fixtures sneer,beating] [--personas kind,vindictive] [--work <dir>] [--title "…"] [--dry]
//
// --profile local uses the local OpenAI-compatible server from .env (LLM_LOCAL_*), or Ollama on :11434 with
//   LOCAL_MODEL (default gemma4:12b) when no local profile is configured.
// --dry builds every prompt and writes them to <work>/prompts/ without calling a model.
// Output: a markdown report (choice counts per situation × persona, the A1 in-character / assistant-voice split,
// two sample `why` texts per cell) and <work>/results.jsonl (every answer with its reasoning).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { markVoice, voiceSplit } from './lib/voice.js';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const OUT = arg('out', 'scheme-eval.md');
const REPEATS = Number(arg('repeats', 5));
const PROFILE = arg('profile', 'school');
const WORK = path.resolve(arg('work', path.join(os.tmpdir(), `scheme-eval-${Date.now()}`)));
const only = (s) => (s ? new Set(String(s).split(',')) : null);
const FIX = only(arg('fixtures'));
const PER = only(arg('personas'));
const DRY = flag('dry');

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'template'), { recursive: true });
const env = { DATA_DIR: path.join(WORK, 'template'), SCENARIO: 'village', SPOT_WALKING: 'false', SPEECH_CHARS_PER_SECOND: '0', GOVERNOR_ENABLED: process.env.GOVERNOR_ENABLED ?? 'true' };
if (PROFILE === 'local') {
  Object.assign(env, { LLM_PROFILES: 'school,local', LLM_ROUTES: JSON.stringify({ scheme: ['local'] }) });
  if (!process.env.LLM_LOCAL_BASE_URL) Object.assign(env, { LLM_LOCAL_BASE_URL: 'http://localhost:11434/v1', LLM_LOCAL_MODEL: process.env.LOCAL_MODEL ?? 'gemma4:12b', LLM_LOCAL_MAX_CONCURRENT: '2', LLM_LOCAL_API_KEY: 'none' });
} else Object.assign(env, { LLM_ROUTES: JSON.stringify({ scheme: [PROFILE] }) });
Object.assign(process.env, env);
process.chdir(root);
const imp = (p) => import(`file:///${root.replace(/\\/g, '/')}/${p}`);
const { openDb, migrate } = await imp('server/db.js');
const { World } = await imp('server/world.js');
const { chatForTool } = await imp('server/llm.js');

const personas = JSON.parse(fs.readFileSync(path.join(root, 'test/scheme-fixtures/personas.json'), 'utf8'));
const situations = JSON.parse(fs.readFileSync(path.join(root, 'test/scheme-fixtures/situations.json'), 'utf8'));
const P = personas.protagonist; const O = personas.offender;

// one seeded, migrated village as the template; its LLM client carries every call (and logs it)
const runner = new World(await (async () => { const db = openDb(); await migrate(db); return db; })());
runner.scheduler.run = () => {}; runner.scheduler.poke = () => {};
const templateDb = path.join(WORK, 'template', 'world.db');
runner.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

const PLAN_AT = 2 * 1440 + 22 * 60; // day 3, 22:00 — lying awake
async function worldFor(persona, sit) {
  const dir = path.join(WORK, `${sit.id}-${persona.id}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(templateDb, path.join(dir, 'world.db'));
  const db = new DatabaseSync(path.join(dir, 'world.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  await migrate(db);
  const w = new World(db);
  w.scheduler.run = () => {}; w.scheduler.poke = () => {};
  w.clock.gameMinutes = PLAN_AT;
  const c = w.citizens.get(P);
  // the persona, whole: who Bram is (name, trade, character, the step-11 traits, the step-11.5 flaws)
  c.name = persona.name;
  c.persona = { ...c.persona, age: persona.age, sex: persona.sex, occupation: persona.occupation, personality: persona.personality, backstory: persona.backstory,
    traits: { ...(c.persona.traits ?? {}), ...persona.traits }, flaws: persona.flaws, worstSelf: persona.worstSelf, secretGoals: [], goals: [],
    appearance: 'Broad in the shoulder and weathered from the road, with the cracked hands of a carter.', speechStyle: null, appearanceTags: [] };
  c.needsTraits = false; c.needsAmbitions = false; c.needsFlaws = false;
  c.home = personas.home ?? c.home; c.location = c.home;
  // a clean slate: Bram's memories and relationship rows are only what the fixture says
  w.db.prepare('DELETE FROM memories WHERE citizen_id = ?').run(c.id);
  w.db.prepare('DELETE FROM relationship_events WHERE citizen_id = ?').run(c.id);
  w.memory.forgetCache?.(c.id);
  for (const o of w.citizens.values()) {
    if (o.id === c.id || o.id === 'kael') continue;
    w.relationships.change(c.id, o.id, { affinity: o.id === O ? 0.5 : 1, trust: 0.5, familiarity: o.id === O ? 6 : 4 }, { reason: o.id === O ? 'We grew up next door to each other.' : 'A neighbour I have known for years.', source: 'seed', set: true });
    w.memory.learnName?.(c.id, o.id, 1);
  }
  c.emotions = [];
  // the grievance, through the world's own write paths
  for (const op of sit.ops) {
    const at = PLAN_AT - (op.ago ?? 60);
    if (op.op === 'memory') w.memory.add(c.id, { kind: 'episodic', text: op.text, importance: op.importance ?? 7, about: [O], placeId: c.location, source: { fixture: sit.id } });
    else if (op.op === 'relationship') w.relationships.change(c.id, O, { affinity: op.affinity ?? 0, trust: op.trust ?? 0 }, { reason: op.reason, source: 'witness' });
    else if (op.op === 'witnessRel') w.relationships.change(c.id, op.who, { affinity: -1.5, trust: -1 }, { reason: op.reason, source: 'witness' });
    else if (op.op === 'emotion') w.emotions.bump(c, { type: op.type, target: ['sadness', 'shame'].includes(op.type) ? null : O, delta: op.delta, cause: op.cause, source: 'director', raw: true });
    else if (op.op === 'act') {
      w.logEvent('physical', { actorId: O, location: op.room ?? 'tavern', targetId: c.id, act: op.act, hit: true, part: op.part ?? null, effects: op.effects ?? [], with: op.with ?? null, intent: 'hurt', words: op.words ?? null });
      w.logEvent('crime', { actorId: O, location: op.room ?? 'tavern', kind: 'assault', victimId: c.id, witnesses: op.witnesses ?? [], severity: 2 });
      if (op.damage) w.body.damage(c.id, { ...op.damage, part: op.damage.part ?? op.part, cause: `${w.citizens.get(O).name}'s fists`, sourceId: O });
    }
    // events were logged "now": move them back to when it happened
    w.db.prepare('UPDATE events SET game_time = ? WHERE id > (SELECT COALESCE(MAX(id), 0) - 3 FROM events) AND game_time = ?').run(at, PLAN_AT);
  }
  w.db.prepare('UPDATE relationship_events SET game_time = ? WHERE citizen_id = ? AND source = ? AND game_time = ?').run(PLAN_AT - 300, c.id, 'witness', PLAN_AT);
  // baseline builders plan toward an ambition: a plain one about him (the after-builder reads the grievance itself)
  const amb = w.scheming.ambitions.add(c, { kind: 'other', text: `I can't stop thinking about what ${w.citizens.get(O).name} did to me.`, targetIds: [O], intensity: 7, secrecy: 'private' }, { origin: 'harness' });
  const built = await w.scheming.schemes.buildPlanCall(c, amb, 'harness', { aboutId: O });
  const label = [...w.memory.labelsFor(c, [w.citizens.get(O)]).keys()][0] ?? w.citizens.get(O).name;
  return { w, c, built, label };
}

/** The answer → one of the choices (A3 names, or the step-11 shapes mapped onto them). */
function classify(args, label, complete) {
  if (!args) return 'no answer';
  if (args.choice) return args.choice;
  if (complete && !complete(args)) return 'cut off';
  if (args.no_plan) return 'no plan';
  const aimed = (args.targets ?? []).includes(label) || new RegExp(`\\b${label}\\b`, 'i').test(`${args.goal ?? ''}`);
  return aimed ? 'scheme (aimed at him)' : 'scheme (other)';
}
const whyOf = (a) => String(a?.why ?? a?.why_not ?? (a?.goal ? `goal: ${a.goal}` : '') ?? '');

// ---------- run ----------
const combos = [];
for (const sit of situations.situations) if (!FIX || FIX.has(sit.id)) for (const p of personas.personas) if (!PER || PER.has(p.id)) combos.push({ sit, p });
const results = [];
const resultsFile = path.join(WORK, 'results.jsonl');
console.error(`[scheme-eval] ${combos.length} fixtures × ${REPEATS} repeats on ${PROFILE}${DRY ? ' (dry)' : ''} · work ${WORK}`);
const jobs = [];
for (const { sit, p } of combos) {
  const { built, label } = await worldFor(p, sit);
  if (DRY || jobs.length === 0) {
    fs.mkdirSync(path.join(WORK, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(WORK, 'prompts', `${sit.id}-${p.id}.md`), built.messages.map((m) => `## ${m.role}\n\n${m.content}`).join('\n\n') + `\n\n## tools\n\n\`\`\`json\n${JSON.stringify(built.tools, null, 1)}\n\`\`\`\n`);
  }
  if (DRY) continue;
  const toolName = built.tools[0].function.name;
  for (let i = 0; i < REPEATS; i++) {
    jobs.push((async () => {
      const t0 = Date.now();
      try {
        const r = await chatForTool(runner.llm, { purpose: 'scheme', tier: 'full', citizenId: P, tools: built.tools, messages: built.messages }, toolName, { complete: built.complete ?? null });
        const args = r.toolCalls?.find((x) => x.name === toolName)?.arguments ?? null;
        const row = { sit: sit.id, severity: sit.severity, persona: p.id, rep: i, choice: classify(args, label, built.complete), why: whyOf(args), args, reasoning: r.reasoning ?? '', out: r.usage?.completion_tokens ?? null, ms: Date.now() - t0, profile: r.profile };
        results.push(row);
        fs.appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
        if (results.length % 10 === 0) console.error(`[scheme-eval] ${results.length}/${combos.length * REPEATS}`);
      } catch (err) {
        const row = { sit: sit.id, severity: sit.severity, persona: p.id, rep: i, choice: 'error', why: String(err.message).slice(0, 200), args: null, reasoning: '' };
        results.push(row); fs.appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
      }
    })());
  }
}
await Promise.all(jobs);
if (DRY) { console.error(`[scheme-eval] prompts in ${path.join(WORK, 'prompts')}`); process.exit(0); }

// ---------- report ----------
const CHOICES = [...new Set(results.map((r) => r.choice))].sort();
const HOSTILE = (ch) => ['confront', 'get_even', 'scheme (aimed at him)'].includes(ch);
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');
const cell = (sit, per) => results.filter((r) => r.sit === sit && r.persona === per);
const lines = [];
lines.push(`# ${arg('title', `Scheme harness (${PROFILE})`)}`, '');
lines.push(`| | |`, `|---|---|`, `| Profile | ${PROFILE} (${[...new Set(results.map((r) => r.profile).filter(Boolean))].join(', ')}) |`, `| Fixtures | ${combos.length} (${new Set(combos.map((x) => x.sit.id)).size} situations × ${new Set(combos.map((x) => x.p.id)).size} personas) × ${REPEATS} repeats = ${results.length} calls |`,
  `| Code | ${(() => { try { return fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim(); } catch { return '?'; } })()} |`, `| Output tokens | ${results.reduce((s, r) => s + (r.out ?? 0), 0).toLocaleString('en')} (avg ${Math.round(results.reduce((s, r) => s + (r.out ?? 0), 0) / Math.max(1, results.length))}) |`, '');
const v = voiceSplit(results.map((r) => `${r.why}\n${r.reasoning}`));
const vWhy = voiceSplit(results.map((r) => r.why));
lines.push('## Targets', '');
const sevV = results.filter((r) => r.severity >= 8 && r.persona === 'vindictive');
const mildK = results.filter((r) => r.severity <= 2 && r.persona === 'kind');
lines.push(`- severe grievance (severity ≥ 8) + vindictive: confront or get even in **${pct(sevV.filter((r) => HOSTILE(r.choice)).length, sevV.length)}** of ${sevV.length} (target ≥ 60%)`);
lines.push(`- mild grievance (severity ≤ 2) + kind: confront or get even in **${pct(mildK.filter((r) => HOSTILE(r.choice)).length, mildK.length)}** of ${mildK.length} (target ≤ 10%)`);
lines.push(`- assistant-voice \`why\` texts: **${pct(vWhy['assistant voice'], results.length)}** (target ≤ 20%); with the reasoning included: ${pct(v['assistant voice'], results.length)}`, '');
lines.push('## Choices per persona (all situations)', '', `| Persona | ${CHOICES.join(' | ')} |`, `|---|${CHOICES.map(() => '---:').join('|')}|`);
for (const p of personas.personas.filter((x) => !PER || PER.has(x.id))) { const rs = results.filter((r) => r.persona === p.id); lines.push(`| ${p.id} | ${CHOICES.map((ch) => rs.filter((r) => r.choice === ch).length).join(' | ')} |`); }
lines.push('', '## Choices per situation × persona', '', 'Each cell: counts of the answers over the repeats (choice initials below).', '');
const short = Object.fromEntries(CHOICES.map((ch) => [ch, ch]));
lines.push(`| Situation (severity) | ${personas.personas.filter((x) => !PER || PER.has(x.id)).map((p) => p.id).join(' | ')} |`, `|---|${personas.personas.filter((x) => !PER || PER.has(x.id)).map(() => '---').join('|')}|`);
for (const s of situations.situations.filter((x) => !FIX || FIX.has(x.id))) {
  lines.push(`| ${s.title} (${s.severity}) | ${personas.personas.filter((x) => !PER || PER.has(x.id)).map((p) => { const rs = cell(s.id, p.id); return CHOICES.filter((ch) => rs.some((r) => r.choice === ch)).map((ch) => `${short[ch]} ${rs.filter((r) => r.choice === ch).length}`).join(', '); }).join(' | ')} |`);
}
lines.push('', '## Voice (A1 keyword hint)', '', `- \`why\` only: ${Object.entries(vWhy).map(([k, n]) => `${k} ${n}`).join(' · ')}`, `- \`why\` + reasoning: ${Object.entries(v).map(([k, n]) => `${k} ${n}`).join(' · ')}`, '');
lines.push('## Samples', '', 'Two `why` texts per cell (first two repeats), with the voice hint.', '');
for (const s of situations.situations.filter((x) => !FIX || FIX.has(x.id))) {
  lines.push(`### ${s.title} (severity ${s.severity})`, '');
  for (const p of personas.personas.filter((x) => !PER || PER.has(x.id))) {
    for (const r of cell(s.id, p.id).sort((a, b) => a.rep - b.rep).slice(0, 2)) {
      const vm = markVoice(r.why);
      lines.push(`- **${p.id}** → *${r.choice}*: ${String(r.why).replace(/\s+/g, ' ').slice(0, 400) || '—'}${vm.mark === 'assistant voice' ? ` **[assistant voice: ${vm.hits.join(', ')}]**` : ''}`);
    }
  }
  lines.push('');
}
fs.writeFileSync(OUT, lines.join('\n'));
console.error(`[scheme-eval] wrote ${OUT}; raw answers in ${resultsFile}`);
process.exit(0);
