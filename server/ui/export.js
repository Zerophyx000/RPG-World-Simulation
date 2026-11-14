// Full export of the world log: every event plus every LLM call (reasoning, answer, tool calls and,
// on request, the full prompt), merged in real-time order so each decision's thinking sits right before
// the action it produced. Read-only, streamed row by row (a long-running world has hundreds of MB of
// prompts), bounded by the newest ids at the start so rows written meanwhile don't stretch it.
//
// Linking: action events carry `callIds` (the LLM calls of the think that produced them) since this
// export was added. Older events get the same link inferred: the actor's decide/plan calls since their
// previous action-like event ("llmLink": "inferred").
//
// Pure over a DatabaseSync: `server/http.js` (GET /api/export) and `scripts/export-events.js` (offline,
// from the db file) both use it. Formats: `jsonl` (one JSON object per line, first line `kind: "meta"`)
// and `md` (readable).

import fs from 'node:fs';

const SCENARIOS = new URL('../../content/scenarios/', import.meta.url);
const EVENT_COLS = 'id, game_time, real_time, type, actor_id, location, data';
const CALL_COLS = `id, real_time, game_time, citizen_id, purpose, model, profile, tier, status, error, finish_reason,
  duration_ms, prompt_tokens, completion_tokens, reasoning, content, tool_calls`;
const THINK_PURPOSES = new Set(['decide', 'plan']);
const DECISION_TYPES = new Set(['action', 'action_stale', 'error', 'plan']);

export function stamp(minutes) {
  if (minutes == null) return '';
  const day = Math.floor(minutes / 1440) + 1;
  const m = ((minutes % 1440) + 1440) % 1440;
  return `Day ${day} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
}

/** Normalise query options (strings from a URL or argv). */
export function exportOptions(q = {}) {
  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : null);
  const flag = (v, d) => (v == null || v === '' ? d : !['0', 'false', 'no'].includes(String(v).toLowerCase()));
  return {
    format: q.format === 'md' ? 'md' : 'jsonl',
    from: num(q.from), to: num(q.to),
    citizen: q.citizen ? String(q.citizen) : null,
    types: list(q.types),
    llm: flag(q.llm, true),
    prompts: flag(q.prompts, false),
  };
}

export function exportFilename(opts, gameMinutes) {
  const day = Math.floor((gameMinutes ?? 0) / 1440) + 1;
  const who = opts.citizen ? `-${opts.citizen}` : '';
  return `agent-world-events${who}-day${day}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.${opts.format === 'md' ? 'md' : 'jsonl'}`;
}

/**
 * Yields the export as text chunks.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} opts from exportOptions()
 * @param {{gameMinutes?: number}} [now]
 */
export function* exportChunks(db, opts, now = {}) {
  const names = citizenNames(db);
  const rooms = new Map(db.prepare('SELECT id, name FROM rooms').all().map((r) => [r.id, r.name]));
  const maxEvent = db.prepare('SELECT MAX(id) AS m FROM events').get().m ?? 0;
  const maxCall = db.prepare('SELECT MAX(id) AS m FROM llm_calls').get().m ?? 0;

  const ew = ['id <= ?']; const ep = [maxEvent];
  const cw = ['id <= ?']; const cp = [maxCall];
  if (opts.from != null) { ew.push('game_time >= ?'); ep.push(opts.from); cw.push('game_time >= ?'); cp.push(opts.from); }
  if (opts.to != null) { ew.push('game_time <= ?'); ep.push(opts.to); cw.push('game_time <= ?'); cp.push(opts.to); }
  if (opts.types?.length) { ew.push(`type IN (${opts.types.map(() => '?').join(',')})`); ep.push(...opts.types); }
  if (opts.citizen) {
    ew.push('(actor_id = ? OR data LIKE ?)'); ep.push(opts.citizen, `%"${opts.citizen.replace(/[%_"]/g, '')}"%`);
    cw.push('citizen_id = ?'); cp.push(opts.citizen);
  }
  const count = (table, where, params) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where.join(' AND ')}`).get(...params).n;
  const nEvents = count('events', ew, ep);
  const nCalls = opts.llm ? count('llm_calls', cw, cp) : 0;

  const meta = {
    kind: 'meta', exportedAt: new Date().toISOString(),
    gameTime: now.gameMinutes ?? null, gameClock: stamp(now.gameMinutes),
    filters: { from: opts.from, to: opts.to, citizen: opts.citizen, types: opts.types, llm: opts.llm, prompts: opts.prompts },
    counts: { events: nEvents, llmCalls: nCalls },
    citizens: Object.fromEntries(names), rooms: Object.fromEntries(rooms),
  };
  yield opts.format === 'md' ? mdHeader(meta) : `${JSON.stringify(meta)}\n`;

  const events = db.prepare(`SELECT ${EVENT_COLS} FROM events WHERE ${ew.join(' AND ')} ORDER BY id`).iterate(...ep);
  const calls = opts.llm
    ? db.prepare(`SELECT ${CALL_COLS}${opts.prompts ? ', request' : ''} FROM llm_calls WHERE ${cw.join(' AND ')} ORDER BY id`).iterate(...cp)
    : [][Symbol.iterator]();

  const pending = new Map(); // actor -> call ids since their last decision-like event
  let e = events.next(); let c = calls.next();
  while (!e.done || !c.done) {
    // A call is logged when it returns, before the action it produced: on a tie the call goes first.
    const takeCall = !c.done && (e.done || c.value.real_time <= e.value.real_time);
    if (takeCall) {
      const row = c.value; c = calls.next();
      if (row.citizen_id && THINK_PURPOSES.has(row.purpose)) {
        if (!pending.has(row.citizen_id)) pending.set(row.citizen_id, []);
        pending.get(row.citizen_id).push(row.id);
      }
      const call = callRecord(row, names, opts.prompts);
      yield opts.format === 'md' ? mdCall(call) : `${JSON.stringify(call)}\n`;
    } else {
      const row = e.value; e = events.next();
      const ev = eventRecord(row, names, rooms);
      if (ev.actorId && DECISION_TYPES.has(ev.type) && !ev.data?.planned) { // planned steps are run by code, no LLM
        const inferred = pending.get(ev.actorId) ?? [];
        if (Array.isArray(ev.data.callIds) && ev.data.callIds.length) { ev.llmCallIds = ev.data.callIds; ev.llmLink = 'recorded'; }
        else if (inferred.length && opts.llm) { ev.llmCallIds = inferred; ev.llmLink = 'inferred'; }
        pending.delete(ev.actorId);
      }
      yield opts.format === 'md' ? mdEvent(ev) : `${JSON.stringify(ev)}\n`;
    }
  }
  if (opts.format === 'md') yield `\n---\n_End of export: ${nEvents} events, ${nCalls} LLM calls._\n`;
}

/** Writes the export to an HTTP response (or any writable) with backpressure. */
export async function streamExport(db, res, opts, now) {
  for (const chunk of exportChunks(db, opts, now)) {
    if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
    if (res.destroyed) return;
  }
  res.end();
}

// Citizens no longer in the table (removed, reseeded, director-made) keep their name: from the scenario
// files and from conversation participant lists in the log; the citizens table wins.
function citizenNames(db) {
  const names = new Map();
  try {
    for (const dir of fs.readdirSync(SCENARIOS)) {
      try {
        const j = JSON.parse(fs.readFileSync(new URL(`${dir}/citizens.json`, SCENARIOS), 'utf8'));
        for (const c of Array.isArray(j) ? j : (j.citizens ?? [])) if (c?.id && c.name) names.set(c.id, c.name);
      } catch { /* no citizens file */ }
    }
  } catch { /* no content dir */ }
  try {
    for (const r of db.prepare(`SELECT DISTINCT json_extract(p.value, '$.id') AS id, json_extract(p.value, '$.name') AS name
      FROM events e, json_each(e.data, '$.participants') p WHERE e.type = 'conversation_end'`).all()) if (r.id && r.name) names.set(r.id, r.name);
  } catch { /* old log shape */ }
  for (const r of db.prepare('SELECT id, name FROM citizens').all()) names.set(r.id, r.name);
  return names;
}

function parseJson(s, fallback) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return s; }
}

function eventRecord(row, names, rooms) {
  return {
    kind: 'event', id: row.id, type: row.type,
    gameTime: row.game_time, gameClock: stamp(row.game_time), realTime: row.real_time,
    actorId: row.actor_id ?? null, actorName: names.get(row.actor_id) ?? null,
    location: row.location ?? null, locationName: rooms.get(row.location) ?? null,
    data: parseJson(row.data, {}),
  };
}

function callRecord(row, names, withPrompt) {
  const rec = {
    kind: 'llm', id: row.id, purpose: row.purpose,
    gameTime: row.game_time, gameClock: stamp(row.game_time), realTime: row.real_time,
    citizenId: row.citizen_id ?? null, citizenName: names.get(row.citizen_id) ?? null,
    model: row.model, profile: row.profile ?? null, tier: row.tier ?? null,
    status: row.status, error: row.error ?? null, finishReason: row.finish_reason ?? null,
    durationMs: row.duration_ms, promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens,
    reasoning: row.reasoning ?? null, content: row.content ?? null, toolCalls: parseJson(row.tool_calls, null),
  };
  if (withPrompt) rec.request = parseJson(row.request, null);
  return rec;
}

// ---------- readable markdown ----------
const fence = (text, lang = '') => {
  const s = String(text);
  const ticks = '`'.repeat(Math.max(3, ...[...s.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}${lang}\n${s}\n${ticks}\n`;
};
const val = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

function mdHeader(meta) {
  const f = meta.filters;
  const range = f.from != null || f.to != null ? `${stamp(f.from) || 'start'} – ${stamp(f.to) || 'now'}` : 'everything';
  return `# Agent world: event export\n\n`
    + `- Exported: ${meta.exportedAt} (game time ${meta.gameClock || '?'})\n`
    + `- Range: ${range}${f.citizen ? ` · citizen: ${meta.citizens[f.citizen] ?? f.citizen}` : ''}${f.types ? ` · types: ${f.types.join(', ')}` : ''}\n`
    + `- ${meta.counts.events} events, ${meta.counts.llmCalls} LLM calls${f.llm ? (f.prompts ? ' (with full prompts)' : ' (reasoning and answers; prompts left out)') : ' (left out)'}\n\n`
    + `Events and LLM calls are in the order they happened. A 🧠 block is a model call; its reasoning comes before the action it produced.\n\n---\n\n`;
}

function mdEvent(ev) {
  const who = ev.actorName ?? ev.actorId;
  const where = ev.locationName ?? ev.location;
  let out = `### ${ev.gameClock} · ${ev.type}${who ? ` · ${who}` : ''}${where ? ` @ ${where}` : ''}  \n<sub>event #${ev.id} · ${ev.realTime}${ev.llmCallIds ? ` · from LLM call${ev.llmCallIds.length > 1 ? 's' : ''} ${ev.llmCallIds.map((i) => `#${i}`).join(', ')}${ev.llmLink === 'inferred' ? ' (inferred)' : ''}` : ''}</sub>\n\n`;
  const { thought, tool, args, callIds: _ids, ...rest } = ev.data ?? {};
  const parts = [];
  if (tool) {
    const a = args && typeof args === 'object' ? Object.entries(args) : [];
    parts.push(`**${tool}**${a.length ? `\n${a.map(([k, v]) => `- ${k}: ${val(v)}`).join('\n')}` : ''}`);
  }
  if (thought) parts.push(`> 💭 ${String(thought).replace(/\n/g, '\n> ')}`);
  const item = (k, v) => (typeof v === 'object' && v !== null && JSON.stringify(v).length > 160
    ? `- ${k}:\n${fence(JSON.stringify(v, null, 2), 'json').replace(/^(?=.)/gm, '  ').trimEnd()}`
    : `- ${k}: ${val(v)}`);
  const keys = Object.keys(rest);
  if (keys.length) parts.push(keys.map((k) => item(k, rest[k])).join('\n'));
  return `${out}${parts.join('\n\n')}${parts.length ? '\n\n' : ''}`;
}

function mdCall(call) {
  const who = call.citizenName ?? call.citizenId;
  const bits = [call.purpose, who, call.tier, call.profile, call.model, call.status !== 'ok' ? `**${call.status}**` : null,
    call.finishReason && call.finishReason !== 'stop' && call.finishReason !== 'tool_calls' ? `finish: ${call.finishReason}` : null,
    call.durationMs != null ? `${(call.durationMs / 1000).toFixed(1)} s` : null,
    call.promptTokens != null ? `${call.promptTokens} → ${call.completionTokens ?? 0} tokens` : null].filter(Boolean);
  let out = `#### 🧠 ${call.gameClock} · LLM call #${call.id} · ${bits.join(' · ')}  \n<sub>${call.realTime}</sub>\n\n`;
  if (call.error) out += `Error: ${call.error}\n\n`;
  if (call.reasoning) out += `<details open><summary>Reasoning</summary>\n\n${fence(call.reasoning)}\n</details>\n\n`;
  if (call.content) out += `Answer:\n\n${fence(call.content)}\n`;
  if (call.toolCalls?.length) out += `Tool call${call.toolCalls.length > 1 ? 's' : ''}:\n\n${fence(JSON.stringify(call.toolCalls, null, 2), 'json')}\n`;
  if (call.request) {
    const msgs = call.request.messages ?? [];
    out += `<details><summary>Prompt (${msgs.length} messages${call.request.tools ? `, ${call.request.tools.length} tools` : ''})</summary>\n\n`;
    for (const m of msgs) out += `**${m.role}**\n\n${fence(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? m, null, 2))}\n`;
    if (call.request.tools) out += `**tools**\n\n${fence(JSON.stringify(call.request.tools, null, 2), 'json')}\n`;
    out += `</details>\n\n`;
  }
  return out;
}
