// HTTP server: static frontend, small JSON API, and Server-Sent Events for live updates.
// No framework, no dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { listEvents, getEvent, listConversations, getConversation, timeline, interactions, pairLines, usage, memoriesOf, consolidationsOf, beliefs } from './readmodels.js';
import { loadDirectorPresets } from './world/scenarios.js';

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

    ['GET', /^\/api\/timeline$/, (req) => timeline(world, { from: num(qs(req).get('from')), to: num(qs(req).get('to')) })],

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
      const limit = Math.min(Number(new URL(req.url, 'http://x').searchParams.get('limit')) || 20, 200);
      return world.db.prepare(`SELECT id, real_time, game_time, citizen_id, purpose, status, duration_ms,
                                      prompt_tokens, completion_tokens
                               FROM llm_calls ORDER BY id DESC LIMIT ?`).all(limit);
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
