// Step 8/9: the scene. One renderer for the living map, used by the browser view and by the Node screenshot tool.
// It reads a plain state object S (map files, rooms, citizens with their `look`, objects, lasting room effects, the clock,
// and step-9 extras: social, wear, decals, perception ...) and draws one frame through LAYERS (public/render/*): each layer
// is an object with optional methods called at fixed points of the frame with the frame context F:
//
//   update(F)        before anything is drawn (filters, wind, camera shake ...)
//   [ground and walls: cached 16x16 tile chunks]
//   ground(F)        flat things on the ground: wear, decals, ambient occlusion, cast shadows, flat clutter
//   [objects, people, decor are collected as y-sorted entities; the ANIMATOR decides each person's pose]
//   entities(F)      push more y-sorted entities into F.ents ({ y, draw() }): clutter, animals, wall fronts
//   [entities drawn back to front]
//   overEntities(F)  particles, smoke and fire, story lines and pins, outlines through walls
//   [roofs (they fade) and dots for people under closed roofs]
//   light(F)         day/night, light sources, windows
//   [overlays: names, tags, bubbles, icons, selection ring]
//   screen(F)        screen-space effects: rain, blast flash, subjective-camera vignette
//
// F (the frame context): { target, cam, z, X(wx), Y(wy), inView(wx, wy), view: { x0, y0, x1, y1 } (world px), S, ms, dt,
//   now (game minutes), dayMin, map, grid, layout, objs, tiles, pal, quality, lod (zoom <= 0.25),
//   ents: [], lights: [{ wx, wy, r, k, color? }], hits: [], entries: [] (overlay entries),
//   people: Map id -> Person { c, x, y, dir, moving, roomId, inBed, bed, dist, slow, lying, drawn: { img, sx, sy, scale } },
//   objectPos: Map id -> { o, x, y, sprite, wall, fixed, tiles, roomId },
//   decor: [{ type, tx, ty, wx, wy, sprite }], wind: { x, strength },
//   fade: Map id -> alpha multiplier, hide: Set ids, nameOf: (c) => label | null, muted: (c) => bool  (subjective camera)
//   emit(kind, wx, wy, opts) (particles), dropShadow(wx, wy, rx, ry, alpha) }
// Everything is drawn from code (tiles.js, objects.js, character.js); this file only decides what goes where.
import { TILE } from './mapdata.js';
import { Img, rngFor } from './pixels.js';
import { hash32 } from './rand.js';
import { makeTiles, WATER_FRAMES } from './tiles.js';
import { makeObjects } from './objects.js';
import { characterSprite, deriveLook } from './character.js';
import { createLayout } from './layout.js';
import { drawOverlays } from './overlays.js';
import { createLayers } from '../render/layers.js';
import { createAnimator } from '../render/animator.js';
import { quality as defaultQuality } from '../render/quality.js';
import { windAt, swayFor } from '../render/wind.js';

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

export function createScene({ pal, recipes = [], maps = [], art = null, quality = defaultQuality }) {
  const tiles = makeTiles(pal);
  const objs = makeObjects(pal, recipes);
  const layout = createLayout(maps);
  const mapById = new Map(maps.map((m) => [m.id, m]));
  const ctx = { pal, objs, tiles, layout, maps, quality, art: art ?? { recipes } };
  const layers = createLayers(ctx);
  const animator = createAnimator(ctx);
  const particleLayer = layers.find((l) => typeof l.emit === 'function');
  const shadowLayer = layers.find((l) => typeof l.dropShadow === 'function');
  const chunkCache = new Map();
  const roofCache = new Map();
  const roofAlpha = new Map();
  const movers = new Map();   // citizen id -> drawn position walking toward the simulation target
  const trips = new Map();    // citizen id -> { key, t }: trip progress never runs backwards
  const cropCache = new WeakMap();
  const cropped = (img, x, y, w, h) => { let m = cropCache.get(img); if (!m) { m = new Map(); cropCache.set(img, m); } const kk = `${x}|${y}|${w}|${h}`; let c = m.get(kk); if (!c) { c = img.crop(x, y, w, h); m.set(kk, c); } return c; };
  const placeCache = { rev: -1, byRoom: new Map() };
  let lastMs = 0;

  const call = (method, F) => { for (const l of layers) if (typeof l[method] === 'function') { try { l[method](F); } catch (err) { if (!l.__warned) { l.__warned = true; console.error(`[scene] layer ${l.id ?? '?'}.${method} failed`, err); } } } };

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
  function objectSprite(o) {
    return objs.sprite(o.typeId, { states: [o.state], tags: o.tags ?? [], color: o.data?.color });
  }
  // a door in a side wall is seen edge-on: the same sprite squeezed to a narrow slab, darker on its far edge
  const sideCache = new WeakMap();
  function sideOn(sp) {
    let s2 = sideCache.get(sp);
    if (s2) return s2;
    const w = Math.max(6, Math.round(sp.w * 0.28));
    const img = new Img(w, sp.h);
    for (let y = 0; y < sp.h; y++) for (let x = 0; x < w; x++) { const c = sp.img.get(Math.min(sp.w - 1, Math.floor(((x + 0.5) * sp.w) / w)), y); if (c && c[3]) img.set(x, y, x === w - 1 ? [Math.round(c[0] * 0.65), Math.round(c[1] * 0.65), Math.round(c[2] * 0.65), 255] : c); }
    s2 = { ...sp, img, w, ax: Math.round(w / 2), flames: [], glows: [] };
    sideCache.set(sp, s2);
    return s2;
  }
  const spriteSize = (o) => { const s = objectSprite(o); return s ? { w: s.w, h: s.h } : null; };

  function spec(c) {
    const look = c.look ?? null;
    if (look) return look;
    const l = deriveLook(c);
    return { id: c.id, build: l.build, look: { skin: l.skin, hair: l.hair, facial: l.facial, eyes: l.eyes }, garments: [], wounds: [], missing: [], aids: [], dead: c.alive === false };
  }

  const legBroken = (c) => (c.look?.wounds ?? []).some((w) => w.kind === 'fracture' && !w.splinted && /^(thigh|shin|foot)_/.test(w.part)) || (c.look?.missing ?? []).some((p) => /^(thigh|shin|foot)_/.test(p) && !(c.look?.aids ?? []).some((a) => a === 'peg_leg' || a === 'crutch'));

  // ---------- the frame ----------
  /**
   * cam: { x, y (world px at the screen centre), zoom, w, h }. S: the world state (see header). ms: real milliseconds.
   * Returns { hits: [{ type: 'citizen'|'object'|'room', id, x, y, w, h }], entries, camera, people } for picking and UI.
   */
  function draw(target, cam0, S, ms) {
    const dt = clamp((ms - lastMs) / 1000 || 0.016, 0, 0.1); lastMs = ms; // never negative (a fade must not run backwards)
    const map = mapById.get(S.mapId) ?? maps[0];
    if (!map) return { hits: [], entries: [], camera: cam0, people: new Map() };
    const grid = layout.grids.get(map.id);
    // camera shake from any layer (blasts)
    let sx0 = 0; let sy0 = 0;
    for (const l of layers) if (typeof l.shake === 'function') { const s = l.shake(ms); if (s) { sx0 += s.dx; sy0 += s.dy; } }
    const cam = { ...cam0, x: cam0.x + sx0 / cam0.zoom, y: cam0.y + sy0 / cam0.zoom };
    const z = cam.zoom;
    const X = (wx) => (wx - cam.x) * z + cam.w / 2;
    const Y = (wy) => (wy - cam.y) * z + cam.h / 2;
    const view = { x0: cam.x - cam.w / 2 / z - 64, y0: cam.y - cam.h / 2 / z - 96, x1: cam.x + cam.w / 2 / z + 64, y1: cam.y + cam.h / 2 / z + 64 };
    const inView = (wx, wy) => wx >= view.x0 && wx <= view.x1 && wy >= view.y0 && wy <= view.y1;
    const now = S.now;
    const F = {
      target, cam, z, X, Y, inView, view, S, ms, dt, now, dayMin: ((now % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY,
      map, grid, layout, objs, tiles, pal, quality, lod: z <= 0.25,
      ents: [], lights: [], hits: [], entries: [], people: new Map(), objectPos: new Map(), decor: [],
      wind: windAt(map.id, ms, now), fade: new Map(), hide: new Set(), nameOf: null, muted: null,
      emit: particleLayer ? (kind, wx, wy, opts) => particleLayer.emit(kind, wx, wy, opts) : () => {},
      dropShadow: shadowLayer ? (wx, wy, rx, ry, alpha) => shadowLayer.dropShadow(F, wx, wy, rx, ry, alpha) : (wx, wy, rx, ry, alpha = 0.25) => target.ellipse(X(wx), Y(wy), rx * z, ry * z, [10, 10, 14, 255], alpha),
    };
    const { hits, entries, ents, lights, lod } = F;
    const frame = Math.floor(ms / 450);
    target.begin();
    target.rect(0, 0, cam.w, cam.h, [16, 20, 18, 255], 1);
    call('update', F);

    // 1. ground and walls
    const cw = CHUNK * TILE;
    for (let cy = Math.max(0, Math.floor(view.y0 / cw)); cy <= Math.min(Math.ceil(grid.H / CHUNK) - 1, Math.floor(view.y1 / cw)); cy++) {
      for (let cx = Math.max(0, Math.floor(view.x0 / cw)); cx <= Math.min(Math.ceil(grid.W / CHUNK) - 1, Math.floor(view.x1 / cw)); cx++) {
        target.blit(chunkImg(map, cx, cy, frame), Math.round(X(cx * cw)), Math.round(Y(cy * cw)), { scale: z });
      }
    }

    // object layout (cached by revision)
    if (placeCache.rev !== S.objectsRev || !placeCache.byRoom.size) {
      placeCache.rev = S.objectsRev; placeCache.byRoom.clear();
      const byRoom = new Map();
      for (const o of S.objects.values()) { if (!o.roomId) continue; (byRoom.get(o.roomId) ?? byRoom.set(o.roomId, []).get(o.roomId)).push(o); }
      for (const [roomId, list] of byRoom) placeCache.byRoom.set(roomId, { list, pos: layout.placeObjects(roomId, list, spriteSize) });
    }
    const showHidden = S.trueView !== false;
    for (const [roomId, { list, pos }] of placeCache.byRoom) {
      for (const o of list) {
        const p = pos.get(o.id);
        if (!p || o.typeId === 'corpse') continue;
        const sp0 = objectSprite(o);
        const sp = sp0 && p.wall === 'side' ? sideOn(sp0) : sp0; // a door in a side wall is seen edge-on
        if (sp) F.objectPos.set(o.id, { o, x: p.x, y: p.y, sprite: sp, wall: p.wall ?? false, fixed: Boolean(p.fixed), tiles: p.tiles ?? null, roomId });
      }
    }
    // decor (map decor list, trees and bushes in the structure layer)
    for (const d of map.decor ?? []) { const s = objs.sprite(d.type, {}); if (s) F.decor.push({ type: d.type, tx: d.tile[0], ty: d.tile[1], wx: d.tile[0] * TILE + TILE / 2, wy: (d.tile[1] + 1) * TILE - 3, sprite: s, flat: Boolean(objs.byType.get(d.type)?.flat) }); }
    for (let ty = 0; ty < grid.H; ty++) {
      for (let tx = 0; tx < grid.W; tx++) {
        const st = grid.structure[ty][tx];
        if (st !== 'tree' && st !== 'bush') continue;
        const s = objs.sprite(st, {});
        if (s) F.decor.push({ type: st, tx, ty, wx: tx * TILE + TILE / 2, wy: (ty + 1) * TILE - 3, sprite: s, flat: false });
      }
    }

    // 2. flat things on the ground
    call('ground', F);

    // 3. entities sorted by feet: decor, objects, people
    if (!lod) {
      for (const d of F.decor) {
        if (!inView(d.wx, d.wy)) continue;
        ents.push({
          y: d.flat ? d.ty * TILE - 40 : d.wy + 1, draw: () => {
            const s = d.sprite; const x = X(d.wx - s.ax); const y = Y(d.wy - s.ay);
            const sw = Math.round(swayFor(d.type, d.tx, d.ty, ms, F.wind) || 0);
            if (!sw || s.h < 12) { target.blit(s.img, x, y, { scale: z }); return; }
            // the crown sways, the trunk stays
            const split = Math.round(s.h * 0.55);
            target.blit(cropped(s.img, 0, 0, s.w, split), x + sw * z, y, { scale: z });
            target.blit(cropped(s.img, 0, split, s.w, s.h - split), x, y + split * z, { scale: z });
          },
        });
      }
    }
    for (const [id, p] of F.objectPos) {
      const o = p.o; const sp = p.sprite;
      if (S.visibleObjectIds && !S.visibleObjectIds.has(id)) continue;
      if (F.hide.has(id)) continue;
      const concealed = ['hidden', 'concealed'].includes(o.visibility) || ['under', 'behind'].includes(o.placement?.relation);
      if (concealed && !showHidden) continue;
      // light sources are collected even when slightly off screen; a fire someone is tending burns brighter
      const tended = sp.glows.length && [...S.citizens.values()].some((c) => c.activity?.detail?.targetId === id && c.location === p.roomId);
      for (const g of sp.glows) lights.push({ wx: p.x - sp.ax + g.x, wy: p.y - sp.ay + g.y, r: g.radius * (tended ? 1.35 : 1), k: tended ? 1 : 0.9, objectId: id, roomId: p.roomId });
      if (!inView(p.x, p.y)) continue;
      const alpha = (concealed ? 0.55 : 1) * (F.fade.get(id) ?? 1);
      ents.push({
        y: p.y, id, draw: () => {
          // step 9: a door swings open while someone walks through it
          let img = sp.img;
          if (o.typeId === 'door' && o.state !== 'open' && o.state !== 'broken' && p.wall) {
            for (const q of F.people.values()) if (q.moving && Math.abs(q.x - p.x) < TILE * 1.1 && Math.abs(q.y - p.y) < TILE * 1.2) { const op = objs.sprite('door', { states: ['open'] }); if (op) img = (p.wall === 'side' ? sideOn(op) : op).img; break; }
          }
          const x = X(p.x - sp.ax); const y = Y(p.y - sp.ay);
          if (!lod && !p.wall) F.dropShadow(p.x, p.y - 1, sp.w / 2 - 2, 3, 0.22);
          target.blit(img, x, y, { scale: z, alpha });
          for (const f of sp.flames) target.blit(objs.flame(f.w, f.h, Math.floor(ms / 110) + (hash32(o.id) & 3)), x + f.x * z, y + f.y * z, { scale: z, alpha });
          hits.push({ type: 'object', id, x, y, w: sp.w * z, h: sp.h * z });
        },
      });
    }

    // people: the simulation gives a target, a mover walks the drawn person there tile by tile
    const taken = new Set();
    const order = [...S.citizens.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    // beds: a sleeper lies IN a bed of their room (their own first, then the one at their spot, then any free one)
    const bedsByRoom = new Map();
    for (const p of F.objectPos.values()) if (p.o.typeId === 'bed') (bedsByRoom.get(p.roomId) ?? bedsByRoom.set(p.roomId, []).get(p.roomId)).push({ o: p.o, p });
    const bedOf = new Map(); const bedTaken = new Set();
    for (const c of order) {
      if (c.alive === false || c.activity?.type !== 'sleeping') continue;
      const beds = (bedsByRoom.get(c.location) ?? []).filter((b) => !bedTaken.has(b.o.id));
      const bed = beds.find((b) => b.o.ownerId === c.id) ?? beds.find((b) => b.p.spot === c.spot) ?? beds[0];
      if (bed) { bedOf.set(c.id, bed); bedTaken.add(bed.o.id); }
    }
    const dtReal = Math.min(0.25, dt);
    for (const c of order) {
      // a trip only ever moves forward, even when the client clock is corrected backwards
      const a = c.activity ?? {};
      const tripKey = a.type === 'moving' || a.detail?.kind === 'walk' ? `${a.since}|${a.detail?.to ?? a.detail?.toSpot}` : null;
      let tnow = now;
      if (tripKey) { const tr = trips.get(c.id); tnow = tr?.key === tripKey ? Math.max(tr.t, now) : now; trips.set(c.id, { key: tripKey, t: tnow }); }
      let goal = layout.citizenPlace(c, tnow, movers.get(c.id)?.dir ?? 'down', taken);
      if (!goal) continue;
      const bed = bedOf.get(c.id);
      if (bed) goal = { ...goal, x: bed.p.x, y: bed.p.y, moving: false };
      const status = c.body?.status ?? [];
      const slow = status.some((s) => /crawling|can't move/.test(s)) ? 0.3 : status.includes('limping') || legBroken(c) ? 0.5 : 1;
      const mv = layout.stepMover(movers.get(c.id) ?? {}, goal, dtReal, slow * (animator.speedOf?.(c.id) ?? 1));
      movers.set(c.id, mv);
      const inBed = Boolean(bed) && !mv.moving && Math.hypot(mv.x - bed.p.x, mv.y - bed.p.y) < 2;
      const person = { c, x: mv.x, y: mv.y, dir: mv.dir ?? 'down', moving: mv.moving, roomId: goal.roomId, inBed, bed: bed ?? null, dist: mv.dist ?? 0, slow, legBroken: legBroken(c), drawn: null };
      F.people.set(c.id, person);
      c.__place = { x: mv.x, y: mv.y, dir: mv.dir, moving: mv.moving, roomId: goal.roomId };
    }
    animator.update(F); // poses, frames, facing, offsets, character mods, particles
    for (const person of F.people.values()) {
      const { c } = person;
      if (F.hide.has(c.id)) continue;
      const roof = roofAlpha.get(person.roomId) ?? 0;
      const an = animator.of(c.id) ?? { pose: 'idle', frame: 0, dir: person.dir, dx: 0, dy: 0, mods: null };
      ents.push({
        y: person.inBed ? person.bed.p.y + 0.5 : person.y + (an.sortDy ?? 0), id: c.id, draw: () => {
          if (!inView(person.x, person.y)) return;
          const color = S.colorOf?.(c.id) ?? [255, 255, 255, 255];
          if (lod) { target.rect(X(person.x) - 1, Y(person.y) - 2, 3, 3, color); return; }
          const sp = spec(c);
          const sprite = characterSprite(pal, sp);
          const alpha = (roof > 0.6 ? 0.35 : 1) * (F.fade.get(c.id) ?? 1);
          const entry = { c, color, selected: S.selectedId === c.id, hovered: S.hoverId === c.id, label: F.nameOf?.(c) ?? null };
          if (person.inBed) {
            // tucked in: the head on the pillow, the blanket pulled over the rest
            const bs = person.bed.p.sprite;
            const bx = person.bed.p.x - bs.ax; const by = person.bed.p.y - bs.ay;
            const f = sprite.frame('down', 'idle', 0, sp.expression ?? 'neutral', an.mods);
            target.blit(cropped(f.img, 0, 0, f.img.w, 20), X(person.bed.p.x - f.anchor[0]), Y(by + 5 + (an.dy ?? 0)), { scale: z, alpha });
            target.blit(cropped(bs.img, 2, 21, bs.w - 4, bs.h - 23), X(bx + 2), Y(by + 21), { scale: z, alpha });
            person.drawn = { img: f.img, sx: X(person.bed.p.x - f.anchor[0]), sy: Y(by + 5), scale: z, partial: true };
            entries.push({ ...entry, x: X(person.bed.p.x), y: Y(by + 24), head: Y(by + 4) });
            hits.push({ type: 'citizen', id: c.id, x: X(bx), y: Y(by), w: bs.w * z, h: bs.h * z });
            return;
          }
          const pose = an.pose ?? 'idle';
          const f = sprite.frame(an.dir ?? person.dir, pose, an.frame ?? 0, sp.expression ?? 'neutral', an.mods ?? null);
          const lying = pose === 'lie' || pose === 'crawl';
          const ox = person.x + (an.dx ?? 0) - f.anchor[0]; const oy = person.y + (an.dy ?? 0) - f.anchor[1] + (pose === 'lie' ? -2 : 0) + (pose === 'sit' ? 4 : 0);
          F.dropShadow(person.x, person.y - 1, lying ? 14 : 8, 3, 0.28);
          target.blit(f.img, X(ox), Y(oy), { scale: z, alpha });
          // step 9.5: the dead — a cloth laid over them, flies over a decaying body
          if (c.alive === false) {
            const corpse = S.objects?.get(`body_${c.id}`);
            if (corpse?.data?.covered) {
              const cw = f.img.w - 2; const ch = Math.max(6, Math.round(f.img.h * 0.55));
              target.rect(X(ox + 1), Y(oy + f.img.h - ch - 1), cw * z, ch * z, [196, 188, 168, 255], alpha);
              target.rect(X(ox + 1), Y(oy + f.img.h - ch - 1), cw * z, Math.max(1, z), [226, 220, 202, 255], alpha);
              target.rect(X(ox + 1), Y(oy + f.img.h - 2), cw * z, Math.max(1, z), [150, 142, 124, 255], alpha);
            }
            if (corpse && ['smelling', 'decaying'].includes(corpse.state) && (ms % 700) < 18) F.emit('fly', person.x, person.y - 6);
          }
          person.drawn = { img: f.img, sx: X(ox), sy: Y(oy), scale: z };
          entries.push({ ...entry, x: X(person.x), y: Y(person.y), head: lying ? Y(oy) - 2 : Y(oy) + 2 * z });
          hits.push({ type: 'citizen', id: c.id, x: X(ox), y: Y(oy), w: f.img.w * z, h: f.img.h * z });
        },
      });
    }
    call('entities', F);
    ents.sort((a, b) => a.y - b.y);
    for (const e of ents) e.draw();
    call('overEntities', F);

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
    F.roofAlpha = roofAlpha;
    for (const person of F.people.values()) {
      if (lod || (roofAlpha.get(person.roomId) ?? 0) <= 0.6 || F.hide.has(person.c.id)) continue;
      target.rect(X(person.x) - 2, Y(person.y) - 2, 5, 5, S.colorOf?.(person.c.id) ?? [255, 255, 255, 255]);
    }

    // 5. light, 6. overlays, 7. screen effects
    call('light', F);
    const S2 = F.nameOf || F.muted ? { ...S, nameOf: F.nameOf, muted: F.muted } : S;
    drawOverlays(target, entries, S2, ms, z);
    call('screen', F);
    return { hits, entries, camera: cam, people: F.people };
  }

  const effectKind = (text = '') => /rubble|collaps|blast|debris|explo/i.test(text) ? 'rubble' : /\bfire\b|burning|flames|ablaze/i.test(text) ? 'fire' : /smoke|smok/i.test(text) ? 'smoke' : null;

  return {
    draw, layout, tiles, objs, effectKind, nightFactor, mapById, layers, animator, ctx,
    /** A blast: white flash and camera shake (the view calls this for explosion events). */
    blast(ms) { for (const l of layers) l.blast?.(ms); },
    spriteSize,
    clear() { chunkCache.clear(); roofCache.clear(); placeCache.rev = -1; },
  };
}
