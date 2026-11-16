// Step 11.5 (A5): every living citizen is queued for one `persona_flaws` call (server/scheming/traits.js picks up
// data.needsFlaws while the world keeps running). It reads the persona and makes 1–2 flaws, a one-line worst self and
// the new `grudge` trait explicit, without changing who they are: honesty and cunning are kept. Nothing is reseeded.
export function up(db) {
  const parse = (s) => { try { return JSON.parse(s ?? '{}') ?? {}; } catch { return {}; } };
  const rows = db.prepare('SELECT id, alive, data FROM citizens').all();
  const update = db.prepare('UPDATE citizens SET data = ? WHERE id = ?');
  let queued = 0;
  for (const r of rows) {
    if (!r.alive) continue;
    const d = parse(r.data);
    const p = d.persona ?? {};
    if (Array.isArray(p.flaws) && p.flaws.length && p.worstSelf && p.traits?.grudge != null) continue;
    d.needsFlaws = true;
    update.run(JSON.stringify(d), r.id);
    queued++;
  }
  console.log(`[db] step 11.5: ${queued} citizens queued for flaws, worst self and grudge`);
}
