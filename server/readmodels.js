// Read models for the UI: queries that reshape the event log and in-memory state.
// Read-only: nothing here mutates the world.

const parse = (row) => ({ ...row, data: JSON.parse(row.data) });

// ---------- events ----------
export function listEvents(world, { limit = 200, before = null, types = null } = {}) {
  const where = [];
  const params = [];
  if (before) {
    where.push('id < ?');
    params.push(Number(before));
  }
  if (types?.length) {
    where.push(`type IN (${types.map(() => '?').join(',')})`);
    params.push(...types);
  }
  const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  return world.db.prepare(sql).all(...params, Math.min(Number(limit) || 200, 1000)).map(parse);
}

export function getEvent(world, id) {
  const row = world.db.prepare('SELECT * FROM events WHERE id = ?').get(Number(id));
  if (!row) return null;
  const e = parse(row);
  if (e.type === 'action' && ['say', 'leave_conversation', 'tell_about_place'].includes(e.data.tool)) {
    e.conversationId = conversationOfLine(world, e.id);
  }
  return e;
}

// Which conversation a speech event belongs to (lines carry their event id).
function conversationOfLine(world, eventId) {
  for (const conv of world.conversations.list()) if (conv.lines.some((l) => l.eventId === eventId)) return conv.id;
  const row = world.db.prepare(`SELECT json_extract(e.data, '$.conversationId') AS id FROM events e
    WHERE e.type = 'conversation_end' AND e.id > ? AND EXISTS (
      SELECT 1 FROM json_each(e.data, '$.lines') l WHERE json_extract(l.value, '$.eventId') = ?)
    ORDER BY e.id LIMIT 1`).get(eventId, eventId);
  return row?.id ?? null;
}

// ---------- conversations ----------
function pastView(world, row) {
  const d = JSON.parse(row.data);
  return {
    id: d.conversationId,
    roomId: row.location,
    active: false,
    eventId: row.id,
    participants: (d.participants ?? []).map((p) => p.id),
    everParticipants: (d.participants ?? []).map((p) => p.id),
    startedAt: d.startedAt,
    endedAt: d.endedAt,
    reason: d.reason,
    lineCount: (d.lines ?? []).length,
    lines: d.lines ?? [],
  };
}

export function listConversations(world, { active = null, citizen = null, limit = 50 } = {}) {
  const out = [];
  if (active !== false) {
    for (const conv of world.conversations.list()) {
      if (citizen && !conv.everParticipants.includes(citizen)) continue;
      out.push({ ...world.conversations.view(conv), lineCount: conv.lines.length });
    }
  }
  if (active !== true) {
    const rows = world.db.prepare(`SELECT id, game_time, location, data FROM events e
      WHERE type = 'conversation_end'
        AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(e.data, '$.participants') p WHERE json_extract(p.value, '$.id') = ?))
      ORDER BY id DESC LIMIT ?`).all(citizen, citizen, Math.min(Number(limit) || 50, 500));
    for (const row of rows) {
      const v = pastView(world, row);
      delete v.lines; // the list stays light; GET /api/conversations/:id has the transcript
      out.push(v);
    }
  }
  return out;
}

export function getConversation(world, id) {
  const conv = world.conversations.get(id);
  if (conv) return { ...world.conversations.view(conv), lineCount: conv.lines.length };
  const row = world.db.prepare(`SELECT id, game_time, location, data FROM events
    WHERE type = 'conversation_end' AND json_extract(data, '$.conversationId') = ? ORDER BY id DESC LIMIT 1`).get(id);
  return row ? pastView(world, row) : null;
}

// ---------- timeline ----------
/**
 * Activity spans per citizen + point events in [from, to] (game minutes).
 * Spans are rebuilt from `activity` events; citizens without any fall back to their current activity.
 */
export function timeline(world, { from = null, to = null } = {}) {
  const now = world.now;
  to = to == null ? now : Number(to);
  from = from == null ? to - 360 : Number(from);
  const db = world.db;

  const prior = db.prepare(`SELECT e.actor_id, e.game_time, e.data FROM events e
    JOIN (SELECT actor_id, MAX(id) AS mid FROM events WHERE type = 'activity' AND game_time < ? GROUP BY actor_id) m
      ON e.id = m.mid`).all(from);
  const rows = db.prepare(`SELECT id, actor_id, game_time, data FROM events
    WHERE type = 'activity' AND game_time >= ? AND game_time <= ? ORDER BY id`).all(from, to);

  const open = new Map(); // citizenId -> current span
  const spans = [];
  for (const p of prior) {
    const d = JSON.parse(p.data);
    open.set(p.actor_id, { citizenId: p.actor_id, type: d.to, from, to: null, detail: d.detail ?? null });
  }
  for (const r of rows) {
    const d = JSON.parse(r.data);
    const cur = open.get(r.actor_id);
    if (cur) {
      cur.to = r.game_time;
      if (cur.to > cur.from) spans.push(cur);
    } else if (d.from) {
      // first event we know of for this citizen: they were in `from` before it
      spans.push({ citizenId: r.actor_id, type: d.from, from, to: r.game_time, detail: null, partial: true });
    }
    open.set(r.actor_id, { citizenId: r.actor_id, type: d.to, from: r.game_time, to: null, detail: d.detail ?? null, eventId: r.id });
  }
  const end = Math.min(to, now);
  for (const c of world.citizens.values()) {
    let cur = open.get(c.id);
    if (!cur && c.activity.since <= end) {
      cur = { citizenId: c.id, type: c.activity.type, from: Math.max(from, c.activity.since ?? from), to: null, detail: c.activity.detail ?? null };
    }
    if (cur) {
      cur.to = end;
      cur.open = to >= now;
      if (cur.to >= cur.from) spans.push(cur);
    }
  }

  // Point events
  const points = [];
  const pointRows = db.prepare(`SELECT id, type, actor_id, game_time, location, data FROM events
    WHERE game_time >= ? AND game_time <= ?
      AND (type IN ('director', 'interrupt', 'rethink_stale', 'damage', 'action_stale', 'collapse', 'forced_sleep', 'revive', 'death', 'learn_place', 'injury', 'treatment', 'accident', 'critical_window')
           OR (type = 'body' AND json_extract(data, '$.importance') >= 7)
           OR (type = 'action' AND json_extract(data, '$.tool') IN ('say', 'leave_conversation', 'tell_about_place', 'eat')))
    ORDER BY id`).all(from, to);
  const lineConv = new Map();
  for (const conv of world.conversations.list()) for (const l of conv.lines) if (l.eventId) lineConv.set(l.eventId, conv.id);

  // Conversation bands
  const conversations = [];
  const ended = db.prepare(`SELECT id, location, data FROM events WHERE type = 'conversation_end'
    AND json_extract(data, '$.endedAt') >= ? AND json_extract(data, '$.startedAt') <= ?`).all(from, to);
  for (const row of ended) {
    const d = JSON.parse(row.data);
    for (const l of d.lines ?? []) if (l.eventId) lineConv.set(l.eventId, d.conversationId);
    conversations.push({
      id: d.conversationId, roomId: row.location, from: d.startedAt, to: d.endedAt, active: false,
      participants: (d.participants ?? []).map((p) => p.id), lines: (d.lines ?? []).length, eventId: row.id,
    });
  }
  for (const conv of world.conversations.list()) {
    conversations.push({
      id: conv.id, roomId: conv.roomId, from: conv.startedAt, to: now, active: true,
      participants: conv.everParticipants, lines: conv.lines.length,
    });
  }

  for (const r of pointRows) {
    const d = JSON.parse(r.data);
    const base = { eventId: r.id, t: r.game_time, citizenId: r.actor_id, roomId: r.location };
    if (r.type === 'action') {
      if (d.tool === 'eat') {
        points.push({ ...base, type: 'eat', text: 'eats' });
        continue;
      }
      const text = d.tool === 'leave_conversation' ? d.args?.farewell : d.args?.text;
      if (!text) continue;
      points.push({ ...base, type: 'speech', text, toId: d.toId ?? null, thought: d.thought ?? null, conversationId: lineConv.get(r.id) ?? null, teach: d.tool === 'tell_about_place' ? d.args?.place : null });
    } else if (r.type === 'director') {
      if (!['event', 'whisper', 'effects'].includes(d.action)) continue;
      const onlyWhisper = d.action === 'effects' && (d.effects ?? []).length === 1 && d.effects[0].type === 'whisper' && typeof d.effects[0].target === 'string';
      if (d.action === 'whisper' || onlyWhisper) {
        points.push({ ...base, type: 'whisper', citizenId: d.citizenId ?? d.effects[0].target, text: d.text ?? d.effects[0].text });
        continue;
      }
      points.push({
        ...base, type: 'director', citizenId: null,
        text: d.texts?.here || (d.effects ?? []).map((x) => x.type).join(', '), icon: d.icon ?? (d.action === 'effects' ? '✨' : null),
        label: d.label ?? null, roomId: d.roomId ?? r.location,
      });
    } else {
      const text = r.type === 'damage' ? `hit for ${d.amount}` : r.type === 'body' ? `${d.need}: ${d.level}`
        : r.type === 'injury' ? `${d.damageType ?? 'injury'}${d.part ? ` to ${d.part}` : ''}: ${d.cause ?? ''}`
        : r.type === 'treatment' ? `${d.method}${d.effective === false ? ' (no effect)' : ''}`
        : r.type === 'accident' ? `accident: ${d.source}`
        : r.type === 'critical_window' ? `critical bleeding ${d.action}${d.reason ? ` (${d.reason})` : ''}`
        : r.type === 'learn_place' ? `learned about ${d.placeId}` : d.reason ?? d.cause?.text ?? d.cause ?? null;
      points.push({ ...base, type: r.type, text, ...(r.type === 'death' ? { cause: d.cause ?? null } : {}) });
    }
  }

  // step 7B: the vitality line (hourly samples while something was wrong)
  const vitality = db.prepare(`SELECT actor_id, game_time, data FROM events WHERE type = 'vitality' AND game_time >= ? AND game_time <= ? ORDER BY id`).all(from, to)
    .map((r) => { const d = JSON.parse(r.data); return { citizenId: r.actor_id, t: r.game_time, v: d.vitality, blood: d.blood }; });
  return {
    from, to, now,
    citizens: [...world.citizens.values()].map((c) => ({ id: c.id, name: c.name, alive: c.alive })),
    spans, points, conversations, vitality,
  };
}

// ---------- relationships (code-side interaction counts) ----------
export function interactions(world, { from = null, to = null } = {}) {
  return world.db.prepare(`SELECT actor_id AS "from", json_extract(data, '$.toId') AS "to", COUNT(*) AS n FROM events
    WHERE type = 'action' AND json_extract(data, '$.tool') IN ('say', 'tell_about_place') AND json_extract(data, '$.toId') IS NOT NULL
      AND game_time >= ? AND game_time <= ?
    GROUP BY actor_id, json_extract(data, '$.toId')`).all(from == null ? -1e12 : Number(from), to == null ? 1e12 : Number(to));
}

export function pairLines(world, a, b, { limit = 5, until = null } = {}) {
  return world.db.prepare(`SELECT id, game_time, actor_id, data FROM events
    WHERE type = 'action' AND json_extract(data, '$.tool') IN ('say', 'tell_about_place') AND game_time <= ?
      AND ((actor_id = ? AND json_extract(data, '$.toId') = ?) OR (actor_id = ? AND json_extract(data, '$.toId') = ?))
    ORDER BY id DESC LIMIT ?`).all(until == null ? 1e12 : Number(until), a, b, b, a, Math.min(Number(limit) || 5, 50))
    .map((r) => {
      const d = JSON.parse(r.data);
      return { eventId: r.id, t: r.game_time, from: r.actor_id, to: d.toId, text: d.args?.text, thought: d.thought ?? null };
    }).reverse();
}

// ---------- token usage (Usage tab) ----------
export function usage(world, { minutes = 180, bucket = 10 } = {}) {
  minutes = Math.min(Math.max(Number(minutes) || 180, 10), 7 * 24 * 60);
  bucket = Math.min(Math.max(Number(bucket) || 10, 1), 120);
  const now = Date.now();
  const bucketMs = bucket * 60_000;
  const start = Math.floor((now - minutes * 60_000) / bucketMs) * bucketMs;
  const since = new Date(start).toISOString();
  const rows = world.db.prepare(`SELECT real_time, purpose, profile, tier, status, duration_ms, prompt_tokens, completion_tokens, finish_reason
    FROM llm_calls WHERE real_time >= ?`).all(since);
  const buckets = [];
  for (let t = start; t <= now; t += bucketMs) buckets.push({ t, output: {}, input: 0, calls: 0 });
  const purposes = {};
  const profiles = {};
  for (const r of rows) {
    const i = Math.floor((Date.parse(r.real_time) - start) / bucketMs);
    const b = buckets[i];
    const out = r.completion_tokens ?? 0;
    const inp = r.prompt_tokens ?? 0;
    if (b) {
      b.output[r.purpose] = (b.output[r.purpose] ?? 0) + out;
      b.input += inp;
      b.calls++;
    }
    const p = (purposes[r.purpose] ??= { calls: 0, input: 0, output: 0, ms: 0, timeouts: 0, errors: 0, aborted: 0, tiers: {} });
    p.calls++;
    p.input += inp;
    p.output += out;
    p.ms += r.duration_ms ?? 0;
    if (r.status === 'timeout') p.timeouts++;
    if (r.status === 'error') p.errors++;
    if (r.status === 'aborted') p.aborted++;
    if (r.tier) p.tiers[r.tier] = (p.tiers[r.tier] ?? 0) + 1;
    const pr = (profiles[r.profile ?? 'school'] ??= { calls: 0, input: 0, output: 0 });
    pr.calls++;
    pr.input += inp;
    pr.output += out;
  }
  for (const p of Object.values(purposes)) {
    p.avgOutput = p.calls ? Math.round(p.output / p.calls) : 0;
    p.avgMs = p.calls ? Math.round(p.ms / p.calls) : 0;
    delete p.ms;
  }
  const reflections = Object.fromEntries(world.db.prepare(`SELECT json_extract(data, '$.path') AS path, COUNT(*) AS n FROM events
    WHERE type = 'reflection_gate' AND real_time >= ? GROUP BY path`).all(since).map((r) => [r.path, r.n]));
  // step A6: how often each tier ran out of words, and how often we had to climb the cut-off ladder
  // or caught a tier rule being broken. Empty tiers still show up, at rate 0.
  const cutoffs = { full: { calls: 0, cutoff: 0 }, light: { calls: 0, cutoff: 0 }, none: { calls: 0, cutoff: 0 } };
  for (const r of rows) {
    if (!r.tier || !(r.tier in cutoffs)) continue;
    cutoffs[r.tier].calls++;
    if (r.finish_reason === 'length') cutoffs[r.tier].cutoff++;
  }
  for (const v of Object.values(cutoffs)) v.rate = v.calls ? Math.round((v.cutoff / v.calls) * 1000) / 1000 : 0;
  const countEvents = (type) => world.db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ? AND real_time >= ?').get(type, since).n;
  return {
    minutes, bucket, start, now, buckets, purposes, profiles, reflections,
    cutoffs,
    addressedBelowFull: countEvents('tier_violation'),
    retryCutoff: countEvents('retry_cutoff'),
    governor: world.governor?.view() ?? null,
    llmProfiles: world.llm.profilesView(),
  };
}

// ---------- memories ----------
export function memoriesOf(world, citizenId, { includeForgotten = true } = {}) {
  const c = world.citizens.get(citizenId);
  if (!c) return null;
  return {
    citizenId,
    now: world.now,
    coreMemory: c.coreMemory ?? '',
    onMyMind: c.onMyMind ?? [],
    memories: world.memory.all(citizenId, { includeForgotten }).map((m) => ({ ...m, text: world.memory.resolveNames(c, m.text) })),
  };
}

export function consolidationsOf(world, citizenId, { limit = 30 } = {}) {
  return world.db.prepare('SELECT id, game_time, data FROM consolidations WHERE citizen_id = ? ORDER BY id DESC LIMIT ?')
    .all(citizenId, Math.min(Number(limit) || 30, 200))
    .map((r) => ({ id: r.id, gameTime: r.game_time, ...JSON.parse(r.data) }));
}

/** Everyone's relationship rows, for the "what X believes" graph. */
export function beliefs(world, citizenId) {
  return world.memory.relsOf(citizenId).map((r) => ({
    from: r.citizenId, to: r.otherId, affinity: r.affinity, trust: r.trust, familiarity: r.familiarity,
    nameKnown: r.nameKnown, nameConfidence: r.nameConfidence, summary: r.summary,
  }));
}
