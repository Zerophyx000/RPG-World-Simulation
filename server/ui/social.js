// Step 9: GET /api/map/social. What the story overlays and the animator's body language read: per citizen the
// EXPRESSED emotions (after composure and masking: what others could see), and for every pair of people on the same
// map the directed relationship (affinity, trust) and the feelings aimed at the other (anger, fear, affection, envy,
// jealousy with the beloved). Plus who is watching whom (following, fearful or jealous stares).
// Read-only UI read model: no state changes, no LLM, never shown to citizens.
const AIMED = ['anger', 'fear', 'affection', 'envy', 'jealousy'];
const r1 = (v) => Math.round(v * 10) / 10;

export function socialView(world) {
  const citizens = {};
  const alive = [...world.citizens.values()].filter((c) => c.alive && c.location);
  const expressedOf = new Map(); // id -> [{ type, intensity, target, about }]
  for (const c of alive) {
    const list = [];
    for (const e of world.emotions?.of(c) ?? []) {
      const x = world.emotions.expressed(c, e);
      if (x >= 1) list.push({ type: e.type, intensity: r1(x), target: e.target ?? null, about: e.about ?? null });
    }
    list.sort((a, b) => b.intensity - a.intensity);
    expressedOf.set(c.id, list);
    citizens[c.id] = { emotions: list.map(({ type, intensity, target }) => ({ type, intensity, target })) };
  }
  // directed relationship rows
  const rel = new Map();
  for (const c of alive) for (const r of world.memory?.relsOf(c.id) ?? []) rel.set(`${c.id}>${r.otherId}`, r);
  const mapOf = (c) => world.maps?.mapOf(c.location) ?? c.location;
  const pairs = [];
  for (const a of alive) {
    for (const b of alive) {
      if (a === b || mapOf(a) !== mapOf(b)) continue;
      const r = rel.get(`${a.id}>${b.id}`);
      const p = { from: a.id, to: b.id, affinity: r1(r?.affinity ?? 0), trust: r1(r?.trust ?? 0), anger: 0, fear: 0, affection: 0, envy: 0, jealousy: 0, beloved: null };
      for (const e of expressedOf.get(a.id) ?? []) {
        if (!AIMED.includes(e.type) || e.target !== b.id) continue;
        if (e.intensity > p[e.type]) { p[e.type] = e.intensity; if (e.type === 'jealousy') p.beloved = e.about ?? null; }
      }
      const show = p.anger >= 1 || p.fear >= 1 || p.affection >= 3 || p.envy >= 1 || p.jealousy >= 1 || p.trust <= -2 || p.affinity >= 4 || p.affinity <= -3;
      if (show) pairs.push(p);
    }
  }
  // watching: someone following another (an activity flag, or a recent "followed" warning sign), fearful/jealous stares
  const watching = [];
  for (const c of alive) {
    const f = c.activity?.type === 'waiting' ? c.activity.detail?.following : null;
    if (f && world.citizens.get(f)?.alive) watching.push({ from: c.id, to: f, kind: 'following' });
  }
  try {
    const rows = world.db.prepare("SELECT actor_id, data FROM events WHERE type = 'signal' AND game_time >= ? ORDER BY id DESC LIMIT 50").all(world.now - 60);
    for (const r of rows) {
      const d = JSON.parse(r.data);
      if (d.sign === 'followed' && d.otherId && !watching.some((w) => w.from === d.otherId && w.to === r.actor_id)) watching.push({ from: d.otherId, to: r.actor_id, kind: 'following' });
    }
  } catch { /* no events table in a bare test db */ }
  for (const a of alive) {
    for (const e of expressedOf.get(a.id) ?? []) {
      if (!['fear', 'jealousy'].includes(e.type) || e.intensity < 5 || !e.target) continue;
      const b = world.citizens.get(e.target);
      if (b?.alive && b.location === a.location) watching.push({ from: a.id, to: b.id, kind: 'stare' });
    }
  }
  return { citizens, pairs, watching };
}
