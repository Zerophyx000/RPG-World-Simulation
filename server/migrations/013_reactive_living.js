// Step 9.5 migration: day plans become intentions; who knows of which death is rebuilt from the log.
//
// 1. Plans: each citizen's remaining plan steps (and yesterday's unfinished ones) become intentions (source 'carried');
//    plan, yesterdayPlan and needsPlan are removed. Habits are generated at runtime (habits.js), not here.
// 2. Deaths: for every dead citizen, each living citizen's knowledge is reconstructed from events:
//      witnessed — awake in the room when they died (their last located event before the death was there)
//      found     — in that room, awake, while the body lay there, afterwards
//      told      — a memory of theirs mentions the death with words of being told ("says", "told", "heard")
//    Anyone else is reset to not knowing: grief aimed at a dead person they don't know about is removed (that grief
//    leaked in by step 7, which grieved everyone at the moment of death).
// 3. Bodies: their short name no longer says whose body it is ("body"); decay states follow from the death time.
export function up(db) {
  const now = (() => {
    try { return Number(JSON.parse(db.prepare("SELECT value FROM world_state WHERE key = 'clock'").get()?.value ?? '{}').gameMinutes) || 0; } catch { return 0; }
  })();
  const rows = db.prepare('SELECT id, name, alive, location, died_at, data FROM citizens').all();
  const update = db.prepare('UPDATE citizens SET data = ? WHERE id = ?');
  const parse = (s) => { try { return JSON.parse(s ?? '{}') ?? {}; } catch { return {}; } };
  const citizens = rows.map((r) => ({ ...r, d: parse(r.data) }));
  const dead = citizens.filter((r) => !r.alive);
  const deathEv = new Map(db.prepare("SELECT actor_id, game_time, location, data FROM events WHERE type = 'death'").all().map((e) => [e.actor_id, e]));
  const locatedBefore = db.prepare('SELECT location, game_time FROM events WHERE actor_id = ? AND location IS NOT NULL AND game_time <= ? ORDER BY game_time DESC, id DESC LIMIT 1');
  const activityBefore = db.prepare("SELECT data FROM events WHERE actor_id = ? AND type = 'activity' AND game_time <= ? ORDER BY game_time DESC, id DESC LIMIT 1");
  const firstThereAfter = db.prepare("SELECT game_time FROM events WHERE actor_id = ? AND location = ? AND game_time > ? AND type NOT IN ('activity') ORDER BY game_time, id LIMIT 1");
  const memoriesAbout = db.prepare("SELECT game_time, kind, text FROM memories WHERE citizen_id = ? AND game_time > ? AND text LIKE ? ORDER BY game_time");
  let converted = 0; let known = 0; let reset = 0;

  for (const c of citizens) {
    const d = c.d;
    // ---- 1. plans → intentions
    const intents = Array.isArray(d.intentions) ? d.intentions : [];
    let seq = Math.max(0, ...intents.map((i) => Number(String(i.id).slice(1)) || 0));
    const add = (text) => {
      const t = String(text ?? '').trim().slice(0, 100);
      if (t.length < 3 || intents.length >= 8 || intents.some((i) => i.text.toLowerCase() === t.toLowerCase())) return;
      intents.push({ id: `i${++seq}`, text: t, about: [], place: null, source: 'carried', createdAt: now, touchedAt: now, weight: 0.6 });
      converted++;
    };
    if (d.plan?.steps) for (const s of d.plan.steps.slice(d.plan.cursor ?? 0)) if (s.status !== 'done' && s.status !== 'failed') add(s.note || s.description || stepWords(s));
    for (const u of d.yesterdayPlan?.unfinished ?? []) add(u);
    d.intentions = intents;
    d.intentionSeq = seq;
    delete d.plan; delete d.yesterdayPlan; delete d.needsPlan;

    // ---- 2. who knows of which death
    if (!c.alive) { update.run(JSON.stringify(d), c.id); continue; }
    d.knownDeaths = d.knownDeaths && typeof d.knownDeaths === 'object' ? d.knownDeaths : {};
    for (const x of dead) {
      if (d.knownDeaths[x.id]) continue;
      const ev = deathEv.get(x.id);
      const T = ev?.game_time ?? x.died_at;
      const L = ev?.location ?? x.location;
      if (T == null) continue;
      let entry = null;
      const at = locatedBefore.get(c.id, T);
      const act = parse(activityBefore.get(c.id, T)?.data);
      const awake = !['sleeping', 'collapsed'].includes(act.to);
      if (at?.location === L && awake) entry = { learnedAt: T, how: 'witnessed', certainty: 'certain', where: L };
      if (!entry && L) {
        const there = firstThereAfter.get(c.id, L, T);
        if (there) entry = { learnedAt: there.game_time, how: 'found', certainty: 'certain', where: L };
      }
      if (!entry) {
        const told = memoriesAbout.all(c.id, T, `%${x.name}%`).find((m) => /\b(dead|died|death|body|buried|grave)\b/i.test(m.text) && /\b(told|tells|says|said|heard|word)\b/i.test(m.text));
        if (told) entry = { learnedAt: told.game_time, how: 'told:unknown', certainty: 'believed', where: L };
      }
      if (entry) { d.knownDeaths[x.id] = entry; known++; continue; }
      // reset: grief and on-my-mind about a death they never learned of
      const before = (d.emotions ?? []).length;
      d.emotions = (d.emotions ?? []).filter((e) => !(e.target === x.id && (e.data?.grief || e.type === 'sadness')));
      d.onMyMind = (d.onMyMind ?? []).filter((m) => !new RegExp(`\\b${x.name}\\b[^.]{0,40}\\b(dead|died|body)\\b`, 'i').test(String(m.text)));
      if (d.emotions.length !== before) reset++;
    }
    // grief they keep becomes proper grief (aimed, lingering)
    for (const e of d.emotions ?? []) {
      if (e.type === 'sadness' && e.target && d.knownDeaths[e.target] && !e.data?.grief) e.data = { ...(e.data ?? {}), grief: true, halfLifeHours: 240 };
    }
    update.run(JSON.stringify(d), c.id);
  }

  // ---- 3. bodies no longer name their dead in their short name
  const bodies = db.prepare("SELECT id, data FROM objects WHERE type_id = 'corpse'").all();
  const upd = db.prepare("UPDATE objects SET data = ?, surface_text = 'someone lying very still' WHERE id = ?");
  for (const b of bodies) {
    const d = parse(b.data);
    d.short = 'body';
    upd.run(JSON.stringify(d), b.id);
  }
  console.log(`[db] step 9.5: ${converted} plan steps → intentions; ${known} known deaths rebuilt; ${reset} leaked griefs reset; ${bodies.length} bodies`);
}

function stepWords(s) {
  switch (s.kind) {
    case 'travel': return `go to ${s.place}`;
    case 'eat': return `eat at ${s.place}`;
    case 'visit': return `find ${s.person}`;
    default: return s.kind;
  }
}
