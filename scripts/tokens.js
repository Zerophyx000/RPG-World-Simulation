// LLM usage for the last N real minutes: per purpose/profile, decide calls by tier and tier reason (step 10, 0.1), and
// output tokens per citizen per real hour — the number that decides whether 100 citizens fit the 1M/hour budget.
//   node scripts/tokens.js [minutes=60] [--db path/to/world.db]
// Read-only. Defaults to data/world.db (run it from the repo root).
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const dbAt = args.indexOf('--db');
const file = dbAt >= 0 ? args[dbAt + 1] : 'data/world.db';
const minutes = Number(args.find((a, i) => !a.startsWith('--') && i !== dbAt + 1) ?? 60);
const db = new DatabaseSync(file, { readOnly: true });
const since = `-${minutes} minutes`;
const hasReason = db.prepare('PRAGMA table_info(llm_calls)').all().some((c) => c.name === 'tier_reason');

console.table(db.prepare(`
  SELECT purpose,
         profile,
         COUNT(*)               AS calls,
         SUM(prompt_tokens)     AS input,
         SUM(completion_tokens) AS output,
         ROUND(AVG(completion_tokens)) AS avg_out,
         ROUND(AVG(duration_ms))       AS avg_ms
  FROM llm_calls
  WHERE real_time >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
  GROUP BY purpose, profile
`).all(since));

console.table(db.prepare(`
  SELECT tier, ${hasReason ? 'tier_reason' : "NULL AS tier_reason"}, COUNT(*) AS calls,
         SUM(completion_tokens) AS output, ROUND(AVG(completion_tokens)) AS avg_out
  FROM llm_calls
  WHERE purpose = 'decide' AND real_time >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
  GROUP BY tier, tier_reason ORDER BY calls DESC`).all(since));

const s = db.prepare(`
  SELECT COUNT(*) AS calls, SUM(tier = 'full') AS full, SUM(completion_tokens) AS output,
         COUNT(DISTINCT citizen_id) AS citizens, MIN(real_time) AS a, MAX(real_time) AS b,
         MIN(game_time) AS ga, MAX(game_time) AS gb
  FROM llm_calls WHERE purpose = 'decide' AND real_time >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`).get(since);
const all = db.prepare(`SELECT SUM(completion_tokens) AS output FROM llm_calls
  WHERE real_time >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`).get(since).output ?? 0;
if (s.calls) {
  const realH = Math.max(1 / 60, (Date.parse(s.b) - Date.parse(s.a)) / 3_600_000);
  const gameH = Math.max(1 / 60, (s.gb - s.ga) / 60);
  console.log(`decide: ${s.calls} calls, ${((s.full / s.calls) * 100).toFixed(1)}% full, ${s.citizens} citizens, ${realH.toFixed(2)} real h, ${gameH.toFixed(1)} game h`);
  console.log(`output tokens per citizen per real hour: decide ${Math.round(s.output / s.citizens / realH)}, all purposes ${Math.round(all / s.citizens / realH)}`);
  console.log(`output tokens per citizen per game hour: decide ${Math.round(s.output / s.citizens / gameH)}, all purposes ${Math.round(all / s.citizens / gameH)}`);
}
