// Step 11.5 (A1): every planning call that ended without a plan — a `scheme` call answered with no_plan (or "let it
// go" / "wait"), and every consolidation that had a grievance in its input but added no ambition — from one or more
// run data dirs, with the full reasoning and the voice mark (keyword hint), plus the split. Read-only.
//
//   node --disable-warning=ExperimentalWarning scripts/diagnose-plans.js <out.md> <dataDir> [<dataDir> …] [--eye marks.json] [--preface findings.md]
//
// --eye: a JSON file { "<dir>#<callId>": "in character" | "assistant voice" | "unclear", "<dir>#<callId>!note": "…" }
// with a human reader's marks; they are shown next to the keyword hint and decide the split when present.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { planningRows } from './lib/plans.js';

const argv = process.argv.slice(2);
const prefI = argv.indexOf('--preface');
const preface = prefI >= 0 ? fs.readFileSync(argv[prefI + 1], 'utf8') : '';
const eyeI = argv.indexOf('--eye');
const eye = eyeI >= 0 ? JSON.parse(fs.readFileSync(argv[eyeI + 1], 'utf8')) : {};
const [out, ...dirs] = argv.filter((a, i) => !['--eye', '--preface'].includes(a) && !['--eye', '--preface'].includes(argv[i - 1]));
const t = (m) => { const d = Math.floor(m / 1440) + 1; const x = ((m % 1440) + 1440) % 1440; return `D${d} ${String(Math.floor(x / 60)).padStart(2, '0')}:${String(Math.floor(x % 60)).padStart(2, '0')}`; };
const quote = (s) => String(s ?? '').trim().split('\n').map((l) => `> ${l}`).join('\n');

const all = [];
for (const dir of dirs) {
  const db = new DatabaseSync(path.join(dir, 'world.db'), { readOnly: true });
  const name = new Map(db.prepare('SELECT id, name FROM citizens').all().map((r) => [r.id, r.name]));
  const run = path.basename(dir);
  const rows = planningRows(db);
  for (const r of rows) all.push({ ...r, run, who: name.get(r.c.citizen_id) ?? r.c.citizen_id, key: `${run}#${r.c.id}` });
}
const refused = all.filter((r) => r.refused);
const markOf = (r) => eye[r.key] ?? r.voice.mark;
const split = refused.reduce((m, r) => { m[markOf(r)] = (m[markOf(r)] ?? 0) + 1; return m; }, {});
const hintSplit = refused.reduce((m, r) => { m[r.voice.mark] = (m[r.voice.mark] ?? 0) + 1; return m; }, {});
const byRun = dirs.map((d) => { const run = path.basename(d); const rs = all.filter((r) => r.run === run); return `| ${run} | ${rs.filter((r) => r.c.purpose === 'scheme').length} | ${rs.filter((r) => r.c.purpose === 'scheme' && r.refused).length} | ${rs.filter((r) => r.c.purpose === 'consolidate').length} | ${rs.filter((r) => r.c.purpose === 'consolidate' && r.refused).length} |`; });

const md = [
  '# Diagnosis: planning calls that ended without a plan (step 11 GLM runs)',
  preface ? `
${preface.trim()}
` : '',
  '',
  `Runs: ${dirs.map((d) => path.basename(d)).join(', ')}. A "refusal" is a \`scheme\` call answered with no plan, or a consolidation whose input held a grievance (WHAT WAS DONE TO YOU) that added no ambition.`,
  '',
  '| Run | scheme calls | no plan | consolidations with a grievance | no ambition added |', '|---|---:|---:|---:|---:|', ...byRun,
  '',
  `**Split of the ${refused.length} refusals${Object.keys(eye).length ? ' (by eye where marked, else the keyword hint)' : ' (keyword hint)'}:** ${Object.entries(split).map(([k, v]) => `${k} ${v}`).join(' · ')}`,
  Object.keys(eye).length ? `\nKeyword hint alone: ${Object.entries(hintSplit).map(([k, v]) => `${k} ${v}`).join(' · ')}` : '',
  '',
  '**Marks.** *In character*: reasons tied to the person and the situation ("He\'s twice my size", "I\'d only trip over it"). *Assistant voice*: generic prosocial reasoning ("the healthiest path", "constructive", "reconciliation", "rather than escalate", "best for everyone"). The keyword pass (`scripts/lib/voice.js`) is only a hint.',
  '',
  ...refused.map((r) => [
    `## ${r.run} · ${t(r.c.game_time)} · ${r.who} · ${r.c.purpose} (call ${r.c.id})`,
    '',
    `- **Answer:** ${String(r.choice).slice(0, 400)}`,
    `- **Why:** ${String(r.why ?? '').replace(/\s+/g, ' ').slice(0, 600) || '—'}`,
    `- **Mark:** ${markOf(r)}${eye[r.key] ? ' (by eye)' : ''} · keyword hint: ${r.voice.mark}${r.voice.hits.length ? ` (${r.voice.hits.slice(0, 4).join(', ')})` : ''}${eye[`${r.key}!note`] ? `\n- **Note:** ${eye[`${r.key}!note`]}` : ''}`,
    r.grievance ? `- **Grievance in the input:**\n\n${quote(r.grievance.slice(0, 1200))}` : '- **Grievance in the input:** none (a scheme call; its input is the ambition)',
    '',
    '**Reasoning:**', '', quote(r.c.reasoning || '(none)'), '',
  ].join('\n')),
].join('\n');
fs.writeFileSync(out, md);
console.error(`wrote ${out} (${Math.round(Buffer.byteLength(md) / 1024)} KB): ${refused.length} refusals of ${all.length} planning calls`);
