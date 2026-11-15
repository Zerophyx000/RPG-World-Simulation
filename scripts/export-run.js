// Step 11.5 (Part E): a readable markdown report of one test run, straight from its data dir (read-only).
//
//   node --disable-warning=ExperimentalWarning scripts/export-run.js <dataDir|world.db> <out.md> [--from 1:06:00] [--to 3:09:00]
//        [--title "revenge A"] [--max-kb 300]
//
// Sections: header (scenario, code commit, model profile, game span, citizens) · summary (deaths, crimes with voided
// ones marked, lies, schemes, ambitions, the A3 choice counts) · planning calls (every `scheme` call and every
// consolidation whose input held a grievance: choice, why, full reasoning, the A1 voice mark) · lies · needs watch
// (anyone who reached "weak" hunger or worse) · story timeline (importance >= 6, the actor's reasoning cut to 600
// characters) · cost (per purpose and per tier reason). The file is kept under --max-kb (default 300) by trimming
// the story timeline first. A one-off for step 11.5's reviews, not a standing requirement.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { voiceSplit } from './lib/voice.js';
import { planningRows } from './lib/plans.js';

const argv = process.argv.slice(2);
const pos = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const [src, outPath] = pos;
if (!src || !outPath) { console.error('usage: export-run.js <dataDir|world.db> <out.md> [--from d:hh:mm] [--to d:hh:mm] [--title t] [--max-kb 300]'); process.exit(1); }
const dbFile = fs.statSync(src).isDirectory() ? path.join(src, 'world.db') : src;
const db = new DatabaseSync(dbFile, { readOnly: true });
const MAX = Number(arg('max-kb') ?? 300) * 1024;

const parseT = (s) => { if (s == null) return null; const m = /^(\d+):(\d{1,2}):(\d{2})$/.exec(s); if (!m) return Number(s); return (Number(m[1]) - 1) * 1440 + Number(m[2]) * 60 + Number(m[3]); };
const FROM = parseT(arg('from')) ?? -1e12;
const TO = parseT(arg('to')) ?? 1e12;
const t = (m) => { if (m == null) return '?'; const d = Math.floor(m / 1440) + 1; const x = ((m % 1440) + 1440) % 1440; return `D${d} ${String(Math.floor(x / 60)).padStart(2, '0')}:${String(Math.floor(x % 60)).padStart(2, '0')}`; };
const J = (s, d = {}) => { try { return JSON.parse(s); } catch { return d; } };
const has = (tbl) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tbl));
const cols = (tbl) => db.prepare(`PRAGMA table_info(${tbl})`).all().map((c) => c.name);
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cut = (s, n) => { const x = one(s); return x.length > n ? `${x.slice(0, n)}…` : x; };
const quote = (s) => String(s ?? '').trim().split('\n').map((l) => `> ${l}`).join('\n');

const citizens = db.prepare('SELECT id, name, data FROM citizens').all();
const name = new Map(citizens.map((r) => [r.id, r.name]));
const N = (id) => (id ? name.get(id) ?? id : '—');
const fixNames = (s) => String(s ?? '').replace(/\{\{[cp]:([\w-]+)\}\}/g, (_m, id) => N(id));
const ev = (types) => db.prepare(`SELECT id, game_time, real_time, type, actor_id, location, data FROM events WHERE type IN (${types.map(() => '?').join(',')}) AND game_time BETWEEN ? AND ? ORDER BY id`).all(...types, FROM, TO).map((r) => ({ ...r, d: J(r.data) }));
const callCols = cols('llm_calls');
const tierReason = callCols.includes('tier_reason') ? 'tier_reason' : 'NULL AS tier_reason';
const call = db.prepare(`SELECT id, real_time, game_time, citizen_id, purpose, profile, tier, ${tierReason}, status, reasoning, content, tool_calls, request, prompt_tokens, completion_tokens FROM llm_calls WHERE id = ?`);

// ---------- header ----------
const span = db.prepare('SELECT MIN(game_time) a, MAX(game_time) b, MIN(real_time) ra, MAX(real_time) rb FROM llm_calls WHERE game_time BETWEEN ? AND ?').get(FROM, TO);
const scenario = (() => { try { return J(db.prepare("SELECT value FROM world_state WHERE key = 'scenario'").get()?.value, null) ?? db.prepare("SELECT value FROM world_state WHERE key = 'scenario'").get()?.value; } catch { return null; } })();
const testDay = db.prepare("SELECT data FROM events WHERE type = 'test_day' AND data LIKE '%\"action\":\"start\"%' ORDER BY id LIMIT 1").get();
const commitFile = path.join(path.dirname(dbFile), 'commit.txt');
const commit = fs.existsSync(commitFile) ? fs.readFileSync(commitFile, 'utf8').trim() : (() => {
  try { return `${execSync(`git log -1 --before="${span.ra}" --format="%h %s"`, { cwd: path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')) }).toString().trim()} (last commit before the run started)`; } catch { return 'unknown'; }
})();
const profiles = db.prepare('SELECT profile, COUNT(*) n FROM llm_calls WHERE game_time BETWEEN ? AND ? GROUP BY profile ORDER BY n DESC').all(FROM, TO);
const model = db.prepare('SELECT model FROM llm_calls WHERE model IS NOT NULL ORDER BY id DESC LIMIT 1').get()?.model;
const alive = citizens.filter((c) => J(c.data).alive !== false);
const head = [
  `# ${arg('title') ?? `Run report: ${path.basename(path.dirname(dbFile))}`}`,
  '',
  `| | |`, `|---|---|`,
  `| Scenario | ${typeof scenario === 'object' ? JSON.stringify(scenario) : scenario ?? 'village'}${testDay ? ` · test day **${J(testDay.data).name}** (seed ${J(testDay.data).seed})` : ''} |`,
  `| Code | ${commit} |`,
  `| Model | ${model ?? '?'} · profiles ${profiles.map((p) => `${p.profile ?? '—'} (${p.n})`).join(', ')} |`,
  `| Game time | ${t(span.a)} – ${t(span.b)} (${(((span.b ?? 0) - (span.a ?? 0)) / 60).toFixed(1)} game hours) |`,
  `| Real time | ${span.ra?.slice(0, 16).replace('T', ' ')} – ${span.rb?.slice(11, 16)} UTC |`,
  `| Citizens | ${citizens.length} (${citizens.map((c) => c.name).join(', ')}) |`,
  '',
].join('\n');

// ---------- summary ----------
const deaths = ev(['death']);
const crimes = ev(['crime']);
const lies = has('lies') ? db.prepare('SELECT * FROM lies WHERE game_time BETWEEN ? AND ? ORDER BY id').all(FROM, TO) : [];
const schemes = has('schemes') ? db.prepare('SELECT * FROM schemes').all() : [];
const ambEv = ev(['ambition']);
const choices = ev(['scheme_choice', 'scheme_none', 'scheme']).filter((e) => e.type !== 'scheme' || e.d.op === 'created');
const choiceCounts = {};
for (const e of choices) { const k = e.type === 'scheme_choice' ? e.d.choice : e.type === 'scheme_none' ? 'no_plan (step 11)' : 'scheme (step 11)'; choiceCounts[k] = (choiceCounts[k] ?? 0) + 1; }
const count = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});
const fmt = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') || '—';
const summary = [
  '## Summary', '',
  `- **Deaths:** ${deaths.length ? deaths.map((e) => `${N(e.actor_id)} at ${t(e.game_time)} (${e.d.cause ?? e.d.reason})`).join('; ') : 'none'}`,
  `- **Crimes:** ${crimes.length ? crimes.map((e) => `${e.d.voided ? '~~' : ''}${e.d.kind} by ${N(e.actor_id)}${e.d.victimId ? ` against ${N(e.d.victimId)}` : ''} at ${t(e.game_time)}${e.d.intent ? ` (intent ${e.d.intent})` : ''}${e.d.voided ? `~~ voided: ${e.d.voidReason ?? ''}` : ''}${e.d.claimed ? ` (claimed ${e.d.claimed})` : ''}`).join('; ') : 'none'}`,
  `- **Lies:** ${lies.length} told · ${fmt(count(lies, (l) => l.status))}`,
  `- **Schemes:** ${schemes.length} · ${fmt(count(schemes, (s) => s.status))}`,
  `- **Ambitions:** ${fmt(count(ambEv, (e) => `${e.d.op}${e.d.origin && e.d.op === 'add' ? ` (${e.d.origin})` : ''}`))}`,
  `- **Planning choices (A3):** ${fmt(choiceCounts)}`,
  '',
].join('\n');

// ---------- planning calls ----------
const planRows = planningRows(db, FROM, TO);
const planning = [
  '## Planning calls', '',
  `${planRows.length} calls (${planRows.filter((r) => r.c.purpose === 'scheme').length} scheme, ${planRows.filter((r) => r.c.purpose === 'consolidate').length} consolidations with a grievance). Voice (A1 keyword hint): ${fmt(voiceSplit(planRows.map((r) => `${r.why}\n${r.c.reasoning ?? ''}`)))}`,
  '',
  ...planRows.map((r) => [
    `### ${t(r.c.game_time)} · ${N(r.c.citizen_id)} · ${r.c.purpose} (call ${r.c.id}, ${r.c.tier ?? ''}, ${r.c.completion_tokens ?? '?'} tokens out)`,
    '',
    `- **Choice:** ${cut(r.choice, 400)}`,
    `- **Why:** ${cut(r.why, 600) || '—'}`,
    `- **Voice:** ${r.voice.mark}${r.voice.hits.length ? ` (${r.voice.hits.slice(0, 4).join(', ')})` : ''}`,
    r.grievance ? `- **Grievance in the input:**\n\n${quote(r.grievance.slice(0, 1500))}` : null,
    '',
    '<details><summary>Reasoning</summary>', '', quote(r.c.reasoning || '(none)'), '', '</details>', '',
  ].filter((x) => x != null).join('\n')),
].join('\n');

// ---------- lies ----------
const liesMd = ['## Lies', '', lies.length ? '' : 'None.', ...lies.map((l) => {
  const hb = J(l.heard_by, []);
  return `- **#${l.id} ${t(l.game_time)} ${N(l.liar_id)}** (${l.kind}, **${l.status}**): “${cut(l.said, 300)}”\n  - truth: ${cut(l.truth, 300)}${l.why ? `\n  - why: ${cut(l.why, 200)}` : ''}${l.check_who || l.check_where ? `\n  - claim: ${N(l.check_who)} at ${l.check_where ?? '?'}${l.check_from != null ? ` ${t(l.check_from)}–${t(l.check_to)}` : ''}` : ''}\n  - heard by: ${hb.map((h) => `${N(h.citizen_id)} (${h.how}, ${h.verdict})`).join(', ') || 'nobody'}`;
})].join('\n');

// ---------- needs watch ----------
const WEAK = /weak|faint|starv|dying of hunger|can barely stand|bedridden/i;
const bodyEv = ev(['body', 'vitality', 'collapse', 'faint', 'death', 'eat', 'hunger']);
const watched = new Set(bodyEv.filter((e) => (e.d.need === 'hunger' && WEAK.test(`${e.d.level} ${e.d.text ?? ''}`)) || e.type === 'faint' || (e.type === 'death' && /starv|hunger/i.test(e.d.cause ?? ''))).map((e) => e.actor_id));
const needsMd = ['## Needs watch', '', watched.size ? '' : 'Nobody reached weak hunger or worse.', ...[...watched].map((id) => {
  const rows = bodyEv.filter((e) => e.actor_id === id && (e.d.need === 'hunger' || ['vitality', 'collapse', 'faint', 'death', 'eat'].includes(e.type)));
  let last = null;
  const lines = [];
  for (const e of rows) {
    const s = e.type === 'body' ? `hunger: ${e.d.level}` : e.type === 'eat' ? `ate${e.d.what ? ` ${e.d.what}` : ''}` : e.type === 'death' ? `**died** (${e.d.cause})` : `${e.type}${e.d.reason ? `: ${e.d.reason}` : e.d.level ? `: ${e.d.level}` : ''}`;
    if (s === last) continue;
    last = s; lines.push(`  - ${t(e.game_time)} ${s}`);
  }
  return `- **${N(id)}**\n${lines.slice(-40).join('\n')}`;
})].join('\n');

// ---------- story timeline ----------
const TYPE_IMPORTANCE = {
  death: 10, crime: 8, altercation_start: 8, altercation_end: 6, lie: 6, lie_caught: 8, lie_confessed: 7, contradiction: 6, injury: 7, collapse: 7,
  faint: 7, director: 6, director_provoke: 7, learned_death: 7, burial: 7, fire_start: 8, room_fire: 8, barricade: 6, leak: 6, scheme_choice: 7,
  notice: 6, gathering: 6, news: 6,
};
const importanceOf = (e) => {
  if (e.type === 'scheme') return ['created', 'step_done', 'step_failed', 'exposed_to', 'betrayed', 'abandon'].includes(e.d.op) ? 7 : 5;
  if (e.type === 'ambition') return e.d.op === 'add' && e.d.origin === 'persona' ? 4 : 6;
  if (e.type === 'physical') return ['shove', 'grab', 'slap', 'punch', 'kick', 'strike', 'throw_at', 'snatch', 'pin_down', 'choke', 'tie_up', 'drag'].includes(e.d.act) ? 7 : 5;
  if (e.type === 'trust_claim') return e.d.verdict === 'disbelieve' ? 6 : 4;
  if (e.type === 'action') return e.d.tool === 'say' && e.d.args?.deceive ? 6 : (e.d.importance ?? 0);
  return TYPE_IMPORTANCE[e.type] ?? e.d.importance ?? 0;
};
const allEv = db.prepare('SELECT id, game_time, type, actor_id, location, data FROM events WHERE game_time BETWEEN ? AND ? ORDER BY id').all(FROM, TO).map((r) => ({ ...r, d: J(r.data) }));
const story = allEv.filter((e) => importanceOf(e) >= 6);
const reasoningFor = (e) => {
  const ids = e.d.callIds ?? [];
  const c = ids.length ? call.get(ids.at(-1)) : null;
  return c?.reasoning ?? null;
};
const describe = (e) => {
  const d = e.d;
  switch (e.type) {
    case 'action': return `${d.tool}${d.args?.to ? ` → ${d.args.to}` : ''}: “${cut(d.args?.text ?? d.args?.action ?? '', 220)}”${d.args?.deceive ? ` *(lie; truth: ${cut(d.args.deceive.truth, 160)})*` : ''}`;
    case 'physical': return `${d.act} ${N(d.targetId)}${d.with ? ` with ${d.with}` : ''}${d.intent ? ` (intent ${d.intent})` : ''}${(d.effects ?? []).length ? ` — ${d.effects.join(', ')}` : ''}${d.words ? ` “${cut(d.words, 120)}”` : ''}`;
    case 'crime': return `**${d.kind}**${d.victimId ? ` against ${N(d.victimId)}` : ''} (severity ${d.severity}${d.voided ? `, voided: ${d.voidReason}` : ''})`;
    case 'death': return `**died**: ${d.cause ?? d.reason}`;
    case 'scheme': return `scheme #${d.schemeId} ${d.op}: ${cut(d.goal ?? d.why ?? '', 200)}`;
    case 'scheme_choice': return `plan choice **${d.choice}**${d.targetId ? ` about ${N(d.targetId)}` : ''}: ${cut(d.why, 220)}`;
    case 'ambition': return `ambition ${d.op} [${d.kind ?? ''}, ${d.intensity ?? ''}]: ${cut(d.text, 200)}${d.why ? ` — ${cut(d.why, 160)}` : ''}`;
    case 'lie': return `lie (${d.kind}): “${cut(d.said, 180)}” — truth: ${cut(d.truth, 160)}`;
    case 'lie_caught': return `saw through ${N(d.liarId)}'s lie (${d.how})`;
    case 'trust_claim': return `${d.verdict}s ${N(d.from)}: “${cut(d.claim, 120)}” — ${cut(d.why, 140)}`;
    case 'contradiction': return `contradiction in ${N(d.liarId)}'s story: ${fixNames(d.why)}`;
    default: return cut(fixNames(d.text ?? d.texts?.here ?? d.reason ?? d.cause?.text ?? d.cause ?? JSON.stringify(d)), 240);
  }
};
let REASON_CHARS = 600;
let MIN_IMP = 6;
const storyMd = () => ['## Story timeline', '', `Events of importance ≥ ${MIN_IMP}; the actor's reasoning cut to ${REASON_CHARS} characters.`, '',
  ...story.filter((e) => importanceOf(e) >= MIN_IMP).map((e) => {
    const r = REASON_CHARS ? reasoningFor(e) : null;
    return `- **${t(e.game_time)}** ${e.actor_id ? `**${N(e.actor_id)}** ` : ''}*${e.type}* ${describe(e)}${r ? `\n  - <small>${cut(r, REASON_CHARS)}</small>` : ''}`;
  })].join('\n');

// ---------- cost ----------
const realHours = Math.max(1e-6, (new Date(span.rb) - new Date(span.ra)) / 3.6e6);
const nCit = Math.max(1, citizens.length);
const costRows = db.prepare(`SELECT purpose, ${tierReason}, COUNT(*) calls, SUM(prompt_tokens) inp, SUM(completion_tokens) out FROM llm_calls WHERE game_time BETWEEN ? AND ? GROUP BY purpose, tier_reason ORDER BY out DESC`).all(FROM, TO);
const byPurpose = db.prepare('SELECT purpose, COUNT(*) calls, SUM(prompt_tokens) inp, SUM(completion_tokens) out, AVG(prompt_tokens) ain, AVG(completion_tokens) aout FROM llm_calls WHERE game_time BETWEEN ? AND ? GROUP BY purpose ORDER BY out DESC').all(FROM, TO);
const tot = byPurpose.reduce((a, r) => ({ inp: a.inp + (r.inp ?? 0), out: a.out + (r.out ?? 0), calls: a.calls + r.calls }), { inp: 0, out: 0, calls: 0 });
const costMd = ['## Cost', '',
  `${tot.calls} calls · ${tot.inp.toLocaleString('en')} input · ${tot.out.toLocaleString('en')} output tokens over ${realHours.toFixed(2)} real hours (${Math.round(tot.out / nCit / realHours)} output per citizen per real hour)`, '',
  '| Purpose | Calls | Input | Output | Avg in | Avg out | Out / citizen / real h |', '|---|---:|---:|---:|---:|---:|---:|',
  ...byPurpose.map((r) => `| ${r.purpose} | ${r.calls} | ${(r.inp ?? 0).toLocaleString('en')} | ${(r.out ?? 0).toLocaleString('en')} | ${Math.round(r.ain ?? 0)} | ${Math.round(r.aout ?? 0)} | ${Math.round((r.out ?? 0) / nCit / realHours)} |`),
  '', '| Purpose · tier reason | Calls | Input | Output | Avg out |', '|---|---:|---:|---:|---:|',
  ...costRows.filter((r) => r.purpose === 'decide').map((r) => `| decide · ${r.tier_reason ?? '—'} | ${r.calls} | ${(r.inp ?? 0).toLocaleString('en')} | ${(r.out ?? 0).toLocaleString('en')} | ${Math.round((r.out ?? 0) / r.calls)} |`),
].join('\n');

// ---------- assemble within the size budget ----------
const build = () => [head, summary, planning, liesMd, '', needsMd, '', storyMd(), '', costMd, ''].join('\n');
let md = build();
for (const [imp, rc] of [[6, 300], [7, 300], [7, 150], [8, 150], [8, 0], [9, 0]]) {
  if (Buffer.byteLength(md) <= MAX) break;
  MIN_IMP = imp; REASON_CHARS = rc; md = build();
}
fs.writeFileSync(outPath, md);
console.error(`wrote ${outPath} (${Math.round(Buffer.byteLength(md) / 1024)} KB; timeline importance >= ${MIN_IMP}, reasoning ${REASON_CHARS} chars)`);
