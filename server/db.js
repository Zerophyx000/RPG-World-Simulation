// SQLite (built into Node, no dependencies) + forward-only migrations.
//
// Golden rule for seamless deploys: NEVER edit a migration that has already
// run. To change the schema, add a new numbered file in server/migrations/.
//   - NNN_name.sql  -> plain SQL, runs inside a transaction
//   - NNN_name.js   -> `export function up(db) {...}` for data transformations
// Before any pending migration runs, the current DB is copied to data/backups/.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export function openDb() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(config.dbFile);
  db.exec('PRAGMA journal_mode = WAL;');      // crash-safe, fast writes
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  return db;
}

export async function migrate(db) {
  const files = fs.readdirSync(config.migrationsDir)
    .filter((f) => /^\d+_.+\.(sql|js)$/.test(f))
    .sort();
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) return [];

  if (applied.size > 0) backup(db, `pre-${path.parse(pending[0]).name}`);

  for (const file of pending) {
    const full = path.join(config.migrationsDir, file);
    db.exec('BEGIN');
    try {
      if (file.endsWith('.sql')) {
        db.exec(fs.readFileSync(full, 'utf8'));
      } else {
        const mod = await import(pathToFileURL(full).href);
        await mod.up(db);
      }
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
      db.exec('COMMIT');
      console.log(`[db] applied migration ${file}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed, nothing from it was applied: ${err.message}`);
    }
  }
  return pending;
}

export function backup(db, label) {
  const dir = path.join(config.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `${stamp}_${label}.db`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`); // consistent snapshot even while running
  console.log(`[db] backup written: ${path.relative(config.dataDir, target)}`);
  return target;
}

// Small helpers for the key/value world_state table.
export function getState(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM world_state WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setState(db, key, value) {
  db.prepare(`INSERT INTO world_state (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
}
