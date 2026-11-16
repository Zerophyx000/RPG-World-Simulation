// Step 11: the 5.5 secret goals become secret ambitions (origin migrated_secret_goal), and every living citizen is
// queued for the two one-time jobs (persona traits, then ambitions) that run in the world while it keeps going
// (server/scheming/traits.js and ambitions.js pick up data.needsTraits / data.needsAmbitions). Nothing is reseeded.
export function up(db) {
  const now = (() => {
    try { return Number(JSON.parse(db.prepare("SELECT value FROM world_state WHERE key = 'clock'").get()?.value ?? '{}').gameMinutes) || 0; } catch { return 0; }
  })();
  const parse = (s) => { try { return JSON.parse(s ?? '{}') ?? {}; } catch { return {}; } };
  const rows = db.prepare('SELECT id, alive, data FROM citizens').all();
  const update = db.prepare('UPDATE citizens SET data = ? WHERE id = ?');
  const insert = db.prepare(`INSERT INTO ambitions (citizen_id, kind, text, target_ids, intensity, secrecy, status, origin, created_at, updated_at, data)
                             VALUES (?, 'secret', ?, '[]', 6, 'secret', 'active', 'migrated_secret_goal', ?, ?, ?)`);
  let moved = 0;
  let queued = 0;
  for (const r of rows) {
    const d = parse(r.data);
    const goals = Array.isArray(d.persona?.secretGoals) ? d.persona.secretGoals.filter((g) => String(g ?? '').trim()) : [];
    for (const g of goals.slice(0, 3)) {
      insert.run(r.id, String(g).trim().slice(0, 300), now, now, JSON.stringify({ history: [{ at: now, op: 'migrated', why: 'a private aim from before (step 5.5)' }] }));
      moved++;
    }
    if (goals.length) d.persona.secretGoals = [];
    if (r.alive) {
      const t = d.persona?.traits ?? {};
      if (t.honesty == null || t.cunning == null) d.needsTraits = true;
      d.needsAmbitions = true;
      queued++;
    }
    update.run(JSON.stringify(d), r.id);
  }
  console.log(`[db] step 11: ${moved} secret goals → secret ambitions; ${queued} citizens queued for traits and ambitions`);
}
