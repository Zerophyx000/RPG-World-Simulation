// Step 8: the scene. One renderer for the living map, used by the browser view and by the Node screenshot tool.
// It reads a plain state object (map files, rooms, citizens with their `look`, objects, lasting room effects, the
// clock) and draws, back to front: ground and wall chunks (cached 16x16 tiles) -> ground decals (bloodstains) ->
// everything that stands up, sorted by its feet (decor, objects, people) -> roofs (they fade) -> smoke and fire ->
// day/night tint with light sources -> weather and blast flash -> overlays (names, bubbles, icons, selection ring).
// Everything is drawn from code (tiles.js, objects.js, character.js); this file only decides what goes where.
import { TILE, parseRect } from './mapdata.js';
import { Img, mix, rngFor } from './pixels.js';
import { hash32 } from './rand.js';
import { makeTiles, WATER_FRAMES } from './tiles.js';
import { makeObjects } from './objects.js';
import { characterSprite, deriveLook } from './character.js';
import { createLayout } from './layout.js';
import { drawOverlays } from './overlays.js';

const CHUNK = 16;
export const ZOOMS = [0.25, 0.5, 1, 2, 3, 4];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const MINUTES_PER_DAY = 1440;

/** Hours 0..24 → how dark it is (0 day .. 1 deep night). */
export function nightFactor(minuteOfDay) {
  const h = (minuteOfDay % MINUTES_PER_DAY) / 60;
  if (h >= 21 || h < 5) return 1;
  if (h >= 18) return (h - 18) / 3;
  if (h < 7) return 1 - (h - 5) / 2;
  return 0;
}

export function createScene({ pal, recipes = [], maps = [] }) {
  const tiles = makeTiles(pal);
  const objs = makeObjects(pal, recipes);
  const layout = createLayout(maps);
  const mapById = new Map(maps.map((m) => [m.id, m]));
  const chunkCache = new Map();
  const roofCache = new Map();
  const roofAlpha = new Map();
  const stainCache = new Map();
  const lastDir = new Map();
  const placeCache = { rev: -1, byRoom: new Map() };
  let lastMs = 0;
  const blasts = [];

  // ---------- ground ----------
  function chunkImg(map, cx, cy, frame) {
    const grid = layout.grids.get(map.id);
    const hasWater = chunkHasWater(grid, cx, cy);
    const f = hasWater ? frame % WATER_FRAMES : 0;
    const key = `${map.id}|${cx}|${cy}|${f}`;
    let img = chunkCache.get(key);
    if (!img) { img = tiles.chunk(grid, cx, cy, CHUNK, f); chunkCache.set(key, img); }
    return img;
  }
  const waterMemo = new Map();
  function chunkHasWater(grid, cx, cy) {
    const k = `${grid.map.id}|${cx}|${cy}`;
    if (waterMemo.has(k)) return waterMemo.get(k);
    let w = false;
    for (let y = cy * CHUNK; y < Math.min(grid.H, (cy + 1) * CHUNK) && !w; y++) for (let x = cx * CHUNK; x < Math.min(grid.W, (cx + 1) * CHUNK); x++) if (grid.ground[y][x] === 'water') { w = true; break; }
    waterMemo.set(k, w);
    return w;
  }

  // ---------- roofs ----------
  function roofImg(room) {
    const r = room.rect;
    const key = `${room.roomId}|${room.roof?.style}|${room.roof?.color}|${r.w}x${r.h}`;
    let img = roofCache.get(key);
    if (img) return img;
    const w = r.w * TILE + 8; const h = r.h * TILE + 8;
    img = new Img(w, h);
    const style = room.roof?.style ?? 'thatch'; const ramp = room.roof?.color ?? (style === 'slate' ? 'slate' : style === 'tile' ? 'red' : 'straw');
    const rng = rngFor(`roof${room.roomId}`);
    const c = (t) => pal.color(ramp, t);
    img.rect(0, 0, w, h, c(1));
    const row = style === 'thatch' ? 7 : 6;
    for (let y = 0, i = 0; y < h; y += row, i++) {
      img.rect(0, y + row - 2, w, 1, c(0));
      img.rect(0, y, w, 1, c(2));
      if (style !== 'thatch') for (let x = (i % 2) * 8; x < w; x += 16) img.rect(x, y, 1, row, c(0));
      else for (let k = 0; k < w / 5; k++) { const x = (rng() * w) | 0; img.set(x, y + ((rng() * row) | 0), c(rng() < 0.5 ? 0 : 2)); }
    }
    img.rect(0, (h / 2 - 2) | 0, w, 4, c(2)); img.rect(0, (h / 2 + 2) | 0, w, 2, c(0)); // ridge
    img.rect(0, h - 5, w, 5, c(0));                                                            // eave shadow
    img.outline(() => pal.outline(ramp));
    for (let x = 0; x < w; x++) { img.set(x, 0, pal.outline(ramp)); img.set(x, h - 1, pal.outline(ramp)); }
    roofCache.set(key, img);
    return img;
  }

  // ---------- small helpers ----------
  const sprites = new Map(); // object id|key -> { img, ax, ay, ... }
  function objectSprite(o) {
    const states = [o.state];
    const s = objs.sprite(o.typeId, { states, tags: o.tags ?? [], color: o.data?.color });
    return s;
  }
  const spriteSize = (o) => { const s = objectSprite(o); return s ? { w: s.w, h: s.h } : null; };

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

  function spec(c) {
    const look = c.look ?? null;
    if (look) return look;
    const l = deriveLook(c);
    return { id: c.id, build: l.build, look: { skin: l.skin, hair: l.hair, facial: l.facial, eyes: l.eyes }, garments: [], wounds: [], missing: [], aids: [], dead: c.alive === false };
  }

  function poseOf(c, place, S) {
    if (c.alive === false) return 'lie';
    const a = c.activity ?? {};
    const status = c.body?.status ?? [];
    if (a.type === 'sleeping' || a.type === 'collapsed' || status.includes('unconscious')) return 'lie';
    const moving = place?.moving;
    if (status.some((s) => /crawling|can't move/.test(s)) && (moving || a.type === 'moving')) return 'crawl';
    if (moving) return S.holding?.has(c.id) ? 'carry' : 'walk';
    if (a.type === 'doing') {
      const k = a.detail?.kind ?? '';
      if (/eat|drink|sit|rest/.test(k)) return 'sit';
      if (/work|bake|forge|hammer|repair|mend|clean|cook|treat|craft/.test(k + (a.detail?.description ?? ''))) return 'work';
    }
    return 'idle';
  }

  const roomOfPoint = (grid, tx, ty) => grid.roomAt[ty]?.[tx]?.id ?? null;

  // ---------- the frame ----------
  /**
   * cam: { x, y (world px at the screen centre), zoom, w, h }. S: the world state (see header). ms: real milliseconds.
   * Returns { hits: [{ type: 'citizen'|'object'|'room', id, x, y, w, h }] } for hover/click picking.
   */
  function draw(target, cam0, S, ms) {
    const dt = Math.min(0.1, (ms - lastMs) / 1000 || 0.016); lastMs = ms;
    const map = mapById.get(S.mapId) ?? maps[0];
    if (!map) return { hits: [] };
    const grid = layout.grids.get(map.id);
    // blast shake
    let sx0 = 0; let sy0 = 0;
    for (let i = blasts.length - 1; i >= 0; i--) {
      const age = ms - blasts[i].at;
      if (age > 700) { blasts.splice(i, 1); continue; }
      const k = (1 - age / 700) * 5; sx0 += Math.sin(age / 18) * k; sy0 += Math.cos(age / 23) * k;
    }
    const cam = { ...cam0, x: cam0.x + sx0 / cam0.zoom, y: cam0.y + sy0 / cam0.zoom };
    const z = cam.zoom;
    const X = (wx) => (wx - cam.x) * z + cam.w / 2;
    const Y = (wy) => (wy - cam.y) * z + cam.h / 2;
    const view = { x0: cam.x - cam.w / 2 / z - 64, y0: cam.y - cam.h / 2 / z - 96, x1: cam.x + cam.w / 2 / z + 64, y1: cam.y + cam.h / 2 / z + 64 };
    const inView = (wx, wy) => wx >= view.x0 && wx <= view.x1 && wy >= view.y0 && wy <= view.y1;
    const now = S.now;
    const dayMin = now % MINUTES_PER_DAY;
    const frame = Math.floor(ms / 450);
    const hits = [];
    target.begin();
    target.rect(0, 0, cam.w, cam.h, [16, 20, 18, 255], 1);

    // 1. ground and walls
    const cw = CHUNK * TILE;
    for (let cy = Math.max(0, Math.floor(view.y0 / cw)); cy <= Math.min(Math.ceil(grid.H / CHUNK) - 1, Math.floor(view.y1 / cw)); cy++) {
      for (let cx = Math.max(0, Math.floor(view.x0 / cw)); cx <= Math.min(Math.ceil(grid.W / CHUNK) - 1, Math.floor(view.x1 / cw)); cx++) {
        target.blit(chunkImg(map, cx, cy, frame), Math.round(X(cx * cw)), Math.round(Y(cy * cw)), { scale: z });
      }
    }

    // 2. what is where
    const lod = z <= 0.25;
    const roomsMap = S.rooms;
    // object layout (cached by revision)
    if (placeCache.rev !== S.objectsRev || !placeCache.byRoom.size) {
      placeCache.rev = S.objectsRev; placeCache.byRoom.clear();
      const byRoom = new Map();
      for (const o of S.objects.values()) { if (!o.roomId) continue; (byRoom.get(o.roomId) ?? byRoom.set(o.roomId, []).get(o.roomId)).push(o); }
      for (const [roomId, list] of byRoom) placeCache.byRoom.set(roomId, { list, pos: layout.placeObjects(roomId, list, spriteSize) });
    }
    // ground decals: bloodstains from lasting room effects
    for (const room of roomsMap.values()) {
      for (const ef of room.effects ?? []) {
        const v = ef.visual;
        if (v?.kind !== 'bloodstain') continue;
        const p = layout.standPx(room.id, v.spot ?? null, `stain${ef.id}`);
        if (!p || !inView(p.x, p.y)) continue;
        const ageDays = Math.max(0, (now - (v.at ?? now)) / MINUTES_PER_DAY);
        const a = clamp(0.9 - ageDays * 0.28, 0.2, 0.9);
        const img = stainImg(hash32(ef.id) % 6);
        target.blit(img, Math.round(X(p.x - 13)), Math.round(Y(p.y - 7)), { scale: z, alpha: a });
      }
    }

    // 3. entities sorted by feet
    const ents = [];
    const lights = [];
    const flameJobs = [];
    const smoke = [];
    const decorOf = (type, tx, ty, key) => ({ y: (ty + 1) * TILE - 2, draw: () => { const s = objs.sprite(type, {}); if (!s) return; const wx = tx * TILE + TILE / 2; const wy = (ty + 1) * TILE - 3; if (!inView(wx, wy)) return; target.blit(s.img, X(wx - s.ax), Y(wy - s.ay), { scale: z }); } });
    if (!lod) {
      for (const d of map.decor ?? []) ents.push(decorOf(d.type, d.tile[0], d.tile[1]));
      for (let ty = 0; ty < grid.H; ty++) {
        const wy = (ty + 1) * TILE;
        if (wy < view.y0 || (ty * TILE) > view.y1) continue;
        for (let tx = 0; tx < grid.W; tx++) {
          const s = grid.structure[ty][tx];
          if (s === 'tree' || s === 'bush') { if (tx * TILE > view.x0 && tx * TILE < view.x1) ents.push(decorOf(s, tx, ty)); }
        }
      }
    }
    // objects
    const showHidden = S.trueView !== false;
    for (const [roomId, { list, pos }] of placeCache.byRoom) {
      const room = roomsMap.get(roomId);
      for (const o of list) {
        const p = pos.get(o.id);
        if (!p || o.typeId === 'corpse') continue;
        if (S.visibleObjectIds && !S.visibleObjectIds.has(o.id)) continue;
        const concealed = ['hidden', 'concealed'].includes(o.visibility) || ['under', 'behind'].includes(o.placement?.relation);
        if (concealed && !showHidden) continue;
        const sp = objectSprite(o);
        if (!sp) continue;
        // light sources are collected even when slightly off screen
        for (const g of sp.glows) lights.push({ wx: p.x - sp.ax + g.x, wy: p.y - sp.ay + g.y, r: g.radius, k: 0.9 });
        if (!inView(p.x, p.y)) continue;
        const state = o.state;
        if (['lit', 'hot', 'roaring', 'smouldering'].includes(state) && room) {
          const g = layout.geom(roomId);
          if (g?.room.kind === 'building') smoke.push({ x: (g.room.rect.x + g.room.rect.w * 0.72) * TILE, y: g.room.rect.y * TILE + 6, strong: state === 'roaring' || state === 'lit' || state === 'hot' });
        }
        ents.push({
          y: p.y, id: o.id, draw: () => {
            const x = X(p.x - sp.ax); const y = Y(p.y - sp.ay);
            if (!lod) target.ellipse(X(p.x), Y(p.y - 1), (sp.w / 2 - 2) * z, 3 * z, [10, 10, 14, 255], 0.22);
            target.blit(sp.img, x, y, { scale: z, alpha: concealed ? 0.55 : 1 });
            for (const f of sp.flames) target.blit(objs.flame(f.w, f.h, Math.floor(ms / 110) + (hash32(o.id) & 3)), x + f.x * z, y + f.y * z, { scale: z });
            hits.push({ type: 'object', id: o.id, x: x, y: y, w: sp.w * z, h: sp.h * z });
          },
        });
      }
    }
    // people
    const entries = [];
    const sleepersHidden = new Set();
    const taken = new Set();
    const order = [...S.citizens.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const c of order) {
      const place = layout.citizenPlace(c, now, lastDir.get(c.id) ?? 'down', taken);
      if (!place) continue;
      c.__place = place;
      if (place.moving) lastDir.set(c.id, place.dir);
      else if (S.partnerDir?.has(c.id)) { /* handled below */ }
      let dir = place.dir;
      if (!place.moving) {
        const partner = S.faceOf?.get(c.id);
        const pp = partner && S.citizens.get(partner)?.__place;
        if (pp && Math.abs(pp.x - place.x) > 6) dir = pp.x > place.x ? 'right' : 'left';
        else if (pp && pp.y < place.y - 8) dir = 'up';
        else dir = lastDir.get(c.id) && lastDir.get(c.id) !== 'up' ? lastDir.get(c.id) : 'down';
        lastDir.set(c.id, dir);
      }
      const roof = roofAlpha.get(place.roomId) ?? 0;
      ents.push({
        y: place.y + (c.alive === false || c.activity?.type === 'sleeping' ? -6 : 0), id: c.id, draw: () => {
          if (!inView(place.x, place.y)) return;
          if (lod) { target.rect(X(place.x) - 1, Y(place.y) - 2, 3, 3, S.colorOf?.(c.id) ?? [255, 255, 255, 255]); return; }
          const pose = poseOf(c, place, S);
          const sprite = characterSprite(pal, spec(c));
          const walkRate = place.moving ? 130 : 600;
          const idx = pose === 'walk' || pose === 'carry' ? Math.floor(ms / walkRate) + (hash32(c.id) & 3) : pose === 'crawl' || pose === 'work' || pose === 'idle' ? Math.floor(ms / (pose === 'idle' ? 700 : 280)) + (hash32(c.id) & 1) : 0;
          const f = sprite.frame(dir, pose, idx, spec(c).expression ?? 'neutral');
          const lying = pose === 'lie' || pose === 'crawl';
          const ox = place.x - f.anchor[0]; const oy = place.y - f.anchor[1] + (pose === 'lie' ? -2 : 0) + (pose === 'sit' ? 4 : 0);
          target.ellipse(X(place.x), Y(place.y - 1), (lying ? 14 : 8) * z, 3 * z, [10, 10, 14, 255], 0.28);
          const alpha = roof > 0.6 ? 0.35 : 1;
          target.blit(f.img, X(ox), Y(oy), { scale: z, alpha });
          const head = lying ? Y(oy) - 2 : Y(oy) + 2 * z;
          entries.push({ c, x: X(place.x), y: Y(place.y), head, color: S.colorOf?.(c.id) ?? [255, 255, 255, 255], selected: S.selectedId === c.id, hovered: S.hoverId === c.id });
          hits.push({ type: 'citizen', id: c.id, x: X(ox), y: Y(oy), w: f.img.w * z, h: f.img.h * z });
        },
      });
    }
    ents.sort((a, b) => a.y - b.y);
    for (const e of ents) e.draw();

    // 4. roofs (fade when you look inside) and a dot for people hidden under a closed roof
    const openRooms = S.openRooms ?? new Set();
    const selRoom = S.selectedId ? S.citizens.get(S.selectedId)?.location : null;
    for (const room of layout.rooms.values()) {
      if (room.room.kind !== 'building') continue;
      const id = room.room.roomId;
      const r = room.room.rect;
      const open = S.roofMode === 'off' || (S.roofMode !== 'on' && (z >= 1 || openRooms.has(id) || selRoom === id || S.hoverRoom === id));
      const want = open ? 0 : 1;
      const cur = roofAlpha.get(id) ?? want;
      const next = cur + clamp(want - cur, -dt * 4, dt * 4);
      roofAlpha.set(id, next);
      if (next <= 0.02) continue;
      const wx = r.x * TILE - 4; const wy = r.y * TILE - 4;
      if (!inView(wx + r.w * TILE / 2, wy + r.h * TILE / 2) && !inView(wx, wy)) continue;
      target.blit(roofImg(room.room), X(wx), Y(wy), { scale: z, alpha: next });
      hits.push({ type: 'room', id, x: X(wx), y: Y(wy), w: (r.w * TILE + 8) * z, h: (r.h * TILE + 8) * z, roof: true });
    }
    for (const c of S.citizens.values()) {
      const p = c.__place;
      if (!p || lod || (roofAlpha.get(p.roomId) ?? 0) <= 0.6) continue;
      target.rect(X(p.x) - 2, Y(p.y) - 2, 5, 5, S.colorOf?.(c.id) ?? [255, 255, 255, 255]);
    }

    // 5. smoke, fire
    for (const s of smoke) {
      if (!inView(s.x, s.y)) continue;
      for (let k = 0; k < 6; k++) {
        const ph = ((ms / 5200) * (s.strong ? 1 : 0.6) + k / 6) % 1;
        const px = s.x + Math.sin(ph * 5 + k * 1.7) * 7 + ph * 10; const py = s.y - ph * 64;
        target.ellipse(X(px), Y(py), (3 + ph * 7) * z, (2.5 + ph * 5) * z, pal.color('smoke', ph < 0.5 ? 1 : 2), (1 - ph) * 0.55);
      }
    }
    for (const room of roomsMap.values()) {
      for (const ef of room.effects ?? []) {
        const kind = ef.visual?.kind ?? effectKind(ef.text);
        if (!kind || kind === 'bloodstain') continue;
        const g = layout.geom(room.id);
        if (!g) continue;
        const r = g.room.rect;
        const n = 5;
        for (let i = 0; i < n; i++) {
          const h = hash32(`${ef.id}${i}`);
          const wx = (r.x + 1 + (h % Math.max(1, r.w - 2))) * TILE + 10; const wy = (r.y + 1 + ((h >>> 8) % Math.max(1, r.h - 2))) * TILE + 20;
          if (!inView(wx, wy)) continue;
          if (kind === 'rubble') {
            const s = objs.sprite('rock', {});
            if (s) target.blit(s.img, X(wx - s.ax), Y(wy - s.ay), { scale: z * (0.6 + (h % 5) / 10) });
          } else if (kind === 'fire') {
            const fr = objs.flame(18, 22, Math.floor(ms / 110) + i);
            target.blit(fr, X(wx - 9), Y(wy - 22), { scale: z });
            lights.push({ wx, wy: wy - 10, r: 44, k: 0.9 });
          } else if (kind === 'smoke') {
            const ph = ((ms / 6000) + i / n) % 1;
            target.ellipse(X(wx + Math.sin(ph * 6) * 6), Y(wy - ph * 70), (5 + ph * 9) * z, (4 + ph * 6) * z, pal.color('smoke', 1), (1 - ph) * 0.5);
          }
        }
      }
    }

    // 6. light
    const night = S.nightOverride ?? nightFactor(dayMin);
    const dusk = clamp(night, 0, 1);
    const lit = lights.filter((l) => inView(l.wx, l.wy)).map((l) => ({ x: X(l.wx), y: Y(l.wy), r: l.r * z * 1.3, k: l.k }));
    if (dusk > 0.01) target.ambient([18, 24, 60, 255], dusk * 0.55, lit);
    else if (lit.length) target.ambient([18, 24, 60, 255], 0.001, []);

    // 7. weather and blast flash
    if (S.rain) {
      const rr = rngFor('rain');
      for (let i = 0; i < Math.round(cam.w * cam.h / 6000); i++) {
        const bx = rr() * cam.w; const by = rr() * cam.h; const sp = 0.6 + rr() * 0.6;
        const yy = (by + ms * sp * 0.9) % cam.h; const xx = (bx - ms * 0.15 * sp + cam.w) % cam.w;
        target.rect(xx, yy, 1, 6, [170, 190, 230, 255], 0.55);
      }
    }
    for (const b of blasts) {
      const age = ms - b.at;
      if (age < 320) target.rect(0, 0, cam.w, cam.h, [255, 236, 190, 255], (1 - age / 320) * 0.75);
    }

    // 8. overlays
    drawOverlays(target, entries, S, ms, z);
    return { hits, entries, camera: cam };
  }

  const effectKind = (text = '') => /rubble|collaps|blast|debris|explo/i.test(text) ? 'rubble' : /\bfire\b|burning|flames|ablaze/i.test(text) ? 'fire' : /smoke|smok/i.test(text) ? 'smoke' : null;

  return {
    draw, layout, tiles, objs, effectKind, nightFactor, mapById,
    /** A blast at a world position: white flash and camera shake (the view calls this for explosion effects). */
    blast(ms) { blasts.push({ at: ms }); },
    spriteSize,
    clear() { chunkCache.clear(); roofCache.clear(); placeCache.rev = -1; },
  };
}
