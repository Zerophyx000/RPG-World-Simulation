// Entry point: open DB, run migrations, restore the world, serve.
// On SIGTERM/SIGINT (e.g. during a deploy) the world state is saved and
// restored on the next start, so deploying never wipes or rewinds the world.
import { config } from './config.js';
import { openDb, migrate } from './db.js';
import { World } from './world.js';
import { createServer } from './http.js';
import { Observer } from './observer/observer.js';

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
