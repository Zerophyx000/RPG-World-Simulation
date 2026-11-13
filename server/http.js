// HTTP server: static frontend, small JSON API, and Server-Sent Events for live updates.
// No framework, no dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { listEvents, getEvent, listConversations, getConversation, timeline, interactions, pairLines, usage, memoriesOf, consolidationsOf, beliefs } from './readmodels.js';
import { loadDirectorPresets } from './world/scenarios.js';
import { testDayRoutes } from './world/testdays.js'; // step A8: the runner's routes, spread in below

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function createServer(world, { observer = null } = {}) {
  const sseClients = new Set();

  const broadcast = (type, payload) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) res.write(msg);
  };
  world.bus.on('clock', (s) => broadcast('clock', s));
  world.bus.on('event', (e) => broadcast('event', e));
  world.bus.on('llm', (c) => broadcast('llm', c));
  world.bus.on('citizen', (c) => broadcast('citizen', c));
  world.bus.on('conversation', (c) => broadcast('conversation', c));
  world.bus.on('world', (w) => broadcast('world', w));
  world.bus.on('room', (r) => broadcast('room', r));
  world.bus.on('observer', (o) => broadcast('observer', o));
  world.bus.on('governor', (g) => broadcast('governor', g));
  world.bus.on('memory', (m) => broadcast('memory', m));
  world.bus.on('relationship', (r) => broadcast('relationship', r));
  world.bus.on('object', (o) => broadcast('object', o));
  world.bus.on('group', (g) => broadcast('group', g));
  world.bus.on('emotion_room', (r) => broadcast('emotion_room', r));

  const qs = (req) => new URL(req.url, 'http://x').searchParams;
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const found = (v) => {
    if (v == null) throw httpError(404, 'not found');
    return v;
  };
  const needObserver = () => {
    if (!observer) throw httpError(503, 'observer not running');
    return observer;
  };
  // Heartbeat: clock state every second (also keeps proxies from closing the stream).
  const heartbeat = setInterval(() => broadcast('clock', { ...world.clock.snapshot(), llm: world.llm.stats() }), 1000);

  // ---- API routes: "METHOD /path" -> handler(req, body, params) ----
  const routes = [
    ['GET', /^\/api\/state$/, () => ({
      clock: world.clock.snapshot(),
      llm: world.llm.stats(),
      governor: world.governor.view(),
      events: world.recentEvents(50),
    })],

    ['POST', /^\/api\/clock$/, (_req, body) => {
      if (body.action === 'pause') world.pause();       // also aborts in-flight thinks
      else if (body.action === 'resume') world.resume();
      else if (body.action === 'speed') world.clock.setSpeed(body.value);
      else throw httpError(400, 'action must be pause | resume | speed');
      world.logEvent('director', { action: `clock.${body.action}`, value: body.value ?? null });
      return world.clock.snapshot();
    }],

    // ---- World + citizens ----
    ['GET', /^\/api\/world$/, () => world.snapshot()],

    ['GET', /^\/api\/citizens\/([\w-]+)$/, (_req, _body, [id]) => world.citizenDetail(id)],

    ['POST', /^\/api\/citizens$/, (_req, body) => world.createCitizen(body)],

    // ---- Director ----
    // { roomId?, radius, importance, texts: {here, near, far}, roomEffect, effects: [...] } — see world/director.js
    ['POST', /^\/api\/director\/event$/, (_req, body) => world.directorEvent(body)],

    // Effects without a perceived event, e.g. [{ type: 'damage', target: 'tomas', amount: 20, notify: 'A beam falls on you.' }]
    ['POST', /^\/api\/director\/apply$/, (_req, body) => world.directorEvent({ roomId: body.roomId ?? null, radius: body.radius, effects: body.effects })],

    ['GET', /^\/api\/director\/effect-types$/, () => world.effectTypes()],

    ['POST', /^\/api\/director\/needs$/, (_req, body) =>
      world.setNeeds({ citizenId: body.citizenId, hunger: body.hunger, fatigue: body.fatigue, hp: body.hp })],

    ['POST', /^\/api\/director\/revive$/, (_req, body) => world.revive({ citizenId: body.citizenId })],

    ['GET', /^\/api\/director\/scenarios$/, () => world.scenarios()],

    // ---- Test days (step A8): scripted director days, see world/testdays.js ----
    ...testDayRoutes(world),

    // ---- Memory & relationships (director tools) ----
    ['POST', /^\/api\/director\/memory$/, (_req, body) => world.directorMemory(body)],
    ['POST', /^\/api\/director\/consolidate$/, (_req, body) => world.consolidateCitizen({ citizenId: body.citizenId })],
    ['POST', /^\/api\/director\/relationship$/, (_req, body) => world.setRelationship(body)],
    ['POST', /^\/api\/director\/bootstrap-memories$/, (_req, body) => world.bootstrapMemories({ citizenIds: body.citizenIds })],
    ['GET', /^\/api\/citizens\/([\w-]+)\/memories$/, (req, _body, [id]) => found(memoriesOf(world, id, { includeForgotten: qs(req).get('forgotten') !== '0' }))],
    ['GET', /^\/api\/citizens\/([\w-]+)\/consolidations$/, (req, _body, [id]) => consolidationsOf(world, id, { limit: qs(req).get('limit') })],
    ['GET', /^\/api\/citizens\/([\w-]+)\/beliefs$/, (_req, _body, [id]) => beliefs(world, id)],

    // ---- LLM profiles, usage, budget governor ----
    ['GET', /^\/api\/llm\/profiles$/, () => world.llm.profilesView()],
    ['GET', /^\/api\/llm\/usage$/, (req) => usage(world, { minutes: qs(req).get('minutes'), bucket: qs(req).get('bucket') })],
    ['GET', /^\/api\/governor$/, () => world.governor.view()],
    ['POST', /^\/api\/governor$/, (_req, body) => world.governor.setBudget(body.budgetPerHour)],

    ['GET', /^\/api\/director\/presets$/, () => loadDirectorPresets()],

    // ---- Emotions (step 6) ----
    ['GET', /^\/api\/citizens\/([\w-]+)\/emotions$/, (_req, _body, [id]) => world.emotions.view(found(world.citizens.get(id)))],
    ['GET', /^\/api\/citizens\/([\w-]+)\/emotions\/history$/, (req, _body, [id]) => world.emotions.history(id, { from: num(qs(req).get('from')), to: num(qs(req).get('to')), limit: qs(req).get('limit') })],
    // ---- Step 7B: body, injuries, death ----
    ['GET', /^\/api\/citizens\/([\w-]+)\/body$/, (_req, _body, [id]) => world.body.view(found(world.citizens.get(id)).id)],
    ['GET', /^\/api\/citizens\/([\w-]+)\/conditions$/, (req, _body, [id]) => world.body.conditionsView(found(world.citizens.get(id)).id, { all: qs(req).get('all') === '1' })],
    ['POST', /^\/api\/director\/injure$/, (_req, body) => {
      const r = world.body.injure(body.citizenId, body);
      return { conditions: r.conditions.map((x) => world.body.conditionView(x)), garments: r.garments };
    }],
    ['POST', /^\/api\/director\/heal$/, (_req, body) => world.body.heal(body.citizenId, { conditionId: body.conditionId ?? null, partId: body.partId ?? null, all: body.conditionId == null && !body.partId, amount: body.amount ?? 10, source: 'director', allowPermanent: false })],
    ['POST', /^\/api\/director\/kill$/, (_req, body) => ({ ok: world.body.kill(body.citizenId, body.cause ?? 'the director') })],
    ['POST', /^\/api\/director\/regen$/, (_req, body) => world.body.setRegen(body.citizenId, body.multiplier, { source: 'director', until: body.until ?? null })],
    ['GET', /^\/api\/body\/rates$/, () => ({ ...config.body })],
    ['POST', /^\/api\/director\/body-rates$/, (_req, body) => {
      for (const k of ['accidentRate', 'illnessRate', 'healTimeScale', 'criticalGraceMinutes', 'criticalSlowdown']) if (body[k] != null && Number.isFinite(Number(body[k]))) config.body[k] = Number(body[k]);
      return { ...config.body };
    }],
    ['POST', /^\/api\/director\/emotion$/, (_req, body) => world.emotions.directorEmotion(body)],
    ['POST', /^\/api\/director\/mood$/, (_req, body) => world.emotions.directorMood(body)],
    ['GET', /^\/api\/emotions\/types$/, () => ({ types: world.emotions.types, contagion: world.emotions.contagionOn, paramEffects: world.emotions.paramEffects })],
    ['GET', /^\/api\/emotions\/appraisals$/, (req) => world.emotions.appraisalLog(qs(req).get('limit'))],
    ['GET', /^\/api\/emotions\/aimed$/, () => [...world.citizens.values()].flatMap((c) => world.emotions.of(c).filter((e) => e.target && e.intensity >= 2)
      .map((e) => ({ from: c.id, to: e.target, about: e.about, type: e.type, intensity: Math.round(e.intensity * 10) / 10, color: world.emotions.types[e.type]?.color, cause: e.cause })))],
    ['POST', /^\/api\/director\/contagion$/, (_req, body) => world.emotions.setContagion(body.enabled)],

    // ---- Trust with reasons, groups, strangers (step 5.5) ----
    ['GET', /^\/api\/citizens\/([\w-]+)\/relationships\/([\w-]+)\/events$/, (_req, _body, [id, other]) => world.relationshipEvents(id, other)],
    ['GET', /^\/api\/citizens\/([\w-]+)\/wariness$/, (req, _body, [id]) => world.warinessOf(id, qs(req).get('other'))],
    ['GET', /^\/api\/relationships\/signals$/, () => world.db.prepare(`SELECT citizen_id AS "from", other_id AS "to", SUM(d_trust) AS dTrust, COUNT(*) AS n
      FROM relationship_events WHERE source = 'signal' GROUP BY citizen_id, other_id`).all()],
    ['GET', /^\/api\/groups$/, () => world.groups.list()],
    ['GET', /^\/api\/groups\/([\w-]+)$/, (_req, _body, [id]) => found(world.groups.list().find((g) => g.id === id))],
    ['POST', /^\/api\/groups$/, (_req, body) => world.groups.create(body, { origin: 'director' })],
    ['PATCH', /^\/api\/groups\/([\w-]+)$/, (_req, body, [id]) => world.groups.edit(id, body)],
    ['GET', /^\/api\/director\/inactive$/, () => world.inactiveCitizens()],
    ['POST', /^\/api\/director\/activate$/, (_req, body) => world.activateCitizen({ id: body.id, location: body.location })],
    ['POST', /^\/api\/director\/signal$/, (_req, body) => world.signals.simulate(body)],
    ['POST', /^\/api\/director\/stranger-trust$/, (_req, body) => world.setStrangerTrust(body)],
    ['POST', /^\/api\/director\/persona-list$/, (_req, body) => world.setPersonaList(body)],
    ['POST', /^\/api\/director\/room-danger$/, (_req, body) => world.setRoomDanger(body)],
    ['GET', /^\/api\/cues$/, () => world.strangers.cues],

    // ---- Objects (step 5) ----
    ['GET', /^\/api\/rooms\/([\w-]+)\/objects$/, (req, _body, [id]) => world.roomObjects(id, { view: qs(req).get('view') ?? 'true', citizen: qs(req).get('citizen') })],
    ['GET', /^\/api\/objects\/([\w-]+)$/, (_req, _body, [id]) => world.objectDetail(id)],
    ['GET', /^\/api\/object-types$/, () => world.objects.typesView()],
    ['POST', /^\/api\/director\/objects$/, (_req, body) => world.createObject(body)],
    ['POST', /^\/api\/director\/objects\/reset$/, (_req, body) => world.resetObject(body.objectId)],
    ['PATCH', /^\/api\/director\/objects\/([\w-]+)$/, (_req, body, [id]) => world.patchObject(id, body)],

    // LLM helper: write near/far versions of a "here" text for the director to edit.
    ['POST', /^\/api\/director\/event-texts$/, (_req, body) => world.generateEventTexts({ roomId: body.roomId, here: body.here })],

    ['POST', /^\/api\/director\/clear-effect$/, (_req, body) => world.clearEffect(body.roomId, body.effectId ?? null)],

    ['POST', /^\/api\/director\/whisper$/, (_req, body) =>
      world.whisper({ citizenId: body.citizenId, text: body.text, importance: body.importance })],

    // Dev only: backs up the DB, then wipes rooms + citizens and seeds them again from content/.
    ['POST', /^\/api\/director\/reseed$/, (_req, body) => {
      if (body.confirm !== 'WIPE') throw httpError(400, 'send {"confirm": "WIPE"} to wipe and reseed the world');
      return world.reseed({ scenario: body.scenario });
    }],

    // ---- Read models for the UI ----
    ['GET', /^\/api\/events$/, (req) => {
      const q = qs(req);
      return listEvents(world, { limit: q.get('limit'), before: q.get('before'), types: q.get('types')?.split(',').filter(Boolean) });
    }],

    ['GET', /^\/api\/events\/(\d+)$/, (_req, _body, [id]) => found(getEvent(world, id))],

    ['GET', /^\/api\/conversations$/, (req) => {
      const q = qs(req);
      const active = q.get('active') === '1' ? true : q.get('active') === '0' ? false : null;
      return listConversations(world, { active, citizen: q.get('citizen') || null, limit: q.get('limit') });
    }],

    ['GET', /^\/api\/conversations\/([\w-]+)$/, (_req, _body, [id]) => found(getConversation(world, id))],

    ['GET', /^\/api\/timeline$/, (req) => {
      const from = num(qs(req).get('from'));
      const to = num(qs(req).get('to'));
      return { ...timeline(world, { from, to }), emotions: world.emotions.timeline(from, to) };
    }],

    ['GET', /^\/api\/relationships$/, (req) => interactions(world, { from: num(qs(req).get('from')), to: num(qs(req).get('to')) })],

    ['GET', /^\/api\/relationships\/lines$/, (req) => {
      const q = qs(req);
      return pairLines(world, q.get('a'), q.get('b'), { limit: q.get('limit'), until: num(q.get('until')) });
    }],

    // ---- Observer (out-of-world, UI only) ----
    ['GET', /^\/api\/observer\/latest$/, () => ({ report: needObserver().latest(), status: needObserver().status() })],
    ['GET', /^\/api\/observer\/history$/, (req) => needObserver().history(qs(req).get('limit'))],
    ['GET', /^\/api\/observer\/(\d+)$/, (_req, _body, [id]) => found(needObserver().get(id))],
    ['POST', /^\/api\/observer\/run$/, () => needObserver().trigger('manual')],

    // Connectivity + thinking check against the configured LLM.
    ['POST', /^\/api\/llm\/test$/, async (_req, body) => {
      const prompt = String(body.prompt ?? '').trim() || 'You are a baker in a small village. A stranger in a torn cloak asks you for free bread. What do you do?';
      const r = await world.llm.chat({
        purpose: 'test',
        messages: [
          { role: 'system', content: 'You are a character in a living world. Think through the situation in your own head first, then answer in character.' },
          { role: 'user', content: prompt },
        ],
      });
      return r;
    }],

    ['GET', /^\/api\/llm\/calls$/, (req) => {
      const q = new URL(req.url, 'http://x').searchParams;
      const limit = Math.min(Number(q.get('limit')) || 20, 200);
      const where = [];
      const params = [];
      const qv = q.get('citizenId');
      if (qv) { where.push('citizen_id = ?'); params.push(qv); }
      const pv = q.get('purpose');
      if (pv) { where.push('purpose = ?'); params.push(pv); }
      params.push(limit);
      // step A6: finish_reason (cut-off analysis) + has_reasoning for the call list
      return world.db.prepare(`SELECT id, real_time, game_time, citizen_id, purpose, tier, status, finish_reason, duration_ms,
                                      prompt_tokens, completion_tokens, (reasoning IS NOT NULL AND reasoning <> '') AS has_reasoning
                               FROM llm_calls ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...params);
    }],

    ['GET', /^\/api\/llm\/calls\/(\d+)$/, (_req, _body, [id]) => {
      const row = world.db.prepare('SELECT * FROM llm_calls WHERE id = ?').get(Number(id));
      if (!row) throw httpError(404, 'not found');
      return { ...row, request: JSON.parse(row.request), tool_calls: row.tool_calls && JSON.parse(row.tool_calls) };
    }],
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // Live stream
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: clock\ndata: ${JSON.stringify(world.clock.snapshot())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // API
    if (url.pathname.startsWith('/api/')) {
      for (const [method, pattern, handler] of routes) {
        const m = url.pathname.match(pattern);
        if (!m || method !== req.method) continue;
        try {
          const body = req.method === 'POST' || req.method === 'PATCH' ? await readJson(req) : {};
          const result = await handler(req, body, m.slice(1));
          return sendJson(res, 200, result);
        } catch (err) {
          return sendJson(res, err.status ?? 500, { error: err.message });
        }
      }
      return sendJson(res, 404, { error: 'unknown endpoint' });
    }

    // Static files
    serveStatic(url.pathname, res);
  });

  server.on('close', () => clearInterval(heartbeat));
  server.closeStreams = () => {
    for (const res of sseClients) res.end();
    sseClients.clear();
  };
  return server;
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(config.publicDir, rel);
  if (!file.startsWith(config.publicDir + path.sep) && file !== config.publicDir) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    }).end(data);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(httpError(413, 'body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(httpError(400, 'invalid JSON'));
      }
    });
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(obj));
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
