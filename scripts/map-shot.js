// Step 8: a screenshot of the map as PNG, drawn by the same scene code the browser uses (software renderer).
//   node scripts/map-shot.js [--url http://localhost:3000] [--out shot.png] [--zoom 1] [--w 960] [--h 640]
//        [--local (maps and art from disk)] [--room tavern | --x 1200 --y 800] [--night] [--time 22:00] [--select greta] [--roofs on|off|auto] [--scale 1]
// Reads /api/world, /api/looks, /api/maps and /api/art from a running server (read-only), or --state file.json
// (a saved { world, looks, maps, art }) so the shot works offline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePalette } from '../public/art/palette.js';
import { createScene } from '../public/art/scene.js';
import { ImgTarget } from '../public/art/target.js';
import { writePng } from './art-dump.js';
import { hex } from '../public/art/pixels.js';
import { TILE, mapRooms } from '../public/art/mapdata.js';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
  else { args[a.slice(2)] = next; i++; }
}
const base = args.url ?? 'http://localhost:3000';
const get = async (p) => (await fetch(base + p)).json();
let data;
if (args.state) data = JSON.parse(fs.readFileSync(args.state, 'utf8'));
else {
  const [world, looks, maps, art] = await Promise.all([get('/api/world'), get('/api/looks'), get('/api/maps'), get('/api/art')]);
  data = { world, looks, maps: maps.maps, art };
}
if (args.local) {
  // maps and art from content/ on disk (to see edits before the server restarts); world state still from the server
  const { loadMapFiles, artContent } = await import('../server/world/maps.js');
  data.maps = loadMapFiles(); data.art = artContent();
}
if (args.save) fs.writeFileSync(args.save, JSON.stringify(data));

const pal = makePalette(data.art.palette);
const { createQuality } = await import('../public/render/quality.js');
const scene = createScene({ pal, recipes: data.art.recipes, maps: data.maps, art: data.art, quality: createQuality(args.quality ?? 'high') });
const W = Number(args.w ?? 960); const H = Number(args.h ?? 640);
const zoom = Number(args.zoom ?? 1);
const clock = data.world.clock;
let now = clock.gameMinutes;
if (args.time) { const [h, m] = String(args.time).split(':').map(Number); now = Math.floor(now / 1440) * 1440 + h * 60 + (m || 0); }
const citizens = new Map(data.world.citizens.map((c) => [c.id, { ...c, look: data.looks[c.id] ?? c.look }]));
const colors = ['#e0a43a', '#5fb3d9', '#e0607e', '#6cc28a', '#a98be6', '#3fc9b8', '#e58ad6', '#b5cf4a', '#6f8cf0', '#e8804a'];
const colorOf = (id) => hex(colors[[...citizens.keys()].indexOf(id) % colors.length]);
const S = {
  now, mapId: data.maps[0].id, rooms: new Map(data.world.rooms.map((r) => [r.id, r])), citizens,
  objects: new Map(data.world.objects.map((o) => [o.id, o])), objectsRev: 1, colorOf,
  selectedId: args.select ?? null, roofMode: args.roofs === 'on' ? 'on' : args.roofs === 'off' ? 'off' : 'auto',
  thoughts: args.thoughts ?? 'selected', uiScale: Number(args.ui ?? 1), trueView: true, rain: Boolean(args.rain),
  bubbles: new Map(), names: true, icons: true,
};
if (args.night) S.nightOverride = 1;
if (args.say) for (const c of citizens.values()) if (c.location === args.room) { S.bubbles.set(c.id, { text: String(args.say), born: 1e9 }); break; }
let cx = args.x ? Number(args.x) : 32 * 32; let cy = args.y ? Number(args.y) : 24 * 32;
if (args.room) {
  for (const m of data.maps) for (const r of mapRooms(m)) if (r.roomId === args.room) { cx = (r.rect.x + r.rect.w / 2) * TILE; cy = (r.rect.y + r.rect.h / 2) * TILE; }
}
const target = new ImgTarget(W, H);
const t0 = Date.now();
const ms = 1e9 + Number(args.ms ?? 0);
scene.draw(target, { x: cx, y: cy, zoom, w: W, h: H }, S, ms - 1000); // warm up roof fades and caches
for (let i = 1; i < 10; i++) scene.draw(target, { x: cx, y: cy, zoom, w: W, h: H }, S, ms - 1000 + i * 100);
target.img.fill([16, 20, 18, 255]);
const res = scene.draw(target, { x: cx, y: cy, zoom, w: W, h: H }, S, ms);
const out = args.out ?? 'shot.png';
writePng(path.resolve(out), target.img, { scale: Number(args.scale ?? 1) });
console.log(`${out}: ${W}x${H} zoom ${zoom} at ${Math.round(cx)},${Math.round(cy)} day ${clock.day} ${args.time ?? clock.time}; ${res.hits.length} hit areas; ${Date.now() - t0} ms`);
