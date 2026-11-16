// Step 9: ambient life, visual only. Birds that perch on roofs and paths and fly off when someone comes near, a cat or
// two wandering between spots and sleeping by a lit hearth, chickens pecking outside the homes, fireflies on nights
// near grass and water, dust motes floating in rooms by day. Seeded, tiny state machines in the client: never sent
// to the server, never perceived by citizens. Quality: 'ambient' (off on low), the count capped by budget('ambient').
import { Img, rngFor } from '../art/pixels.js';
import { TILE } from '../art/mapdata.js';
import { nightFactor } from '../art/scene.js';

const SPEED = { bird: 90, cat: 26, chicken: 18 };

export function createAmbient(ctx) {
  const { pal, layout, quality } = ctx;
  const sprites = new Map();
  let creatures = null;
  let mapId = null;
  const rng = rngFor('ambient');

  // ---------- sprites: tiny, outlined, two frames ----------
  function spr(key, rows, map) {
    let img = sprites.get(key);
    if (img) return img;
    img = new Img(rows[0].length + 2, rows.length + 2);
    rows.forEach((row, y) => [...row].forEach((ch, x) => { const c = map[ch]; if (c) img.set(x + 1, y + 1, pal.color(c[0], c[1])); }));
    img.outline((n) => [Math.round(n[0] * 0.4), Math.round(n[1] * 0.4), Math.round(n[2] * 0.4), 255]);
    sprites.set(key, img);
    return img;
  }
  const BIRD = { b: ['brown', 1], d: ['brown', 0], y: ['ochre', 2] };
  const CAT = { c: ['grey', 1], d: ['grey', 0], e: ['ochre', 2] };
  const HEN = { w: ['flour', 2], r: ['red', 1], y: ['ochre', 2], s: ['flour', 1] };
  const look = {
    bird0: () => spr('bird0', ['.bb.', 'bbby', 'dd..'], BIRD), bird1: () => spr('bird1', ['.bb.', 'bbby', '.dd.'], BIRD),
    fly0: () => spr('fly0', ['b...b', '.bbb.', '..y..'], BIRD), fly1: () => spr('fly1', ['.....', 'bbbbb', '..y..'], BIRD),
    cat0: () => spr('cat0', ['c.....c', 'cc...cc', '.ccccc.', '.c.c.c.'], CAT), cat1: () => spr('cat1', ['c.....c', 'cc...cc', '.ccccc.', 'c..c..c'], CAT),
    catSit: () => spr('catSit', ['c.c..', 'ccc..', '.cc..', '.ccc.', '.cccc'], CAT), catSleep: () => spr('catSleep', ['..ccc..', '.ccccc.', 'cccdccc'], CAT),
    hen0: () => spr('hen0', ['.r..', 'www.', 'wwwy', '.ss.'], HEN), hen1: () => spr('hen1', ['....', '.r..', 'wwwy', 'wss.'], HEN),
  };

  // ---------- the cast ----------
  function init(F) {
    mapId = F.map.id;
    creatures = [];
    const budget = quality?.budget('ambient') ?? 12;
    if (!budget) return;
    const grid = F.grid;
    const outdoorWalk = [];
    for (let y = 0; y < grid.H; y++) for (let x = 0; x < grid.W; x++) if (grid.walk[y][x] && !grid.roomAt[y][x] && grid.ground[y][x] !== 'water') outdoorWalk.push([x, y]);
    const roofs = [];
    for (const g of layout.rooms.values()) if (g.map.id === mapId && g.room.kind === 'building') { const r = g.room.rect; for (let x = r.x + 1; x < r.x + r.w - 1; x += 2) roofs.push([x, r.y]); }
    const pick = (list) => list[Math.floor(rng() * list.length)];
    const nBirds = Math.min(6, Math.max(3, Math.round(budget * 0.35)));
    for (let i = 0; i < nBirds && roofs.length + outdoorWalk.length; i++) {
      const onRoof = i % 2 === 0 && roofs.length;
      const t = onRoof ? pick(roofs) : pick(outdoorWalk);
      creatures.push({ kind: 'bird', x: t[0] * TILE + 8 + rng() * 16, y: t[1] * TILE + 12 + rng() * 8, state: 'perched', roof: Boolean(onRoof), t: rng() * 3, tx: 0, ty: 0, dir: 1 });
    }
    // chickens outside the homes' doors
    const homes = [...layout.rooms.values()].filter((g) => g.map.id === mapId && /^house_/.test(g.room.roomId));
    for (const g of homes.slice(0, 2)) {
      const door = g.room.doors?.[0]; if (!door) continue;
      for (let i = 0; i < 2; i++) {
        const near = outdoorWalk.filter(([x, y]) => Math.abs(x - door.tile[0]) + Math.abs(y - door.tile[1]) <= 4 && grid.ground[y][x] === 'grass');
        if (!near.length) continue;
        const t = pick(near);
        creatures.push({ kind: 'chicken', x: t[0] * TILE + 16, y: t[1] * TILE + 20, home: door.tile, state: 'peck', t: rng() * 2, dir: rng() < 0.5 ? -1 : 1 });
      }
    }
    // a cat or two
    for (let i = 0; i < (budget >= 12 ? 2 : 1); i++) { const t = pick(outdoorWalk); if (t) creatures.push({ kind: 'cat', x: t[0] * TILE + 16, y: t[1] * TILE + 24, state: 'sit', t: 2 + rng() * 4, path: [], dir: 1 }); }
    creatures.length = Math.min(creatures.length, budget);
  }

  const nearPerson = (F, x, y, r) => { for (const p of F.people.values()) if (Math.hypot(p.x - x, p.y - y) < r) return p; return null; };
  const tileOf = (x, y) => [Math.floor(x / TILE), Math.floor(y / TILE)];

  function step(F) {
    const dt = Math.min(0.1, F.dt);
    const grid = F.grid;
    const night = nightFactor(F.dayMin);
    for (const c of creatures) {
      c.t -= dt;
      if (c.kind === 'bird') {
        if (c.state !== 'flying' && nearPerson(F, c.x, c.y + 8, TILE * 2)) { c.state = 'flying'; const a = rng() * Math.PI * 2; c.tx = c.x + Math.cos(a) * 260; c.ty = c.y - 120 - rng() * 120; c.t = 3; }
        if (c.state === 'flying') {
          const dx = c.tx - c.x; const dy = c.ty - c.y; const d = Math.hypot(dx, dy) || 1;
          c.dir = dx < 0 ? -1 : 1;
          c.x += (dx / d) * SPEED.bird * dt; c.y += (dy / d) * SPEED.bird * dt;
          if (d < 6 || c.t < 0) {
            // land on a roof or an empty path tile
            const [tx, ty] = tileOf(c.x, c.y);
            const ok = grid.walk[ty]?.[tx] && !grid.roomAt[ty]?.[tx] && !nearPerson(F, c.x, c.y, TILE * 3);
            if (ok) { c.state = 'perched'; c.roof = false; c.t = 2 + rng() * 4; } else { c.tx = c.x + (rng() - 0.5) * 300; c.ty = c.y + (rng() - 0.5) * 200; c.t = 3; }
          }
        } else if (c.t < 0) { c.state = c.state === 'perched' ? 'hop' : 'perched'; c.t = 1 + rng() * 3; if (c.state === 'hop' && !c.roof) { c.x += (rng() - 0.5) * 10; c.dir = rng() < 0.5 ? -1 : 1; } }
      } else if (c.kind === 'chicken') {
        const p = nearPerson(F, c.x, c.y, TILE * 1.5);
        if (p) { c.dir = p.x > c.x ? -1 : 1; c.x += c.dir * SPEED.chicken * 2.5 * dt; c.state = 'walk'; }
        else if (c.t < 0) { c.state = c.state === 'peck' ? 'walk' : 'peck'; c.t = 1 + rng() * 3; c.dir = rng() < 0.5 ? -1 : 1; if (Math.hypot(c.x - c.home[0] * TILE, c.y - c.home[1] * TILE) > TILE * 4) c.dir = c.home[0] * TILE > c.x ? 1 : -1; }
        else if (c.state === 'walk') { const nx = c.x + c.dir * SPEED.chicken * dt; const [tx, ty] = tileOf(nx, c.y); if (grid.walk[ty]?.[tx] && !grid.roomAt[ty]?.[tx]) c.x = nx; else c.dir *= -1; }
      } else if (c.kind === 'cat') {
        if (c.path.length) {
          const [px, py] = c.path[0]; const dx = px - c.x; const dy = py - c.y; const d = Math.hypot(dx, dy);
          if (d < 1) c.path.shift(); else { const s = Math.min(d, SPEED.cat * dt); c.x += (dx / d) * s; c.y += (dy / d) * s; c.dir = dx < 0 ? -1 : dx > 0 ? 1 : c.dir; }
          c.state = 'walk';
          if (!c.path.length) { c.state = c.goal === 'hearth' ? 'sleep' : 'sit'; c.t = c.goal === 'hearth' ? 30 : 4 + rng() * 8; }
        } else if (c.t < 0 || (c.state !== 'walk' && nearPerson(F, c.x, c.y, TILE))) {
          // somewhere warm at night or when a fire burns, else a random spot
          let goal = null;
          const fires = [...F.objectPos.values()].filter((p) => p.o.typeId === 'hearth' && p.o.state === 'lit');
          if (fires.length && (night > 0.5 || rng() < 0.4)) { const f = fires[Math.floor(rng() * fires.length)]; goal = [Math.floor(f.x / TILE), Math.floor(f.y / TILE) + 1]; c.goal = 'hearth'; }
          else {
            const g = [...layout.rooms.values()].filter((x) => x.map.id === mapId)[Math.floor(rng() * layout.rooms.size)];
            const s = g?.room.spots?.[Math.floor(rng() * (g.room.spots.length || 1))];
            if (s) { goal = s.tiles[Math.floor(rng() * s.tiles.length)]; c.goal = 'spot'; }
          }
          const from = tileOf(c.x, c.y - 4);
          const path = goal ? layout.route(mapId, from, goal) : null;
          if (path && path.length < 80) c.path = path.slice(1).map(([x, y]) => [x * TILE + 16, y * TILE + 24]);
          else c.t = 3;
        }
      }
    }
  }

  return {
    id: 'ambient',
    creatures: () => (creatures ?? []).map((c) => ({ kind: c.kind, x: c.x, y: c.y, state: c.state })),
    entities(F) {
      if (!quality?.get('ambient') || F.lod) { if (!quality?.get('ambient')) creatures = null; return; }
      if (!creatures || mapId !== F.map.id) init(F);
      step(F);
      const blink = Math.floor(F.ms / 250) % 2;
      for (const c of creatures) {
        if (!F.inView(c.x, c.y) || (c.kind === 'bird' && (c.state === 'flying' || c.roof))) continue;
        let img;
        if (c.kind === 'bird') img = blink && c.state === 'hop' ? look.bird1() : look.bird0();
        else if (c.kind === 'chicken') img = c.state === 'peck' ? (blink ? look.hen1() : look.hen0()) : (Math.floor(F.ms / 160) % 2 ? look.hen1() : look.hen0());
        else img = c.state === 'walk' ? (Math.floor(F.ms / 200) % 2 ? look.cat1() : look.cat0()) : c.state === 'sleep' ? look.catSleep() : look.catSit();
        const flip = c.dir < 0;
        F.ents.push({ y: c.y, draw: () => { F.dropShadow(c.x, c.y, img.w / 2, 1.5, 0.2); F.target.blit(img, F.X(c.x - img.w / 2), F.Y(c.y - img.h), { scale: F.z, flipX: flip }); } });
      }
    },
    overEntities(F) {
      if (!quality?.get('ambient') || F.lod || !creatures) return;
      const flap = Math.floor(F.ms / 120) % 2;
      for (const c of creatures) {
        if (c.kind !== 'bird' || !(c.state === 'flying' || c.roof) || !F.inView(c.x, c.y)) continue;
        const img = c.state === 'flying' ? (flap ? look.fly1() : look.fly0()) : look.bird0();
        F.target.blit(img, F.X(c.x - img.w / 2), F.Y(c.y - img.h), { scale: F.z, flipX: c.dir < 0 });
      }
      // fireflies at night near grass and water; dust motes in rooms by day
      const night = nightFactor(F.dayMin);
      const n = Math.min(14, quality?.budget('ambient') ?? 12);
      if (night > 0.6) {
        for (let i = 0; i < n; i++) {
          const seed = rngFor(`ff${i}`); const bx = seed(); const by = seed();
          const x = F.view.x0 + bx * (F.view.x1 - F.view.x0) + Math.sin(F.ms / 900 + i) * 20; const y = F.view.y0 + by * (F.view.y1 - F.view.y0) + Math.cos(F.ms / 1100 + i * 2) * 14;
          const [tx, ty] = tileOf(x, y);
          if (F.grid.roomAt[ty]?.[tx] || !['grass', 'water'].includes(F.grid.ground[ty]?.[tx])) continue;
          if (Math.sin(F.ms / 300 + i * 1.7) < 0.3) continue;
          F.target.rect(F.X(x), F.Y(y), Math.max(1, F.z), Math.max(1, F.z), pal.color('gold', 2), 0.95);
        }
      } else if (F.dayMin >= 480 && F.dayMin <= 1020 && F.z >= 1) {
        for (const g of layout.rooms.values()) {
          if (g.map.id !== F.map.id || g.room.kind !== 'building') continue;
          const r = g.room.rect;
          if (!F.inView((r.x + r.w / 2) * TILE, (r.y + r.h / 2) * TILE)) continue;
          if ((F.roofAlpha?.get(g.room.roomId) ?? 0) > 0.5) continue;
          for (let i = 0; i < 6; i++) {
            const s = rngFor(`mote${g.room.roomId}${i}`); const bx = s(); const by = s();
            const x = (r.x + 1 + bx * (r.w - 2)) * TILE + Math.sin(F.ms / 2600 + i) * 12; const y = (r.y + 1 + by * (r.h - 2)) * TILE + Math.cos(F.ms / 3100 + i) * 10 - ((F.ms / 80 + i * 40) % 30);
            F.target.rect(F.X(x), F.Y(y), Math.max(1, F.z), Math.max(1, F.z), pal.color('flour', 2), 0.3);
          }
        }
      }
    },
  };
}
