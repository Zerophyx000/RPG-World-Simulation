// Entry point: open DB, run migrations, restore the world, serve.
// On SIGTERM/SIGINT (e.g. during a deploy) the world state is saved and
// restored on the next start, so deploying never wipes or rewinds the world.
import { config } from './config.js';
import { openDb, migrate } from './db.js';
import { World } from './world.js';
import { createServer } from './http.js';
import { Observer } from './observer/observer.js';

// step 10 (0.5): a live world never runs under the file watcher. node --watch / --watch-path re-runs this script as a child
// whose execArgv no longer carries the flag, but it sets WATCH_REPORT_DEPENDENCIES in the child's environment.
const watched = process.execArgv.some((a) => a.startsWith('--watch')) || process.env.WATCH_REPORT_DEPENDENCIES != null || process.env.npm_lifecycle_event === 'dev';
if (config.worldRole === 'live' && watched) {
  console.error('[world] WORLD_ROLE=live refuses to start under --watch (npm run dev): every edit in server/ would restart the live');
  console.error('        world on half-written code and run new migrations mid-work. Start it with "npm start"; update it with');
  console.error('        scripts/deploy.sh. For development, use a separate DATA_DIR and PORT with WORLD_ROLE=dev.');
  process.exit(1);
}

const db = openDb();
const applied = await migrate(db);

const world = new World(db);
world.start();
world.logEvent('system', { action: 'server.start', migrations: applied });

// The observer is wired here (not in World) so world/ and agents/ never depend on it.
const observer = new Observer(world);
const server = createServer(world, { observer });
server.listen(config.port, config.host, () => {
  const c = world.clock.snapshot();
  console.log(`[world] day ${c.day} ${c.time}, ${c.running ? 'running' : 'paused'} at ${c.speed}x`);
  console.log(`[http] http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`[llm] ${config.llm.model} @ ${config.llm.baseUrl}`);
  console.log(`[world] role: ${config.worldRole} · data: ${config.dataDir}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[world] ${signal} received, saving world...`);
  world.logEvent('system', { action: 'server.stop', signal });
  observer.stop();
  world.stop();              // saves clock (keeps running/paused flag as it was)
  server.closeStreams();
  server.close(() => {
    db.close();
    console.log('[world] saved, bye');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
