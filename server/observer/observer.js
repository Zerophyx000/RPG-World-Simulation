// The observer: one out-of-world LLM agent that watches the village and summarizes it FOR THE UI ONLY.
//
// HARD RULE: its output is never shown to citizens and never used in their prompts or in world logic.
// It's a camera, not a god. Nothing in server/agents/, server/world/ or server/memory/ may import from
// this folder; it is wired up in main.js and read only by http.js.
//
// Batched triggers (step 4) — a run starts when ANY of these holds AND at least
// OBSERVER_MIN_INTERVAL_REAL_SECONDS passed since the last run started:
//   - conversation batch: >= N conversations ended since the last report, N = max(1, ceil(citizens / OBSERVER_CONVERSATIONS_PER_CITIZENS))
//   - game hour: 60 game minutes since the last report and >= 10 new events
//   - big moment: a director event with importance >= 9, a death or a collapse (ignores N)
//   - manual (Refresh button): ignores N and the minimum interval
// One run at a time, at most one queued. A run always covers ALL events up to the moment it starts.
// Automatic runs only while the clock is running. Routed to 'local' first, then 'school'.
import { config } from '../config.js';

const HOURLY_MINUTES = 60;
const HOURLY_MIN_EVENTS = 10;
const INPUT_CHAR_BUDGET = 48000; // ~12k tokens of event text
const COUNTED_TYPES = ['action', 'arrive', 'conversation_end', 'director', 'damage', 'collapse', 'forced_sleep', 'learn_place', 'object', 'search', 'notice'];

export class Observer {
  constructor(world) {
    this.world = world;
    this.db = world.db;
    this.running = false;
    this.queued = null;
    this.lastError = null;
    this.lastRunStart = 0;
    this.endedSinceReport = 0;
    this.bigMoment = false;
    this.insert = this.db.prepare(`INSERT INTO observer_reports (game_time, real_time, last_event_id, data) VALUES (?, ?, ?, ?)`);

    this.onEvent = (e) => {
      if (e.type === 'conversation_end') this.endedSinceReport++;
      const d = e.data ?? {};
      if (e.type === 'death' || e.type === 'collapse' || (e.type === 'director' && (d.importance ?? 0) >= 9)) this.bigMoment = true;
    };
    world.bus.on('event', this.onEvent);
    this.timer = setInterval(() => this.#check(), 5000);
  }

  stop() {
    clearInterval(this.timer);
    this.world.bus.off('event', this.onEvent);
  }

  // ---------- reads ----------
  latest() {
    const row = this.db.prepare('SELECT * FROM observer_reports ORDER BY id DESC LIMIT 1').get();
    return row ? rowView(row) : null;
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM observer_reports WHERE id = ?').get(Number(id));
    return row ? rowView(row) : null;
  }

  history(limit = 50) {
    return this.db.prepare('SELECT id, game_time, real_time, last_event_id, data FROM observer_reports ORDER BY id DESC LIMIT ?')
      .all(Math.min(Number(limit) || 50, 500))
      .map((r) => ({ id: r.id, gameTime: r.game_time, realTime: r.real_time, lastEventId: r.last_event_id, headline: JSON.parse(r.data).headline ?? '' }))
      .reverse();
  }

  batchSize() {
    const living = [...this.world.citizens.values()].filter((c) => c.alive && c.kind === 'citizen').length;
    return Math.max(1, Math.ceil(living / Math.max(1, config.observer.conversationsPerCitizens)));
  }

  status() {
    return {
      running: this.running, queued: Boolean(this.queued), lastError: this.lastError,
      endedSinceReport: this.endedSinceReport, batchSize: this.batchSize(), bigMoment: this.bigMoment,
      nextAllowedInSeconds: Math.max(0, Math.round((this.lastRunStart + config.observer.minIntervalSeconds * 1000 - Date.now()) / 1000)),
    };
  }

  // ---------- triggers ----------
  #check() {
    if (!this.world.clock.running || this.running || this.world.stopped) return;
    if (Date.now() - this.lastRunStart < config.observer.minIntervalSeconds * 1000) return;
    if (this.bigMoment) return void this.trigger('big moment');
    if (this.endedSinceReport >= this.batchSize()) return void this.trigger('conversations');
    const last = this.latest();
    if (last && this.world.now - last.gameTime < HOURLY_MINUTES) return;
    if (this.#countNewEvents(last?.lastEventId ?? 0) >= HOURLY_MIN_EVENTS) this.trigger('hourly');
  }

  #countNewEvents(afterId) {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE id > ? AND type IN (${COUNTED_TYPES.map(() => '?').join(',')})`)
      .get(afterId, ...COUNTED_TYPES).n;
  }

  /** Start a run, or queue one follow-up if a run is in progress. Resolves with the run's result. */
  trigger(reason) {
    if (this.running) {
      this.queued ??= reason;
      return Promise.resolve({ queued: true });
    }
    return this.#run(reason);
  }

  async #run(reason) {
    this.running = true;
    this.lastRunStart = Date.now();
    // Everything up to now is covered by this run; new triggers count from here.
    this.endedSinceReport = 0;
    this.bigMoment = false;
    try {
      return await this.#runOnce(reason);
    } catch (err) {
      this.lastError = err.message;
      console.warn(`[observer] run failed: ${err.message}`);
      return { error: err.message };
    } finally {
      this.running = false;
      const next = this.queued;
      this.queued = null;
      if (next === 'manual' && !this.world.stopped) setImmediate(() => this.trigger(next));
      // automatic follow-ups are picked up by #check() once the minimum interval has passed
    }
  }

  async #runOnce(reason) {
    if (!this.world.llm.routeFor('observer').length) return { skipped: 'no model available for the observer right now (budget governor or no profile)' };
    const prev = this.latest();
    const afterId = prev?.lastEventId ?? 0;
    const rows = this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id').all(afterId);
    const lastEventId = rows.at(-1)?.id ?? afterId;
    const lines = renderEvents(this.world, rows);
    if (!lines.length && reason !== 'manual') return { skipped: 'no new events' };

    const citizens = [...this.world.citizens.values()].filter((c) => c.kind === 'citizen');
    const ids = citizens.map((c) => c.id);
    const tools = [reportTool(ids)];
    const messages = buildMessages(prev, citizens, lines);

    // Summarising needs no deliberation: thinking off (tier 'none') with room for a full report.
    const r = await this.world.llm.chat({ purpose: 'observer', messages, tools, tier: 'none', maxTokens: 4000 });
    const raw = r.toolCalls?.find((t) => t.name === 'report')?.arguments ?? safeJsonObject(r.content);
    if (!raw || typeof raw !== 'object' || '_raw' in raw) throw new Error('the model returned no usable report');

    const merged = merge(prev, raw, new Set(ids));
    const gameTime = this.world.now;
    const info = this.insert.run(gameTime, new Date().toISOString(), lastEventId, JSON.stringify(merged));
    const id = Number(info.lastInsertRowid);
    this.lastError = null;
    this.world.bus.emit('observer', { id, headline: merged.headline, gameTime, reason, callId: r.callId ?? null });
    return { id, headline: merged.headline };
  }
}

// ---------- prompt ----------
function buildMessages(prev, citizens, lines) {
  const people = citizens.map((c) => {
    const p = c.persona;
    const first = String(p.personality ?? '').split(/(?<=\.)\s/)[0];
    return `- ${c.id}: ${c.name}${p.age != null ? `, ${p.age}` : ''}${p.occupation ? `, ${p.occupation}` : ''}. ${first}`;
  }).join('\n');
  const previous = prev
    ? JSON.stringify({ headline: prev.headline, relationships: prev.relationships, threads: prev.threads })
    : '(none yet: this is the first report)';
  return [
    {
      role: 'system',
      content: `You are an observer watching a simulated village from outside. You write a running report for the people watching the simulation: the relationships between villagers and the storylines unfolding. Nobody in the village ever sees your report.

Rules:
- Base everything on what actually happened in the events. Don't speculate beyond them; inner thoughts (marked "thinks") are what the person privately thought.
- Be concrete and short. Labels are 1-4 words ("owes money", "protective of", "suspects theft").
- Relationships are directed: from → to describes how "from" feels about / acts towards "to". warmth -5 (hostile) .. +5 (devoted), tension 0 (calm) .. 5 (explosive).
- Only include relationship pairs that are NEW or CHANGED since the previous report.
- Threads are storylines. Keep their ids stable: if a thread continues, reuse its id exactly. New threads get a short kebab-case id. Status: active, resolved or dormant. Include every thread whose summary or status changed.
- keyMoments reference events by their number in square brackets, e.g. [#123].
- Lines marked [ground truth] show what really happened to objects, even when nobody saw it. The villagers only know what they saw, noticed or were told: keep "what really happened" and "what they believe" apart.
- The headline is one sentence: what is happening in the village right now.
Answer by calling the report tool exactly once.`,
    },
    {
      role: 'user',
      content: `PEOPLE\n${people}\n\nPREVIOUS REPORT\n${previous}\n\nNEW EVENTS SINCE THEN\n${lines.join('\n') || '(nothing new)'}\n\nUpdate the report. Be concrete. Base everything on what happened; don't speculate beyond it.`,
    },
  ];
}

function reportTool(ids) {
  return {
    type: 'function',
    function: {
      name: 'report',
      description: 'The updated observer report.',
      parameters: {
        type: 'object',
        properties: {
          headline: { type: 'string', description: 'One sentence: what is happening in the village right now.' },
          relationships: {
            type: 'array',
            description: 'Only pairs that are new or changed.',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string', enum: ids },
                to: { type: 'string', enum: ids },
                warmth: { type: 'integer', minimum: -5, maximum: 5 },
                tension: { type: 'integer', minimum: 0, maximum: 5 },
                label: { type: 'string', description: '1-4 words' },
                note: { type: 'string', description: 'One sentence of evidence.' },
              },
              required: ['from', 'to', 'warmth', 'tension', 'label'],
            },
          },
          threads: {
            type: 'array',
            description: 'Storylines that are new or changed. Reuse existing ids.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'stable kebab-case id, e.g. "missing-flour"' },
                title: { type: 'string', description: 'Human-readable title in words, e.g. "The missing flour" (not the id).' },
                status: { type: 'string', enum: ['active', 'resolved', 'dormant'] },
                involved: { type: 'array', items: { type: 'string', enum: ids } },
                summary: { type: 'string', description: '2-3 sentences.' },
                keyMoments: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { eventId: { type: 'integer' }, text: { type: 'string' } },
                    required: ['text'],
                  },
                },
              },
              required: ['id', 'title', 'status', 'involved', 'summary'],
            },
          },
        },
        required: ['headline', 'relationships', 'threads'],
      },
    },
  };
}

// ---------- events → readable lines ----------
function renderEvents(world, rows) {
  const name = (id) => world.citizens.get(id)?.name ?? id ?? '?';
  const room = (id) => world.rooms.get(id)?.name ?? id ?? 'somewhere';
  const out = [];
  for (const r of rows) {
    const d = JSON.parse(r.data);
    const tag = `[#${r.id} ${clock(r.game_time)}]`;
    const thinks = d.thought ? ` (thinks: "${d.thought}")` : '';
    let line = null;
    if (r.type === 'action') {
      const a = d.args ?? {};
      if (d.tool === 'say' || d.tool === 'tell_about_place') line = `${name(r.actor_id)}${d.toId ? ` → ${name(d.toId)}` : ''} at ${room(r.location)}: "${a.text}"${thinks}`;
      else if (d.tool === 'do') line = `${name(r.actor_id)} is ${a.action} at ${room(r.location)}${thinks}`;
      else if (d.tool === 'wait') line = d.thought ? `${name(r.actor_id)} waits (${a.reason})${thinks}` : null;
      else if (d.tool === 'eat') line = `${name(r.actor_id)} eats at ${room(r.location)}${thinks}`;
      else if (d.tool === 'sleep') line = `${name(r.actor_id)} goes to sleep at ${room(r.location)}${d.quality === 'rough' ? ' (on the ground)' : ''}${thinks}`;
      else if (d.tool === 'feed') line = `${name(r.actor_id)} feeds ${name(d.targetId)}, who had collapsed`;
      else if (d.tool === 'travel_to') line = d.thought ? `${name(r.actor_id)} sets off for ${room(d.args?.destination)}${thinks}` : null;
      else if (d.tool === 'leave_conversation') line = `${name(r.actor_id)} leaves the conversation${a.farewell ? `: "${a.farewell}"` : ''}${thinks}`;
      // move_to is summarized by the arrival
    } else if (r.type === 'arrive') {
      line = `${name(r.actor_id)} arrives at ${room(r.location)}${d.from ? ` from ${room(d.from)}` : ''}`;
    } else if (r.type === 'director' && d.action === 'event') {
      line = `EVENT at ${d.roomId === '*' ? 'everywhere' : room(d.roomId)}: ${d.texts?.here ?? d.text}${d.roomEffect ? ` (lasting: ${d.roomEffect.text})` : ''}`;
    } else if (r.type === 'director' && d.action === 'whisper') {
      line = `${name(d.citizenId)} privately perceives: ${d.text}`;
    } else if (r.type === 'body' && d.importance >= 7) {
      line = `${name(r.actor_id)} is ${d.level}`;
    } else if (r.type === 'collapse' || r.type === 'forced_sleep') {
      line = `${name(r.actor_id)} ${r.type === 'collapse' ? 'collapses' : 'drops asleep from exhaustion'} at ${room(r.location)}`;
    } else if (r.type === 'revive' || r.type === 'death') {
      line = `${name(r.actor_id)} ${r.type === 'death' ? 'dies' : `comes to${d.by && d.by !== 'director' ? ` (helped by ${name(d.by)})` : ''}`}`;
    } else if (r.type === 'learn_place') {
      line = `${name(r.actor_id)} learns about ${room(d.placeId)} from ${name(d.from)}`;
    } else if (r.type === 'director' && d.action === 'effects') {
      line = `(something happens: ${(d.effects ?? []).map((x) => x.type).join(', ')})`;
    } else if (r.type === 'damage') {
      line = `${name(r.actor_id)} is hurt (hp now ${d.hp})`;
    } else if (r.type === 'conversation_end') {
      line = `(conversation between ${(d.participants ?? []).map((p) => p.name).join(', ')} ended: ${d.reason})`;
    } else if (r.type === 'object') {
      // Step 5: the object history is GROUND TRUTH (read-only): who really did what, and who saw it.
      line = objectLine(world, r, d, name, room);
    } else if (r.type === 'search') {
      line = `${name(r.actor_id)} searches ${room(r.location)}${d.targetId ? ` around the ${world.objects.get(d.targetId)?.typeId ?? d.targetId}` : ''}: ${d.found?.length ? `finds ${d.found.map((id) => objLabel(world, id)).join(', ')}` : 'finds nothing'}`;
    } else if (r.type === 'notice') {
      line = `${name(r.actor_id)} notices at ${room(r.location)}: ${d.text}`;
    }
    if (line) out.push(`${tag} ${line}`);
  }
  // Budget: keep the newest events, say how many older ones were cut.
  let total = 0;
  let keepFrom = out.length;
  while (keepFrom > 0 && total + out[keepFrom - 1].length + 1 <= INPUT_CHAR_BUDGET) total += out[--keepFrom].length + 1;
  const kept = out.slice(keepFrom);
  if (keepFrom > 0) kept.unshift(`(${keepFrom} older events omitted)`);
  return kept;
}

function objLabel(world, id) {
  const o = world.objects.get(id);
  if (!o) return id;
  const owner = o.ownerId ? `${world.citizens.get(o.ownerId)?.name ?? o.ownerId}'s ` : '';
  return `${owner}${world.objects.type(o)?.name ?? o.typeId}`;
}

function objectLine(world, r, d, name, room) {
  const who = r.actor_id ? name(r.actor_id) : d.by === 'director' ? 'The director' : null;
  if (!who || ['seed', 'create', 'edit', 'reset'].includes(d.action)) return null;
  const what = objLabel(world, d.objectId);
  const a = d.after ?? {};
  const where = a.placement?.of ? `${a.placement.relation} the ${world.objects.get(a.placement.of)?.typeId ?? a.placement.of}` : '';
  const seen = r.actor_id && d.witnesses ? (d.witnesses.length ? ` (seen by ${d.witnesses.map(name).join(', ')})` : ' (nobody saw it)') : '';
  const verbs = {
    take: `takes ${what} at ${room(r.location)}`,
    put: `puts ${what} down ${where || ''} at ${room(r.location)}`,
    give: `gives ${what} to ${name(a.holder)}`,
    conceal: `HIDES ${what} ${where} at ${room(r.location)}`,
    use: `${d.intent ? `"${d.intent}": ` : ''}${what}${d.before?.state !== a.state ? ` is now ${a.state}` : ''}`,
    use_rejected: `tries "${d.intent}" on ${what}, which doesn't work`,
    state: `${what} at ${room(r.location)} is now ${a.state}`,
    move: `moves ${what} to ${a.holder ? name(a.holder) : room(a.room)}`,
  };
  return `[ground truth] ${who} ${verbs[d.action] ?? `${d.action} ${what}`}${seen}`.replace(/\s+/g, ' ');
}

// ---------- merge ----------
function merge(prev, raw, validIds) {
  const rel = new Map((prev?.relationships ?? []).map((r) => [`${r.from}>${r.to}`, r]));
  for (const r of Array.isArray(raw.relationships) ? raw.relationships : []) {
    if (!r || !validIds.has(r.from) || !validIds.has(r.to) || r.from === r.to) continue;
    rel.set(`${r.from}>${r.to}`, {
      from: r.from,
      to: r.to,
      warmth: clampInt(r.warmth, -5, 5, 0),
      tension: clampInt(r.tension, 0, 5, 0),
      label: String(r.label ?? '').slice(0, 60),
      note: String(r.note ?? '').slice(0, 400),
    });
  }
  const threads = new Map((prev?.threads ?? []).map((t) => [t.id, t]));
  for (const t of Array.isArray(raw.threads) ? raw.threads : []) {
    if (!t) continue;
    const id = slug(t.id || t.title);
    if (!id) continue;
    const old = threads.get(id);
    threads.set(id, {
      id,
      title: String(t.title ?? old?.title ?? id).slice(0, 120),
      status: ['active', 'resolved', 'dormant'].includes(t.status) ? t.status : old?.status ?? 'active',
      involved: (Array.isArray(t.involved) ? t.involved : old?.involved ?? []).filter((x) => validIds.has(x)),
      summary: String(t.summary ?? old?.summary ?? '').slice(0, 1200),
      keyMoments: Array.isArray(t.keyMoments) && t.keyMoments.length
        ? t.keyMoments.filter((k) => k && k.text).map((k) => ({ eventId: Number.isFinite(Number(k.eventId)) ? Number(k.eventId) : null, text: String(k.text).slice(0, 200) }))
        : old?.keyMoments ?? [],
    });
  }
  return {
    headline: String(raw.headline ?? prev?.headline ?? '').slice(0, 400),
    relationships: [...rel.values()],
    threads: [...threads.values()],
  };
}

function rowView(row) {
  return { id: row.id, gameTime: row.game_time, realTime: row.real_time, lastEventId: row.last_event_id, ...JSON.parse(row.data) };
}

function clock(min) {
  const day = Math.floor(min / 1440) + 1;
  const m = ((min % 1440) + 1440) % 1440;
  return `D${day} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function slug(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function safeJsonObject(s) {
  const m = String(s ?? '').match(/\{[\s\S]*\}/);
  try {
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}
