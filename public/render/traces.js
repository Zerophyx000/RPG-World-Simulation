// Step 9: traces a world keeps.
//   worn paths  S.wear (GET /api/wear): grass turns trampled, patchy, then into dirt where people really walk;
//               an overlay per 16x16-tile chunk, rebuilt only when that chunk's wear levels change
//   decals      S.decals (GET /api/decals): soot, scorch, rubble, puddles, blood, faded by the server by game time;
//               plus the step-8 bloodstains from room effects (unless a blood decal replaced them)
//   clutter     content/art/clutter.json per room type: pure decor on free floor tiles (never objects, never in a
//               prompt), placed by a seed per room; after a blast it lies scattered, broken and sooty
// Quality toggles: wear, decals, clutter.
import { Img, rngFor } from '../art/pixels.js';
import { hash32, cellNoise } from '../art/rand.js';
import { TILE } from '../art/mapdata.js';
import { effectKind } from './effects.js';

const CHUNK = 16;

export function createTraces(ctx) {
  const { pal, objs, layout, quality } = ctx;
  const stainCache = new Map();
  const wearCache = new Map();
  const decalCache = new Map();
  const clutterCache = new Map(); // roomId -> { sig, items }
  const sootCache = new WeakMap();

  // ---------- worn paths ----------
  function wearChunk(map, wm, grid, cx, cy) {
    let sig = 0; let any = false;
    for (let ty = cy * CHUNK; ty < Math.min(grid.H, (cy + 1) * CHUNK); ty++) {
      for (let tx = cx * CHUNK; tx < Math.min(grid.W, (cx + 1) * CHUNK); tx++) {
        const lv = level(wm.wear[ty * wm.w + tx] ?? 0);
        if (lv) any = true;
        sig = (sig * 5 + lv + 7) >>> 0;
      }
    }
    if (!any) return null;
    const key = `${map.id}|${cx}|${cy}`;
    const c = wearCache.get(key);
    if (c?.sig === sig) return c.img;
    const img = new Img(CHUNK * TILE, CHUNK * TILE);
    for (let ty = cy * CHUNK; ty < Math.min(grid.H, (cy + 1) * CHUNK); ty++) {
      for (let tx = cx * CHUNK; tx < Math.min(grid.W, (cx + 1) * CHUNK); tx++) {
        if (grid.ground[ty][tx] !== 'grass' || grid.structure[ty][tx]) continue;
        const lv = level(wm.wear[ty * wm.w + tx] ?? 0);
        if (!lv) continue;
        const ox = (tx - cx * CHUNK) * TILE; const oy = (ty - cy * CHUNK) * TILE;
        const nb = (x, y) => level(wm.wear[y * wm.w + x] ?? 0);
        for (let y = 0; y < TILE; y++) {
          for (let x = 0; x < TILE; x++) {
            // fade toward neighbours that are less worn, so paths have soft, ragged edges
            const ex = x < 6 ? nb(tx - 1, ty) : x > 25 ? nb(tx + 1, ty) : lv;
            const ey = y < 6 ? nb(tx, ty - 1) : y > 25 ? nb(tx, ty + 1) : lv;
            const here = Math.min(lv, Math.max(ex, ey, lv - 1));
            const n = cellNoise(tx * TILE + x, ty * TILE + y, 7);
            if (here === 1 && n < 0.35) img.set(ox + x, oy + y, pal.color('grass', 0));
            else if (here === 2) { if (n < 0.3) img.set(ox + x, oy + y, pal.color('dirt', 1)); else if (n < 0.55) img.set(ox + x, oy + y, pal.color('grass', 0)); }
            else if (here === 3) { if (n < 0.82) img.set(ox + x, oy + y, pal.color('dirt', n < 0.15 ? 0 : n > 0.7 ? 2 : 1)); }
          }
        }
      }
    }
    wearCache.set(key, { sig, img });
    return img;
  }
  const level = (v) => (v > 180 ? 3 : v > 110 ? 2 : v > 40 ? 1 : 0);

  // ---------- decals ----------
  function stainImg(seed) {
    let img = stainCache.get(seed);
    if (img) return img;
    const rng = rngFor(`stain${seed}`);
    img = new Img(26, 14);
    const base = pal.color('blood', 0);
    for (let i = 0; i < 7; i++) img.ellipse(3 + ((rng() * 12) | 0), 2 + ((rng() * 6) | 0), 5 + ((rng() * 6) | 0), 3 + ((rng() * 4) | 0), base);
    for (let i = 0; i < 6; i++) img.set((rng() * 26) | 0, (rng() * 14) | 0, pal.color('blood', 1));
    stainCache.set(seed, img);
    return img;
  }
  function decalImg(d) {
    const r = Math.max(3, Math.round(d.r));
    const key = `${d.kind}|${r}|${hash32(d.id) % 4}`;
    let img = decalCache.get(key);
    if (img) return img;
    const rng = rngFor(key);
    const s = r * 2 + 2;
    img = new Img(s, s);
    const blob = (color, scale, dither) => {
      for (let i = 0; i < 6; i++) {
        const cx = r + (rng() - 0.5) * r * 0.8; const cy = r + (rng() - 0.5) * r * 0.5;
        const rx = r * scale * (0.5 + rng() * 0.5); const ry = rx * 0.6;
        for (let y = Math.floor(cy - ry); y <= cy + ry; y++) for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
          const q = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
          if (q > 1 || (dither && q > 0.6 && (x + y) % 2)) continue;
          img.set(x, y, color);
        }
      }
    };
    if (d.kind === 'soot') blob(pal.color('black', 0), 0.8, true);
    else if (d.kind === 'scorch') { blob(pal.color('black', 0), 0.9, true); blob(pal.color('black', 1), 0.45, false); }
    else if (d.kind === 'rubble') {
      for (let i = 0; i < 5; i++) { const x = rng() * r * 1.6 + r * 0.2; const y = rng() * r + r * 0.4; img.ellipse(x, y, 2 + rng() * 3, 2 + rng() * 2, pal.color('stone', i % 3)); }
    } else if (d.kind === 'puddle') {
      img.ellipse(1, r * 0.5, s - 2, r, pal.color('water', 0));
      img.ellipse(3, r * 0.5 + 1, s - 6, r - 2, pal.color('water', 1));
      img.rect(r - 2, r * 0.5 + 2, 3, 1, pal.color('water', 2));
    } else if (d.kind === 'blood') { const st = stainImg(hash32(d.id) % 6); img = st; }
    decalCache.set(key, img);
    return img;
  }

  // ---------- clutter ----------
  function roomType(roomId) {
    const m = ctx.art?.clutter?.match ?? {};
    for (const [type, prefixes] of Object.entries(m)) if (prefixes.some((p) => roomId.startsWith(p))) return type;
    return null;
  }
  function placeClutter(F, roomId) {
    const g = layout.geom(roomId);
    if (!g || g.room.kind !== 'building') return [];
    const type = roomType(roomId);
    const items = ctx.art?.clutter?.rooms?.[type];
    if (!items) return [];
    let sig = '';
    for (const [rid, set] of layout.blocked) if (rid === roomId) sig += [...set].sort().join(';');
    const objSig = [...F.objectPos.values()].filter((p) => p.roomId === roomId).map((p) => `${p.o.id}:${Math.round(p.x)},${Math.round(p.y)}`).join('|');
    sig += `#${objSig}`;
    const cached = clutterCache.get(roomId);
    if (cached?.sig === sig) return cached.items;
    const r = g.room.rect;
    const taken = new Set();
    for (const s of g.room.spots ?? []) for (const [x, y] of s.tiles) taken.add(`${x},${y}`);
    for (const d of g.room.doors ?? []) for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) taken.add(`${d.tile[0] + dx},${d.tile[1] + dy}`);
    for (const p of F.objectPos.values()) {
      if (p.roomId !== roomId) continue;
      for (const [x, y] of p.tiles ?? [[Math.floor(p.x / TILE), Math.floor((p.y - 2) / TILE)]]) taken.add(`${x},${y}`);
      if (p.wall) taken.add(`${Math.floor(p.x / TILE)},${r.y + 1}`);
    }
    const free = [];
    for (let y = r.y + 1; y < r.y + r.h - 1; y++) for (let x = r.x + 1; x < r.x + r.w - 1; x++) {
      if (taken.has(`${x},${y}`) || layout.isBlocked(roomId, x, y) || !g.grid.walk[y]?.[x]) continue;
      free.push([x, y]);
    }
    const rng = rngFor(`clutter|${roomId}`);
    const out = [];
    for (const it of items) {
      for (let i = 0; i < (it.count ?? 1); i++) {
        if (!free.length) break;
        let pool = it.wall ? free.filter(([, y]) => y === r.y + 1) : free;
        if (!pool.length) pool = free;
        const t = pool[Math.floor(rng() * pool.length)];
        free.splice(free.indexOf(t), 1);
        out.push({ type: it.type, flat: Boolean(it.flat), x: t[0] * TILE + TILE / 2 + Math.round((rng() - 0.5) * 8), y: t[1] * TILE + TILE - 4, seed: Math.floor(rng() * 1e6), roomId });
      }
    }
    clutterCache.set(roomId, { sig, items: out });
    return out;
  }
  function blasted(F, roomId) {
    const room = F.S.rooms.get(roomId);
    if ((room?.effects ?? []).some((e) => effectKind(e.text) === 'rubble')) return true;
    return (F.S.decals ?? []).some((d) => d.roomId === roomId && ['soot', 'scorch', 'rubble'].includes(d.kind) && d.intensity > 0.2);
  }
  function sooty(sprite) {
    let s = sootCache.get(sprite.img);
    if (!s) { s = { ...sprite, img: sprite.img.clone().tint([30, 26, 24, 255], 0.35) }; sootCache.set(sprite.img, s); }
    return s;
  }
  function clutterItems(F) {
    const out = [];
    for (const g of layout.rooms.values()) {
      if (g.map.id !== F.map.id || g.room.kind !== 'building') continue;
      const r = g.room.rect;
      if ((r.x + r.w) * TILE < F.view.x0 || r.x * TILE > F.view.x1 || (r.y + r.h) * TILE < F.view.y0 || r.y * TILE > F.view.y1) continue;
      const wrecked = blasted(F, g.room.roomId);
      for (const it of placeClutter(F, g.room.roomId)) {
        let sp = objs.sprite(it.type, wrecked ? { states: ['broken'] } : {});
        if (!sp) continue;
        if (wrecked) sp = sooty(sp);
        const jx = wrecked ? ((it.seed % 21) - 10) : 0; const jy = wrecked ? (((it.seed >> 5) % 9) - 4) : 0;
        out.push({ ...it, x: it.x + jx, y: it.y + jy, sprite: sp });
      }
    }
    return out;
  }

  return {
    id: 'traces',
    clutterFor: (F, roomId) => placeClutter(F, roomId),
    ground(F) {
      const { target, X, Y, z, inView, layout: lay, now } = F;
      // worn paths
      if (quality?.get('wear') && F.S.wear && !F.lod) {
        const wm = F.S.wear.maps?.find((m) => m.mapId === F.map.id);
        if (wm && wm.w === F.grid.W && wm.h === F.grid.H) {
          const cw = CHUNK * TILE;
          for (let cy = Math.max(0, Math.floor(F.view.y0 / cw)); cy <= Math.min(Math.ceil(F.grid.H / CHUNK) - 1, Math.floor(F.view.y1 / cw)); cy++) {
            for (let cx = Math.max(0, Math.floor(F.view.x0 / cw)); cx <= Math.min(Math.ceil(F.grid.W / CHUNK) - 1, Math.floor(F.view.x1 / cw)); cx++) {
              const img = wearChunk(F.map, wm, F.grid, cx, cy);
              if (img) target.blit(img, Math.round(X(cx * cw)), Math.round(Y(cy * cw)), { scale: z });
            }
          }
        }
      }
      // decals
      const bloodSources = new Set();
      if (quality?.get('decals') !== false) {
        for (const d of F.S.decals ?? []) {
          if (d.mapId && d.mapId !== F.map.id) continue;
          if (d.kind === 'blood' && d.source) bloodSources.add(d.source);
          if (!inView(d.x, d.y)) continue;
          const img = decalImg(d);
          const a = d.kind === 'soot' || d.kind === 'scorch' ? d.intensity * 0.7 : d.kind === 'puddle' ? 0.55 + d.intensity * 0.35 : d.intensity * 0.9;
          if (d.kind === 'blood') target.blit(img, X(d.x - img.w / 2), Y(d.y - img.h / 2), { scale: z * Math.max(0.5, d.r / 10), alpha: a });
          else target.blit(img, X(d.x - img.w / 2), Y(d.y - img.h / 2), { scale: z, alpha: a });
        }
      }
      // step-8 bloodstains (room effects), unless a blood decal took over
      for (const room of F.S.rooms.values()) {
        for (const ef of room.effects ?? []) {
          const v = ef.visual;
          if (v?.kind !== 'bloodstain' || bloodSources.has(ef.id)) continue;
          const p = lay.standPx(room.id, v.spot ?? null, `stain${ef.id}`);
          if (!p || !inView(p.x, p.y)) continue;
          const ageDays = Math.max(0, (now - (v.at ?? now)) / 1440);
          const a = Math.max(0.2, Math.min(0.9, 0.9 - ageDays * 0.28));
          target.blit(stainImg(hash32(ef.id) % 6), Math.round(X(p.x - 13)), Math.round(Y(p.y - 7)), { scale: z, alpha: a });
        }
      }
      // flat clutter (rugs, flour dust) lies under everything
      if (quality?.get('clutter') && !F.lod) {
        F.__clutter = clutterItems(F);
        for (const it of F.__clutter) if (it.flat && inView(it.x, it.y)) target.blit(it.sprite.img, X(it.x - it.sprite.ax), Y(it.y - it.sprite.ay), { scale: z });
      } else F.__clutter = [];
    },
    entities(F) {
      for (const it of F.__clutter ?? []) {
        if (it.flat || !F.inView(it.x, it.y)) continue;
        F.ents.push({
          y: it.y - 0.5, draw: () => {
            F.dropShadow(it.x, it.y - 1, it.sprite.w / 2 - 2, 2, 0.18);
            F.target.blit(it.sprite.img, F.X(it.x - it.sprite.ax), F.Y(it.y - it.sprite.ay), { scale: F.z });
          },
        });
      }
    },
  };
}
