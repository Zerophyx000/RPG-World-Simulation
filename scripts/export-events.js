// Export the whole world log (events + LLM calls with reasoning) straight from a database file, without
// a running server. Read-only. Same output as GET /api/export (server/ui/export.js).
//
//   node --disable-warning=ExperimentalWarning scripts/export-events.js [options] > out.jsonl
//   --db data/world.db   --format jsonl|md   --from <game min>   --to <game min>   --day <n>
//   --citizen <id>   --types action,say   --prompts (include full prompts)   --no-llm   --out <file>
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { exportOptions, exportFilename, streamExport } from '../server/ui/export.js';

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name) => argv.includes(`--${name}`);
const day = arg('day') != null ? Number(arg('day')) : null;
const opts = exportOptions({
  format: arg('format'), citizen: arg('citizen'), types: arg('types'),
  from: day != null ? (day - 1) * 1440 : arg('from'), to: day != null ? day * 1440 - 0.001 : arg('to'),
  prompts: has('prompts') ? '1' : '0', llm: has('no-llm') ? '0' : '1',
});
const db = new DatabaseSync(arg('db') ?? 'data/world.db', { readOnly: true });
const gameMinutes = (() => { try { return JSON.parse(db.prepare("SELECT value FROM world_state WHERE key = 'clock'").get()?.value ?? '{}').gameMinutes; } catch { return null; } })();
const outPath = arg('out') ?? (process.stdout.isTTY ? exportFilename(opts, gameMinutes) : null);
const out = outPath ? fs.createWriteStream(outPath) : process.stdout;
await streamExport(db, out, opts, { gameMinutes });
if (outPath) out.on('finish', () => console.error(`wrote ${outPath}`));
