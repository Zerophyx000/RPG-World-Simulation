// Step 9: GET /api/replay?from=&to= (game minutes). Everything the map needs to replay a stretch of time from the
// logs: the state at `from` (where everyone was, every object's state, the lasting room effects) and, in time order,
// position changes (trips and walks with their tile paths), spoken lines, object changes, room effects and activity
// changes. Read-only; the live world keeps running.
const MAX_SPAN = 24 * 60;
const MAX_EVENTS = 20000;
const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

export function replay(world, { from = null, to = null } = {}) {
  const db = world.db;
  to = to == null || to === '' ? world.now : Number(to);
  from = from == null || from === '' ? to - 60 : Number(from);
  if (!Number.isFinite(from) || !Number.isFinite(to)) { const e = new Error('from and to must be game minutes'); e.status = 400; throw e; }
  if (from > to) [from, to] = [to, from];
  if (to - from > MAX_SPAN) from = to - MAX_SPAN;

  // ---- the citizens at `from`
  const lastOf = (type) => db.prepare(`SELECT e.actor_id, e.game_time, e.data FROM events e
    JOIN (SELECT actor_id, MAX(id) AS mid FROM events WHERE type = ? AND game_time <= ? GROUP BY actor_id) m ON e.id = m.mid`).all(type, from);
  const posOf = new Map(lastOf('position').map((r) => [r.actor_id, { t: r.game_time, d: json(r.data, {}) }]));
  const actOf = new Map(lastOf('activity').map((r) => [r.actor_id, { t: r.game_time, d: json(r.data, {}) }]));
  const citizens = {};
  for (const c of world.citizens.values()) {
    const p = posOf.get(c.id);
    const a = actOf.get(c.id);
    let location = c.location; let spot = c.spot ?? null;
    let activity = a ? { type: a.d.to ?? 'idle', since: a.t, until: a.d.until ?? null, detail: a.d.detail ?? null } : { type: 'idle', since: from, until: null, detail: null };
    if (p) {
      const d = p.d;
      if (d.kind === 'trip-start') {
        location = d.fromRoom; spot = null;
        activity = { type: 'moving', since: p.t, until: p.t + (d.minutes ?? 1), detail: { from: d.fromRoom, to: d.toRoom, legStart: p.t, travelMinutes: d.minutes ?? 1, fromSpot: d.fromSpot } };
      } else if (d.kind === 'walk-start') {
        location = d.fromRoom; spot = d.fromSpot;
        activity = { type: 'doing', since: p.t, until: p.t + (d.minutes ?? 0.5), detail: { kind: 'walk', fromSpot: d.fromSpot, toSpot: d.toSpot, minutes: d.minutes ?? 0.5 } };
      } else {
        location = d.toRoom; spot = d.toSpot;
        if (activity.type === 'moving') activity = { type: 'idle', since: p.t, until: null, detail: null };
      }
    }
    citizens[c.id] = { location, spot, activity };
  }

  // ---- the objects at `from`: the last change before it, or the first change after it, else as they are now
  const snap = (s) => ({ roomId: s.room ?? s.roomId ?? null, holderId: s.holder ?? s.holderId ?? null, placement: s.placement ?? null, state: s.state ?? null });
  const objects = {};
  for (const o of world.objects.byId.values()) objects[o.id] = { roomId: o.roomId, holderId: o.holderId, placement: o.placement, state: o.state };
  const firstAfter = db.prepare(`SELECT h.object_id, h.before FROM object_history h
    JOIN (SELECT object_id, MIN(id) AS mid FROM object_history WHERE game_time > ? GROUP BY object_id) m ON h.id = m.mid`).all(from);
  for (const r of firstAfter) objects[r.object_id] = snap(json(r.before, {}));
  const lastBefore = db.prepare(`SELECT h.object_id, h.after FROM object_history h
    JOIN (SELECT object_id, MAX(id) AS mid FROM object_history WHERE game_time <= ? GROUP BY object_id) m ON h.id = m.mid`).all(from);
  for (const r of lastBefore) objects[r.object_id] = snap(json(r.after, {}));

  // ---- room effects at `from` (best effort: the current ones that already existed then)
  const rooms = {};
  for (const r of world.rooms.values()) rooms[r.id] = { effects: (r.effects ?? []).filter((e) => (e.until == null || e.until > from) && (e.visual?.at ?? -Infinity) <= from) };

  // ---- events in (from, to]
  const events = [];
  const rows = db.prepare(`SELECT id, game_time, type, actor_id, location, data FROM events
    WHERE game_time > ? AND game_time <= ? AND type IN ('position', 'activity', 'director') ORDER BY game_time, id LIMIT ?`).all(from, to, MAX_EVENTS);
  for (const r of rows) {
    const d = json(r.data, {});
    if (r.type === 'position') events.push({ t: r.game_time, id: r.id, type: 'position', citizenId: r.actor_id, kind: d.kind, fromRoom: d.fromRoom, toRoom: d.toRoom, fromSpot: d.fromSpot, toSpot: d.toSpot, minutes: d.minutes, path: d.path });
    else if (r.type === 'activity') events.push({ t: r.game_time, id: r.id, type: 'activity', citizenId: r.actor_id, activity: { type: d.to, since: r.game_time, until: d.until ?? null, detail: d.detail ?? null } });
    else if (r.type === 'director' && d.roomEffect?.text) events.push({ t: r.game_time, id: r.id, type: 'effect', roomId: r.location ?? d.roomId ?? null, effect: { id: `fx${r.id}`, text: d.roomEffect.text, until: r.game_time + (d.roomEffect.durationGameMinutes ?? 60) } });
  }
  // spoken lines: active conversations and the transcripts of the ended ones
  const lines = [];
  const take = (conv) => { for (const l of conv?.lines ?? []) if (l.gameTime > from && l.gameTime <= to) lines.push(l); };
  for (const conv of world.conversations.list()) take(conv);
  for (const r of db.prepare("SELECT data FROM events WHERE type = 'conversation_end' AND game_time > ? ORDER BY id").all(from)) take(json(r.data, {}));
  const seen = new Set();
  for (const l of lines) {
    const k = `${l.speakerId}|${l.gameTime}|${l.text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    events.push({ t: l.gameTime, id: l.eventId ?? 0, type: 'line', speakerId: l.speakerId, toId: l.toId ?? null, text: l.text, volume: l.volume ?? 'normal' });
  }
  for (const r of db.prepare('SELECT id, object_id, game_time, after FROM object_history WHERE game_time > ? AND game_time <= ? ORDER BY game_time, id LIMIT ?').all(from, to, MAX_EVENTS)) {
    events.push({ t: r.game_time, id: r.id, type: 'object', objectId: r.object_id, after: snap(json(r.after, {})) });
  }
  events.sort((a, b) => a.t - b.t || (a.id ?? 0) - (b.id ?? 0));
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  return { from, to, initial: { citizens, objects, rooms }, events };
}
