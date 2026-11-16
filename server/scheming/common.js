// Step 11: shared helpers for ambitions, schemes and lies — resolving what a citizen names (people, places, rough
// times) into ids and game-minute windows, the way they would say it. Nothing here writes state.
export const J = (s, fallback = null) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };
export const clampInt = (v, a, b, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(a, Math.min(b, n)) : d; };
const DAY = 1440;

/** People this citizen could name (known names first), as label → citizen; the dead included. */
export function peopleFor(world, c) {
  const list = world.memory.knownPeople ? world.memory.knownPeople(c, { dead: 'all' }) : [...world.citizens.values()].filter((o) => o.id !== c.id);
  return world.memory.labelsFor(c, list.filter((o) => o && o.id !== c.id));
}

/** A name, a label ("the tall man") or an id → a citizen (or null). "me", "myself", "I" → the speaker. */
export function resolvePerson(world, c, text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (/^(me|myself|i)$/i.test(t)) return c;
  const labels = peopleFor(world, c);
  if (labels.has(t)) return labels.get(t);
  const low = t.toLowerCase().replace(/^the /, '');
  for (const [label, o] of labels) if (label.toLowerCase() === low || label.toLowerCase().replace(/^the /, '') === low) return o;
  for (const o of world.citizens.values()) if (o.name.toLowerCase() === low || o.id === low || o.name.split(/\s+/)[0].toLowerCase() === low) return o;
  return null;
}

/** People named in a text (by their first name or full name), as ids. */
export function namesIn(world, text, { exceptId = null } = {}) {
  const s = String(text ?? '');
  const out = [];
  for (const o of world.citizens.values()) {
    if (o.id === exceptId) continue;
    const first = o.name.split(/\s+/)[0];
    if (new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(s)) out.push(o.id);
  }
  return out;
}

/** A place as said ("the forge", "home", "Greta's house", "the Tilted Cup") → a room id (or null). */
export function resolvePlace(world, c, text, { whoId = null } = {}) {
  const t = String(text ?? '').trim().toLowerCase().replace(/^(at|in|by|near) /, '').replace(/^the /, '');
  if (!t) return null;
  if (world.rooms.has(t)) return t;
  if (/^(home|my house|my home|at home)$/.test(t)) return c.home ?? null;
  if (/^(his|her|their) (house|home)$/.test(t) || t === 'their place') return whoId ? world.citizens.get(whoId)?.home ?? null : null;
  for (const o of world.citizens.values()) {
    const first = o.name.split(/\s+/)[0].toLowerCase();
    if (new RegExp(`^${first}'?s( (house|home|cottage|place))?$`).test(t)) return o.home ?? ([...world.rooms.values()].find((r) => r.owner === o.id)?.id ?? null);
  }
  const words = (s) => String(s ?? '').toLowerCase().replace(/^the /, '');
  for (const r of world.rooms.values()) {
    if (words(r.name) === t || words(r.kind) === t || r.id.replace(/_/g, ' ') === t) return r.id;
  }
  // synonyms the village uses
  const SYN = { forge: 'smithy', smithy: 'smithy', anvil: 'smithy', tavern: 'tavern', cup: 'tavern', inn: 'tavern', bakery: 'bakery', ovens: 'bakery', well: 'well', square: 'square', market: 'square', chapel: 'chapel_yard', graveyard: 'chapel_yard', mine: 'old_mine_entrance' };
  for (const [k, id] of Object.entries(SYN)) if (t.includes(k) && world.rooms.has(id)) return id;
  for (const r of world.rooms.values()) if (t && words(r.name).includes(t)) return r.id;
  return null;
}

/**
 * A rough time as said ("last night", "this morning", "yesterday", "an hour ago", "at noon", "all day") → a window in
 * game minutes { from, to } (or null). Relative to now.
 */
export function resolveWhen(world, text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return null;
  const now = world.now;
  const day0 = Math.floor(now / DAY) * DAY;
  const at = (d, h) => day0 + d * DAY + h * 60;
  const win = (from, to) => ({ from: Math.min(from, now), to: Math.min(to, now) });
  if (/last night|during the night|in the night|overnight/.test(t)) return now - day0 < 12 * 60 ? win(at(-1, 19), at(0, 6)) : win(at(0, 0), at(0, 6));
  if (/tonight|this evening/.test(t)) return win(at(0, 17), at(0, 24));
  if (/this morning|at dawn|first light/.test(t)) return win(at(0, 4), at(0, 12));
  if (/this afternoon/.test(t)) return win(at(0, 12), at(0, 18));
  if (/yesterday (evening|night)/.test(t)) return win(at(-1, 17), at(0, 2));
  if (/yesterday morning/.test(t)) return win(at(-1, 4), at(-1, 12));
  if (/yesterday/.test(t)) return win(at(-1, 0), at(0, 0));
  if (/today|all day/.test(t)) return win(day0, now);
  if (/(an|one) hour ago/.test(t)) return win(now - 90, now - 30);
  const hrs = /(\d+|two|three|four|five) hours ago/.exec(t);
  if (hrs) { const n = { two: 2, three: 3, four: 4, five: 5 }[hrs[1]] ?? Number(hrs[1]); return win(now - n * 60 - 45, now - n * 60 + 45); }
  if (/just now|a moment ago|a minute ago/.test(t)) return win(now - 15, now);
  if (/at noon|midday/.test(t)) return now - day0 >= 12 * 60 ? win(at(0, 11.5), at(0, 13)) : win(at(-1, 11.5), at(-1, 13));
  if (/at midnight/.test(t)) return win(now - day0 < 12 * 60 ? at(0, -0.5) : at(1, -0.5), now - day0 < 12 * 60 ? at(0, 1) : at(1, 1));
  const hm = /(\d{1,2}):(\d{2})/.exec(t);
  if (hm) { let m = at(0, Number(hm[1]) + Number(hm[2]) / 60); if (m > now) m -= DAY; return win(m - 30, m + 30); }
  return null;
}

/** "day 3 20:00", "20:00" (the next such time), "+2h" → game minutes (or null). For scheme steps' not_before/not_after. */
export function parseTimeRef(world, text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return null;
  const now = world.now;
  const d = /day\s*(\d+)\s+(\d{1,2}):(\d{2})/.exec(t);
  if (d) return (Number(d[1]) - 1) * DAY + Number(d[2]) * 60 + Number(d[3]);
  const rel = /^\+?\s*(\d+)\s*h/.exec(t);
  if (rel) return now + Number(rel[1]) * 60;
  const hm = /(\d{1,2}):(\d{2})/.exec(t);
  if (hm) { let m = Math.floor(now / DAY) * DAY + Number(hm[1]) * 60 + Number(hm[2]); if (m < now - 30) m += DAY; return m; }
  if (/tonight/.test(t)) return Math.floor(now / DAY) * DAY + 20 * 60;
  if (/tomorrow/.test(t)) return Math.floor(now / DAY) * DAY + DAY + 7 * 60;
  return null;
}

/** Where a citizen was over a game-time window: [{ from, to, roomId, asleep }] reconstructed from the event log. */
export function whereabouts(world, id, from, to) {
  const db = world.db;
  const before = db.prepare('SELECT game_time, location FROM events WHERE actor_id = ? AND game_time <= ? AND location IS NOT NULL ORDER BY game_time DESC, id DESC LIMIT 1').get(id, from);
  const rows = db.prepare('SELECT game_time, location FROM events WHERE actor_id = ? AND game_time > ? AND game_time <= ? AND location IS NOT NULL ORDER BY game_time, id').all(id, from, to);
  const sleepRows = db.prepare("SELECT game_time, json_extract(data, '$.to') AS t FROM events WHERE actor_id = ? AND type = 'activity' AND game_time <= ? ORDER BY game_time, id").all(id, to);
  const asleepAt = (tm) => { let s = false; for (const r of sleepRows) { if (r.game_time > tm) break; s = r.t === 'sleeping' || r.t === 'collapsed'; } return s; };
  const out = [];
  let cur = before ? { from, roomId: before.location } : null;
  for (const r of rows) {
    if (cur && r.location === cur.roomId) continue;
    if (cur) out.push({ ...cur, to: r.game_time, asleep: asleepAt((cur.from + r.game_time) / 2) });
    cur = { from: r.game_time, roomId: r.location };
  }
  if (cur) out.push({ ...cur, to, asleep: asleepAt((cur.from + to) / 2) });
  return out;
}

export function trait(c, k) {
  const v = c?.persona?.traits?.[k];
  return v != null && Number.isFinite(Number(v)) ? Number(v) : k === 'honesty' ? 6 : k === 'cunning' ? 4 : 5; // defaults until the traits job ran
}
