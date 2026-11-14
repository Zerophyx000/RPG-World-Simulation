// Step 9: light and shadow, drawn by code from the map and the clock.
//   dropShadow  a dithered dark ellipse under every person and object (plain ellipse on low quality)
//   ground      cast shadows that follow the sun (long in the morning and evening, short at noon, none at night; the
//               outdoors only), then ambient occlusion: darker floor along walls, in corners and around furniture,
//               precomputed per 16x16-tile chunk and recomputed when the furniture changes
//   light       the night: darkness with light sources punched out in 3-4 dithered bands, flickering fires and candles,
//               a warm tint near them, and lit windows (with light spilling onto the ground) in houses where a fire
//               burns or people are awake in the evening
// Visual only; quality toggles: castShadows, ao, flicker.
import { Img } from '../art/pixels.js';
import { TILE } from '../art/mapdata.js';
import { hash32, cellNoise } from '../art/rand.js';
import { nightFactor } from '../art/scene.js';

const CHUNK = 16;
const SHADOW = [12, 12, 22, 255];
const WARM = [255, 196, 110, 255];

/** The sun by minute of day: null at night, else { dx (-1 morning shadows point west .. +1 evening east), len }. */
export function sunAt(dayMin) {
  const h = dayMin / 60;
  if (h < 6 || h > 19) return null;
  const t = (h - 6) / 13;
  const dx = t * 2 - 1;
  return { dx, len: 0.3 + 2.2 * Math.pow(Math.abs(dx), 1.5) };
}

export function createLighting(ctx) {
  const { pal, quality } = ctx;
  const dropCache = new Map();
  const castCache = new WeakMap();
  const aoCache = new Map();

  // ---------- drop shadows ----------
  function dropImg(rx, ry) {
    const k = `${rx}|${ry}`;
    let img = dropCache.get(k);
    if (img) return img;
    img = new Img(rx * 2 + 1, ry * 2 + 1);
    for (let y = 0; y <= ry * 2; y++) {
      for (let x = 0; x <= rx * 2; x++) {
        const dx = (x - rx) / (rx + 0.5); const dy = (y - ry) / (ry + 0.5);
        const d = dx * dx + dy * dy;
        if (d > 1) continue;
        if (d > 0.55 && (x + y) % 2) continue; // dithered rim
        img.set(x, y, SHADOW);
      }
    }
    dropCache.set(k, img);
    return img;
  }

  // ---------- cast shadows ----------
  /** The ground shadow of a sprite for a sun bucket: its alpha mask flattened and sheared away from the sun. */
  function castImg(sprite, bucket, sun) {
    let m = castCache.get(sprite.img);
    if (!m) { m = new Map(); castCache.set(sprite.img, m); }
    let out = m.get(bucket);
    if (out) return out;
    const src = sprite.img; const h = sprite.ay; const w = src.w;
    const shear = sun.dx * sun.len * 0.6;          // ground x per pixel of height
    const lift = 0.35;                              // ground y (up, north) per pixel of height
    const ext = Math.ceil(Math.abs(shear) * h);
    const H = Math.ceil(h * lift) + 3;
    const img = new Img(w + ext + 2, H);
    const ox = shear < 0 ? ext + 1 : 1;
    for (let y = 0; y < Math.min(src.h, h + 1); y++) {
      const hgt = h - y;
      for (let x = 0; x < w; x++) {
        if (src.alphaAt(x, y) < 128) continue;
        const gx = Math.round(x + ox + shear * hgt); const gy = Math.round(H - 2 - hgt * lift);
        if ((gx + gy) % 3 === 0 && hgt > h * 0.7) continue; // the far end thins out
        img.set(gx, gy, SHADOW);
      }
    }
    out = { img, ox, oy: H - 2 };
    m.set(bucket, out);
    return out;
  }

  function castShadows(F, sun) {
    const { target, X, Y, z, inView, grid } = F;
    const bucket = Math.round(sun.dx * 12);
    const indoors = (wx, wy) => grid.roomAt[Math.floor(wy / TILE)]?.[Math.floor(wx / TILE)]?.kind === 'building';
    const draw = (sprite, wx, wy) => {
      if (!inView(wx, wy) || indoors(wx, wy - 2)) return;
      const c = castImg(sprite, bucket, sun);
      target.blit(c.img, X(wx - sprite.ax - c.ox), Y(wy - c.oy), { scale: z, alpha: 0.3 });
    };
    for (const d of F.decor) if (!d.flat && d.sprite.h > 14) draw(d.sprite, d.wx, d.wy);
    for (const p of F.objectPos.values()) if (!p.wall && p.sprite.h > 34) draw(p.sprite, p.x, p.y);
    // buildings: a band on the side away from the sun and one behind (north)
    const bh = 40;
    const ox = Math.round(sun.dx * sun.len * 0.6 * bh); const oy = -Math.round(bh * 0.35);
    for (const g of F.layout.rooms.values()) {
      if (g.room.kind !== 'building' || g.map.id !== F.map.id) continue;
      const r = g.room.rect; const x = r.x * TILE; const y = r.y * TILE; const w = r.w * TILE; const h = r.h * TILE;
      if (!inView(x + w / 2, y + h / 2) && !inView(x, y) && !inView(x + w, y + h)) continue;
      if (ox > 0) target.rect(X(x + w), Y(y + oy), ox * z, h * z, SHADOW, 0.26);
      if (ox < 0) target.rect(X(x + ox), Y(y + oy), -ox * z, h * z, SHADOW, 0.26);
      target.rect(X(x + Math.min(0, ox)), Y(y + oy), (w + Math.abs(ox)) * z, -oy * z, SHADOW, 0.26);
    }
  }

  // ---------- ambient occlusion ----------
  const WALLISH = new Set(['stone_wall', 'timber_wall', 'door']);
  function aoChunk(F, cx, cy, sig) {
    const key = `${F.map.id}|${cx}|${cy}|${sig}`;
    let img = aoCache.get(key);
    if (img !== undefined) return img;
    const { grid, layout } = F;
    img = new Img(CHUNK * TILE, CHUNK * TILE);
    let any = false;
    const dark = (px, py, a) => { const o = img.get(px, py); if (!o) return; if (!o[3] || o[3] < a) img.set(px, py, [8, 8, 16, a]); any = true; };
    const band = (tx0, ty0, side, depth, a) => {
      for (let i = 0; i < TILE; i++) for (let j = 0; j < depth; j++) {
        if ((i + j) % 2 && j >= depth - 2) continue; // dithered edge
        const alpha = Math.round(a * (1 - j / (depth + 1)));
        const [px, py] = side === 'N' ? [i, j] : side === 'S' ? [i, TILE - 1 - j] : side === 'W' ? [j, i] : [TILE - 1 - j, i];
        dark(tx0 + px, ty0 + py, alpha);
      }
    };
    const blocked = (rid, x, y) => layout.isBlocked(rid, x, y);
    for (let ty = cy * CHUNK; ty < Math.min(grid.H, (cy + 1) * CHUNK); ty++) {
      for (let tx = cx * CHUNK; tx < Math.min(grid.W, (cx + 1) * CHUNK); tx++) {
        const owner = grid.roomAt[ty][tx];
        if (owner?.kind !== 'building' || WALLISH.has(grid.structure[ty][tx])) continue;
        const ox = (tx - cx * CHUNK) * TILE; const oy = (ty - cy * CHUNK) * TILE;
        const wall = (x, y) => WALLISH.has(grid.structure[y]?.[x]);
        if (wall(tx, ty - 1)) band(ox, oy, 'N', 6, 110);
        if (wall(tx - 1, ty)) band(ox, oy, 'W', 4, 90);
        if (wall(tx + 1, ty)) band(ox, oy, 'E', 4, 90);
        if (wall(tx, ty + 1)) band(ox, oy, 'S', 3, 60);
        if (blocked(owner.id, tx, ty)) band(ox, oy, 'S', 5, 100);           // under and around furniture
        else {
          if (blocked(owner.id, tx, ty - 1)) band(ox, oy, 'N', 4, 70);
          if (blocked(owner.id, tx - 1, ty)) band(ox, oy, 'W', 3, 55);
          if (blocked(owner.id, tx + 1, ty)) band(ox, oy, 'E', 3, 55);
        }
      }
    }
    img = any ? img : null;
    if (aoCache.size > 400) aoCache.clear();
    aoCache.set(key, img);
    return img;
  }
  let sigCache = { ref: null, sig: '' };
  function blockSig(layout) {
    let n = 0; let h = 0;
    for (const [rid, set] of layout.blocked) { n += set.size; for (const k of set) h = (h * 31 + hash32(`${rid}${k}`)) >>> 0; }
    return `${n}:${h}`;
  }

  // ---------- light ----------
  function flicker(l, ms) {
    if (!quality?.get('flicker')) return l;
    const seed = hash32(String(l.objectId ?? `${Math.round(l.wx)}|${Math.round(l.wy)}`)) & 1023;
    const step = Math.floor(ms / 70);
    const n1 = cellNoise(step, seed, 1); const n2 = cellNoise(step, seed, 2);
    return { ...l, r: l.r * (1 + (n1 - 0.5) * 0.24), k: Math.min(1, l.k * (1 + (n2 - 0.5) * 0.3)) };
  }

  function windows(F, lights, night) {
    const out = [];
    if (night <= 0.3) return out;
    const h = F.dayMin / 60;
    const evening = h >= 18 && h < 23;
    for (const g of F.layout.rooms.values()) {
      const room = g.room;
      if (room.kind !== 'building' || g.map.id !== F.map.id) continue;
      let lit = lights.some((l) => l.roomId === room.roomId);
      if (!lit) for (const p of F.objectPos.values()) if (p.roomId === room.roomId && ['lit', 'hot', 'roaring'].includes(p.o.state)) { lit = true; break; }
      if (!lit && evening) for (const p of F.people.values()) if (p.roomId === room.roomId && p.c.activity?.type !== 'sleeping') { lit = true; break; }
      if (!lit) continue;
      const r = room.rect; const ty = r.y + r.h - 1;
      const doorXs = new Set((room.doors ?? []).filter((d) => d.tile[1] === ty).flatMap((d) => [d.tile[0] - 1, d.tile[0], d.tile[0] + 1]));
      const free = [];
      for (let tx = r.x + 1; tx <= r.x + r.w - 2; tx++) if (!doorXs.has(tx)) free.push(tx);
      if (!free.length) continue;
      const n = Math.min(3, Math.max(1, Math.floor(free.length / 3)));
      for (let i = 0; i < n; i++) {
        const tx = free[Math.floor(((i + 0.5) / n) * free.length)];
        out.push({ tx, ty, roomId: room.roomId });
      }
    }
    return out;
  }

  return {
    id: 'lighting',
    dropShadow(F, wx, wy, rx, ry, alpha = 0.25) {
      const { target, X, Y, z } = F;
      if (!quality?.get('ao') && !quality?.get('castShadows')) { target.ellipse(X(wx), Y(wy), rx * z, ry * z, SHADOW, alpha); return; }
      const ix = Math.max(2, Math.round(rx)); const iy = Math.max(1, Math.round(ry));
      target.blit(dropImg(ix, iy), X(wx - ix), Y(wy - iy), { scale: z, alpha: Math.min(1, alpha * 1.6) });
    },
    ground(F) {
      if (F.lod) return;
      const sun = sunAt(F.dayMin);
      const night = F.S.nightOverride ?? nightFactor(F.dayMin);
      if (quality?.get('castShadows') && sun && night <= 0.5) castShadows(F, sun);
      if (quality?.get('ao')) {
        if (sigCache.ref !== F.layout.blocked || !sigCache.sig || F.S.objectsRev !== sigCache.rev) sigCache = { ref: F.layout.blocked, sig: blockSig(F.layout), rev: F.S.objectsRev };
        const cw = CHUNK * TILE;
        for (let cy = Math.max(0, Math.floor(F.view.y0 / cw)); cy <= Math.min(Math.ceil(F.grid.H / CHUNK) - 1, Math.floor(F.view.y1 / cw)); cy++) {
          for (let cx = Math.max(0, Math.floor(F.view.x0 / cw)); cx <= Math.min(Math.ceil(F.grid.W / CHUNK) - 1, Math.floor(F.view.x1 / cw)); cx++) {
            const img = aoChunk(F, cx, cy, sigCache.sig);
            if (img) F.target.blit(img, Math.round(F.X(cx * cw)), Math.round(F.Y(cy * cw)), { scale: F.z });
          }
        }
      }
    },
    light(F) {
      const { target, X, Y, z, inView, ms } = F;
      const night = F.S.nightOverride ?? nightFactor(F.dayMin);
      const lights = F.lights.map((l) => flicker(l, ms));
      const wins = windows(F, F.lights, night);
      for (const w of wins) lights.push({ wx: w.tx * TILE + TILE / 2, wy: (w.ty + 1) * TILE + 10, r: 42, k: 0.75, roomId: w.roomId });
      const lit = lights.filter((l) => inView(l.wx, l.wy)).map((l) => ({ x: X(l.wx), y: Y(l.wy), r: l.r * z * 1.3, k: l.k }));
      if (night > 0.01) target.ambient([10, 14, 42, 255], night * 0.72, lit);
      // lit windows glow on top of the darkness
      for (const w of wins) {
        const wx = w.tx * TILE + 12; const wy = w.ty * TILE + 10;
        if (!inView(wx, wy)) continue;
        target.rect(X(wx - 1), Y(wy - 1), 10 * z, 8 * z, pal.color('wood', 0), 0.9 * night);
        target.rect(X(wx), Y(wy), 8 * z, 6 * z, pal.color('fire', 2), 0.95 * night);
        target.rect(X(wx + 3.5), Y(wy), 1 * z, 6 * z, pal.color('wood', 0), 0.9 * night);
      }
      // a warm tint near fires even by day indoors (subtle), stronger at night
      if (quality?.get('flicker')) for (const l of lit) target.warm?.(l.x, l.y, l.r * 0.75, WARM, 0.06 + night * 0.12);
    },
  };
}
