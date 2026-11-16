// Step 11.5 (C4): crime events logged before the intent rules (C1) for acts meant as care, or as defence against
// someone who was attacking the defender in that fight, are marked voided (with the reason). They stay in the log;
// the law step ignores voided crimes. The intent comes from the matching `physical` event (same actor, victim and
// fight, or the actor's last act on the victim before the crime). Also voided: a manslaughter or murder recorded for a
// death that came from hunger, cold or illness (step 10 blamed any death within a day of a blow).
export function up(db) {
  const parse = (s) => { try { return JSON.parse(s ?? '{}') ?? {}; } catch { return {}; } };
  const crimes = db.prepare("SELECT id, game_time, actor_id, data FROM events WHERE type = 'crime'").all();
  const acts = db.prepare(`SELECT game_time, actor_id, data FROM events WHERE type = 'physical' AND actor_id = ? AND game_time <= ? AND game_time >= ? ORDER BY id DESC`);
  const attacks = db.prepare(`SELECT 1 FROM events WHERE type = 'physical' AND actor_id = ? AND game_time <= ? AND game_time >= ?
    AND json_extract(data, '$.targetId') = ? AND json_extract(data, '$.act') IN ('shove','grab','slap','punch','kick','strike','throw_at','snatch','pin_down','choke','tie_up','drag') AND COALESCE(json_extract(data, '$.intent'), 'hurt') NOT IN ('care', 'defend') LIMIT 1`);
  const deathOf = db.prepare("SELECT data FROM events WHERE type = 'death' AND actor_id = ? ORDER BY id DESC LIMIT 1");
  const update = db.prepare('UPDATE events SET data = ? WHERE id = ?');
  let voided = 0;
  for (const cr of crimes) {
    const d = parse(cr.data);
    if (d.voided || !d.victimId) continue;
    if (['manslaughter', 'murder'].includes(d.kind)) {
      const cause = String(parse(deathOf.get(d.victimId)?.data).cause ?? d.cause ?? '');
      if (/starvation|hunger|cold|chill|illness/i.test(cause)) { update.run(JSON.stringify({ ...d, voided: true, voidReason: `the death came from ${cause}, not the act (step 11.5)` }), cr.id); voided++; }
      continue;
    }
    if (!['assault', 'unlawful_restraint', 'attempted_murder'].includes(d.kind)) continue;
    const act = acts.all(cr.actor_id, cr.game_time, cr.game_time - 60).map((r) => parse(r.data))
      .find((a) => a.targetId === d.victimId && (!d.altercationId || !a.altercationId || a.altercationId === d.altercationId));
    const intent = d.intent ?? act?.intent ?? null;
    let why = null;
    if (intent === 'care') why = 'the act was meant as care (step 11.5 C1)';
    else if (intent === 'defend' && attacks.get(d.victimId, cr.game_time, cr.game_time - 60, cr.actor_id)) why = 'defence against someone attacking the defender (step 11.5 C1)';
    if (!why) continue;
    update.run(JSON.stringify({ ...d, voided: true, voidReason: why, intent }), cr.id);
    voided++;
  }
  console.log(`[db] step 11.5: ${voided} crime events voided (care, or defence against an aggressor)`);
}
