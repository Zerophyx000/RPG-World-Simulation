// Step 5.5 backfill: every relationship that existed before reasons were recorded gets one 'seed' event
// (zero deltas), so no relationship is without a reason. The reason is the row's summary in their own words.
export function up(db) {
  const rows = db.prepare('SELECT citizen_id, other_id, familiarity, summary, updated_at FROM relationships').all();
  const has = db.prepare('SELECT 1 FROM relationship_events WHERE citizen_id = ? AND other_id = ? LIMIT 1');
  const ins = db.prepare(`INSERT INTO relationship_events (citizen_id, other_id, game_time, source, d_affinity, d_trust, d_familiarity, reason, evidence, strength)
                          VALUES (?, ?, ?, 'seed', 0, 0, 0, ?, '{"backfill":true}', 1.0)`);
  let now = 0;
  try {
    now = Number(JSON.parse(db.prepare("SELECT value FROM world_state WHERE key = 'clock'").get()?.value ?? '{}').gameMinutes) || 0;
  } catch { /* fresh world */ }
  let n = 0;
  for (const r of rows) {
    if (has.get(r.citizen_id, r.other_id)) continue;
    const reason = String(r.summary ?? '').trim()
      || (r.familiarity >= 5 ? "We've known each other for years." : "We've met before.");
    ins.run(r.citizen_id, r.other_id, r.updated_at ?? now, reason.slice(0, 300));
    n++;
  }
  if (n) console.log(`[db] backfilled ${n} relationship reasons`);
}
