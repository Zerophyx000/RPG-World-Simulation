import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/world.db', { readOnly: true });
const minutes = Number(process.argv[2] ?? 60);

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
`).all(`-${minutes} minutes`));