// Step 9: GET /api/interest. What the director camera should look at right now, from existing data only:
//   critical bleeding windows        importance 10, score 100 + urgency (fewer minutes left = higher)
//   recent events (last 30 game min) death 10, critical_window 10, director 9, director_effect 9, injury 8,
//                                     signal 6, notice 6, treatment 6, search 4; decaying linearly over 30 minutes;
//                                     score = importance * 6 * freshness, credited to the actor (or the room)
//   active conversations              stakes = the participants' expressed anger / fear / jealousy / affection toward
//                                     each other (+3 per pair with trust <= -2) + 2 per line in the last 10 game min
//   storylines                        +5 for each citizen involved in an active storyline of the latest observer
//                                     report (read from observer_reports; the observer module is never imported)
// Contributions are grouped into focuses (a conversation, a citizen, or a room) with a short caption from the
// strongest one. Read-only, no LLM.
const TYPE_IMPORTANCE = { death: 10, critical_window: 10, director: 9, director_effect: 9, injury: 8, signal: 6, notice: 6, treatment: 6, search: 4 };
const WINDOW = 30;
const json = (s) => { try { return JSON.parse(s); } catch { return {}; } };

export function interest(world) {
  const now = world.now;
  const name = (id) => world.citizens.get(id)?.name ?? id;
  const roomName = (id) => world.rooms.get(id)?.name ?? id;
  const focuses = new Map(); // key -> focus
  const add = (key, base, score, importance, caption) => {
    let f = focuses.get(key);
    if (!f) { f = { ...base, score: 0, importance: 1, caption: '', best: -1 }; focuses.set(key, f); }
    f.score += score;
    f.importance = Math.max(f.importance, importance);
    if (score > f.best) { f.best = score; f.caption = caption; }
  };
  const citizenFocus = (c) => ({ kind: 'citizen', id: c.id, roomId: c.location, citizenIds: [c.id] });

  // 1. critical bleeding windows
  for (const c of world.citizens.values()) {
    if (!c.alive || !c.body?.critical) continue;
    const left = c.body.criticalLeft ?? Math.max(0, (c.body.critical.until ?? now) - now);
    add(`c:${c.id}`, citizenFocus(c), 100 + Math.max(0, 30 - left) * 2, 10, `${c.name} is bleeding out: ${Math.round(left)} min left`);
  }

  // 2. recent events
  let rows = [];
  try {
    rows = world.db.prepare(`SELECT type, actor_id, location, game_time, data FROM events WHERE game_time >= ? AND type IN (${Object.keys(TYPE_IMPORTANCE).map(() => '?').join(',')}) ORDER BY id DESC LIMIT 300`)
      .all(now - WINDOW, ...Object.keys(TYPE_IMPORTANCE));
  } catch { rows = []; }
  for (const r of rows) {
    const d = json(r.data);
    if (r.type === 'director' && d.action !== 'event') continue;
    const imp = Math.max(TYPE_IMPORTANCE[r.type] ?? 5, Number(d.importance) || 0);
    const fresh = Math.max(0, 1 - (now - r.game_time) / WINDOW);
    const score = imp * 6 * fresh;
    const actor = r.actor_id && world.citizens.get(r.actor_id);
    const here = d.texts?.here ? String(d.texts.here).replace(/\s+/g, ' ').slice(0, 70) : null;
    const caption = {
      death: `${actor ? actor.name : 'Someone'} died`,
      critical_window: `${actor ? actor.name : 'Someone'} is bleeding out`,
      director: here ?? `Something happened at ${roomName(r.location)}`,
      director_effect: `${d.type ?? 'Something'} at ${roomName(r.location ?? actor?.location)}`,
      injury: `${actor ? actor.name : 'Someone'} is hurt${d.type ? ` (${d.type})` : ''}`,
      signal: `${actor ? actor.name : 'Someone'} grows wary of ${name(d.otherId)}`,
      notice: `${actor ? actor.name : 'Someone'} notices something missing`,
      treatment: `${actor ? actor.name : 'Someone'} tends a wound`,
      search: `${actor ? actor.name : 'Someone'} searches`,
    }[r.type] ?? r.type;
    if (actor && r.type !== 'director') add(`c:${actor.id}`, citizenFocus(actor), score, imp, caption);
    else if (r.location) add(`r:${r.location}`, { kind: 'room', id: r.location, roomId: r.location, citizenIds: [...world.citizens.values()].filter((c) => c.alive && c.location === r.location).map((c) => c.id) }, score, imp, caption);
  }

  // 3. conversations with emotional stakes
  for (const conv of world.conversations?.list() ?? []) {
    const ps = conv.participants ?? [];
    if (ps.length < 2) continue;
    let stakes = 0; let strongest = null;
    for (const a of ps) {
      const c = world.citizens.get(a); if (!c) continue;
      for (const e of world.emotions?.of(c) ?? []) {
        if (!['anger', 'fear', 'jealousy', 'affection', 'envy'].includes(e.type) || !ps.includes(e.target)) continue;
        const x = world.emotions.expressed(c, e);
        stakes += x;
        if (!strongest || x > strongest.x) strongest = { x, type: e.type, from: a, to: e.target };
      }
      for (const r of world.memory?.relsOf(a) ?? []) if (ps.includes(r.otherId) && (r.trust ?? 0) <= -2) stakes += 3;
    }
    const recent = (conv.lines ?? []).filter((l) => l.gameTime >= now - 10).length;
    const score = stakes * 2 + recent * 2;
    if (score <= 0) continue;
    const names = ps.map(name);
    const verb = strongest?.type === 'anger' ? 'argue' : strongest?.type === 'fear' ? 'face each other warily' : strongest?.type === 'affection' ? 'talk warmly' : strongest ? 'talk, tense' : 'talk';
    const caption = strongest ? `${name(strongest.from)} and ${name(strongest.to)} ${verb} (${strongest.type})` : `${names.slice(0, 3).join(', ')} talk`;
    add(`v:${conv.id}`, { kind: 'conversation', id: conv.id, roomId: conv.roomId, citizenIds: [...ps] }, score, Math.min(8, 3 + Math.round(stakes / 3)), caption);
  }

  // 4. storylines from the latest observer report
  try {
    const row = world.db.prepare('SELECT data FROM observer_reports ORDER BY id DESC LIMIT 1').get();
    const rep = row ? json(row.data) : null;
    for (const t of rep?.threads ?? []) {
      if (t.status && !/active|open|ongoing|rising|new/i.test(t.status)) continue;
      for (const id of t.involved ?? []) {
        const c = world.citizens.get(id);
        if (c?.alive) add(`c:${c.id}`, citizenFocus(c), 5, 4, `${c.name}: ${String(t.title ?? 'a storyline').slice(0, 60)}`);
      }
    }
  } catch { /* no observer yet */ }

  const list = [...focuses.values()].map(({ best, ...f }) => ({ ...f, score: Math.round(f.score * 10) / 10 }));
  list.sort((a, b) => b.score - a.score);
  return { at: now, focuses: list.slice(0, 10) };
}
