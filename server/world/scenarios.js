// Scenarios and content loading.
//
// content/
//   world.md                    common knowledge (every citizen's system prompt)
//   rooms.json                  the shared map. Upserted on EVERY boot (rooms are content, not state)
//   needs.json, needs-text.json body model (needs.js)
//   director-presets.json       ready-made director events
//   scenarios/<id>/citizens.json  starting citizens
//   scenarios/<id>/scenario.md    optional text appended to world.md for this scenario
//   scenarios/<id>/scenario.json  optional { label, startTime: "07:00" }
//
// Citizens are seeded only into an empty table (or by the dev-only reseed). The active scenario
// is remembered in world_state['scenario'] so a restart keeps using the same scenario text.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { getState, setState } from '../db.js';
import { normalizeRoom, RUNTIME_ROOM_FIELDS } from './rooms.js';
import { citizenFromInput } from './citizens.js';

export const CONTENT_DIR = path.join(ROOT, 'content');
const SCEN_DIR = path.join(CONTENT_DIR, 'scenarios');

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
}

export function listScenarios() {
  if (!fs.existsSync(SCEN_DIR)) return [];
  return fs.readdirSync(SCEN_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(SCEN_DIR, d.name, 'citizens.json')))
    .map((d) => ({ id: d.name, label: readJson(path.join(SCEN_DIR, d.name, 'scenario.json'), {})?.label ?? d.name }));
}

export function loadScenario(id) {
  const dir = path.join(SCEN_DIR, id);
  const file = path.join(dir, 'citizens.json');
  if (!/^[\w-]+$/.test(id) || !fs.existsSync(file)) {
    throw new Error(`unknown scenario "${id}" (have: ${listScenarios().map((s) => s.id).join(', ') || 'none'})`);
  }
  const meta = readJson(path.join(dir, 'scenario.json'), {}) ?? {};
  const citizens = readJson(file);
  if (!Array.isArray(citizens)) throw new Error(`content/scenarios/${id}/citizens.json must contain a JSON array`);
  return { id, label: meta.label ?? id, startTime: meta.startTime ?? null, text: readText(path.join(dir, 'scenario.md')), citizens };
}

export function activeScenario(db, fallback) {
  return getState(db, 'scenario', null) ?? fallback;
}

/** world.md plus the active scenario's text. */
export function loadWorldText(scenarioId) {
  const base = readText(path.join(CONTENT_DIR, 'world.md'));
  let extra = '';
  try {
    extra = loadScenario(scenarioId).text;
  } catch { /* unknown scenario: just world.md */ }
  return [base, extra].filter(Boolean).join('\n\n');
}

/**
 * Upsert all rooms from content/rooms.json. Content fields are replaced; runtime state
 * (effects, service overrides, blocked exits) is kept. Rooms with origin 'runtime' are never touched.
 */
export function upsertRooms(db) {
  const content = readJson(path.join(CONTENT_DIR, 'rooms.json'), []);
  if (!Array.isArray(content)) throw new Error('content/rooms.json must contain a JSON array');
  const existing = new Map(db.prepare('SELECT id, name, data FROM rooms').all().map((r) => [r.id, normalizeRoom(r)]));
  const upd = db.prepare('UPDATE rooms SET name = ?, data = ? WHERE id = ?');
  const ins = db.prepare('INSERT INTO rooms (id, name, data) VALUES (?, ?, ?)');
  let inserted = 0;
  let updated = 0;
  db.exec('BEGIN');
  try {
    for (const raw of content) {
      const fresh = normalizeRoom({ ...raw, origin: 'content' });
      const old = existing.get(fresh.id);
      if (old?.origin === 'runtime') continue;
      for (const k of RUNTIME_ROOM_FIELDS) if (old) fresh[k] = old[k];
      const { id, name, ...data } = fresh;
      if (old) {
        upd.run(name, JSON.stringify(data), id);
        updated++;
      } else {
        ins.run(id, name, JSON.stringify(data));
        inserted++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw new Error(`Loading content/rooms.json failed: ${err.message}`);
  }
  if (inserted) console.log(`[content] inserted ${inserted} rooms (${updated} updated)`);
  return { inserted, updated };
}

/** Seed the scenario's citizens into an EMPTY citizens table. Returns { count, inputs } or null. */
export function seedCitizensIfEmpty(db, rooms, now, scenarioId) {
  if (db.prepare('SELECT COUNT(*) AS n FROM citizens').get().n > 0) return null;
  const scenario = loadScenario(scenarioId);
  const insert = db.prepare(`INSERT INTO citizens (id, name, kind, alive, location, born_at, died_at, data)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const ids = new Set();
  db.exec('BEGIN');
  try {
    for (const input of scenario.citizens) {
      if (input.active === false) continue; // test characters (e.g. Kael) wait for the director to activate them
      const c = citizenFromInput(input, { rooms, existingIds: ids, now });
      ids.add(c.id);
      const { id, name, kind, alive, location, bornAt, diedAt, ...data } = c;
      insert.run(id, name, kind, alive ? 1 : 0, location, bornAt, diedAt, JSON.stringify(data));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw new Error(`Seeding scenario "${scenarioId}" failed, nothing was inserted: ${err.message}`);
  }
  setState(db, 'scenario', scenarioId);
  console.log(`[content] seeded ${ids.size} citizens from scenario "${scenarioId}"`);
  return { count: ids.size, inputs: scenario.citizens.filter((x) => x.active !== false) };
}

/** Dev only: delete all citizens (rooms are re-upserted). Caller backs up first. */
export function wipeCitizens(db) {
  db.exec(`DELETE FROM citizens; DELETE FROM memories; DELETE FROM relationships; DELETE FROM consolidations;
           DELETE FROM relationship_events; DELETE FROM groups; DELETE FROM group_members;`);
}

/** Ready-made director events for the director form (content/director-presets.json). */
export function loadDirectorPresets() {
  try {
    return readJson(path.join(CONTENT_DIR, 'director-presets.json'), []);
  } catch (err) {
    console.warn(`[content] director presets unreadable: ${err.message}`);
    return [];
  }
}

export function loadNeedsContent() {
  return {
    config: readJson(path.join(CONTENT_DIR, 'needs.json'), {}),
    text: readJson(path.join(CONTENT_DIR, 'needs-text.json'), {}),
  };
}
