// Step 8: object sprites. Every object type is drawn by a small RECIPE (content/art/objects/*.json): a list of shapes
// in palette ramps. Shapes shade themselves (edge toward the top-left = highlight, toward the bottom-right = shadow),
// the whole sprite gets a dark outline, and each object STATE adds or removes shapes on top of the base drawing
// (lit fire, torn sack, broken wheel). Types without a recipe fall back to a drawing by tag (garment, tool, weapon,
// valuable, supply, container ...); generic damage states (broken, smashed, wrecked) and "overturned" work for every type.
// Fire and glow are not painted into the sprite: the sprite lists them (`flames`, `glows`) so the scene can animate them.
// The same code runs in Node (gallery PNGs) and in the browser (the result is an Img, cached as a canvas by the renderer).
import { Img, mix, rngFor } from './pixels.js';

const PAD = 1; // room for the outline around the drawing box

export function makeObjects(pal, recipes = []) {
  const byType = new Map();
  for (const r of recipes) byType.set(r.type, r);
  const cache = new Map();

  const tone = (ramp, t) => pal.color(ramp, t);
  const dim = (c, f) => [Math.round(c[0] * f), Math.round(c[1] * f), Math.round(c[2] * f), c[3] ?? 255];

  /** Paint a shape (given as a mask Img of its own pixels) onto the canvas with edge shading. */
  function paintMask(canvas, mask, ramp, flatTone, shade) {
    for (let y = 0; y < mask.h; y++) {
      for (let x = 0; x < mask.w; x++) {
        if (!mask.alphaAt(x, y)) continue;
        let t = flatTone ?? 1;
        if (flatTone == null && shade) {
          if (!mask.alphaAt(x - 1, y) || !mask.alphaAt(x, y - 1)) t = 2;
          else if (!mask.alphaAt(x + 1, y) || !mask.alphaAt(x, y + 1)) t = 0;
        }
        canvas.set(x, y, tone(ramp, t));
      }
    }
  }

  function applyOps(ctx, ops, color) {
    const { canvas, w, h } = ctx;
    const fix = (ramp) => (ramp === '$color' ? color : ramp);
    for (const op of ops ?? []) {
      switch (op.op) {
        case 'rect': case 'ellipse': case 'poly': {
          const mask = new Img(w, h); const m = [255, 255, 255, 255];
          if (op.op === 'rect') mask.rect(op.x + PAD, op.y + PAD, op.w, op.h, m);
          else if (op.op === 'ellipse') mask.ellipse(op.x + PAD, op.y + PAD, op.w, op.h, m);
          else mask.poly(op.points.map(([x, y]) => [x + PAD, y + PAD]), m);
          paintMask(canvas, mask, fix(op.ramp), op.tone ?? null, op.shade === 'auto' || (op.tone == null && op.shade !== null));
          break;
        }
        case 'line':
          canvas.line(op.x0 + PAD, op.y0 + PAD, op.x1 + PAD, op.y1 + PAD, tone(fix(op.ramp), op.tone ?? 1));
          break;
        case 'pixels': {
          op.rows.forEach((row, j) => [...row].forEach((ch, i) => {
            const m = op.map[ch]; if (m) canvas.set(op.x + i + PAD, op.y + j + PAD, tone(fix(m[0]), m[1]));
          }));
          break;
        }
        case 'clear':
          for (let j = 0; j < op.h; j++) for (let i = 0; i < op.w; i++) canvas.data[((op.y + j + PAD) * w + (op.x + i + PAD)) * 4 + 3] = 0;
          break;
        case 'holes': {
          const rng = rngFor(`holes${op.seed}`);
          const vis = [];
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (canvas.alphaAt(x, y)) vis.push([x, y]);
          for (let i = 0; i < op.count && vis.length; i++) {
            const [x, y] = vis[(rng() * vis.length) | 0];
            const wide = rng() < 0.5 ? 2 : 1;
            for (let dx = 0; dx < wide; dx++) if (x + dx < w) canvas.data[(y * w + x + dx) * 4 + 3] = 0;
          }
          break;
        }
        case 'tint':
          canvas.tint(op.color, op.amount ?? 0.3);
          break;
        case 'flame': ctx.flames.push({ x: op.x + PAD, y: op.y + PAD, w: op.w, h: op.h }); break;
        case 'glow': ctx.glows.push({ x: op.x + PAD, y: op.y + PAD, radius: op.radius, ramp: op.ramp ?? 'fire' }); break;
        default: break;
      }
    }
  }

  function rotateCW(img) {
    const o = new Img(img.h, img.w);
    for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) { const c = img.get(x, y); if (c && c[3]) o.set(img.h - 1 - y, x, c); }
    return o;
  }

  const fallbackFor = (tags = []) => {
    for (const t of ['garment', 'weapon', 'tool', 'valuable', 'supply', 'container', 'sack', 'crate']) {
      if (tags.includes(t) && byType.has(`@${t}`)) return byType.get(`@${t}`);
    }
    return byType.get('@crate') ?? null;
  };

  const GENERIC_DAMAGE = new Set(['broken', 'smashed', 'wrecked', 'destroyed', 'shattered']);

  /**
   * Broken, unmistakably: a jagged crack splits the thing, the far half drops and leans, a chunk is bitten out of one
   * corner, soot and scorch darken it, and splinters / shards lie on the floor around it. Returns { img, ox } (ox =
   * how far the anchor moved right because of the margin added for the debris).
   */
  function wreck(src, seed, ay) {
    const rng = rngFor(`wreck|${seed}`);
    const M = 8;
    const out = new Img(src.w + M * 2, src.h + 6);
    const crack = [];
    let cx = Math.round(src.w * (0.38 + rng() * 0.24));
    for (let y = 0; y < src.h; y++) { cx += Math.round((rng() - 0.5) * 3); cx = Math.max(3, Math.min(src.w - 4, cx)); crack.push(cx); }
    const biteR = Math.max(4, Math.round(Math.min(src.w, src.h) * 0.3));
    const biteX = rng() < 0.5 ? 0 : src.w - 1; const biteY = Math.round(rng() * src.h * 0.35);
    const colours = [];
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const c = src.get(x, y);
        if (!c || !c[3]) continue;
        if (colours.length < 400 && (x + y) % 3 === 0) colours.push(c);
        const db = Math.hypot((x - biteX) / biteR, (y - biteY) / biteR);
        if (db < 1 - rng() * 0.25) continue;                       // the missing chunk, with a ragged edge
        if (x >= crack[y] && x <= crack[y] + 1) continue;          // the crack itself
        const right = x > crack[y];
        const dx = right ? 2 : -1;
        const dy = right ? Math.min(5, 1 + Math.round((x - crack[y]) * 0.12)) : 0;
        let col = mix(c, [34, 28, 26, 255], 0.28);                  // soot
        if (rng() < 0.1) col = mix(col, [12, 10, 10, 255], 0.55);  // scorch marks
        out.set(x + M + dx, y + dy, col);
      }
    }
    // splinters and shards on the floor around it
    const n = 10 + Math.round((src.w * src.h) / 90);
    for (let i = 0; i < n && colours.length; i++) {
      const c = mix(colours[(rng() * colours.length) | 0], [30, 26, 24, 255], 0.2);
      const x = Math.round(rng() * (src.w + M * 2 - 3)); const y = Math.round(ay + 1 + (rng() - 0.6) * 6);
      const w = 1 + ((rng() * 3) | 0); const h = rng() < 0.6 ? 1 : 2;
      out.rect(x, Math.min(out.h - 2, y), w, h, c);
    }
    return { img: out, ox: M };
  }

  /**
   * The sprite of an object type in the given states.
   * opts: { states: ['lit'], color: 'blue' (garment ramp), tags: [...] }
   * → { img, ax, ay (anchor on the ground), flames: [{x,y,w,h}], glows: [{x,y,radius,ramp}] }
   */
  function sprite(type, opts = {}) {
    const states = (opts.states ?? []).filter(Boolean);
    const color = opts.color ?? 'linen';
    const key = `${type}|${states.join(',')}|${color}`;
    if (cache.has(key)) return cache.get(key);
    const recipe = byType.get(type) ?? fallbackFor(opts.tags);
    if (!recipe) return null;
    const [bw, bh] = recipe.size;
    const w = bw + PAD * 2; const h = bh + PAD * 2;
    const ctx = { canvas: new Img(w, h), w, h, flames: [], glows: [] };
    applyOps(ctx, recipe.draw, color);
    let overturned = false; let damaged = false;
    for (const s of states) {
      if (recipe.states?.[s]) applyOps(ctx, recipe.states[s], color);
      if (s === 'overturned' && !recipe.states?.[s]) overturned = true;
      if (GENERIC_DAMAGE.has(s)) damaged = true; // on top of the recipe's own broken look: broken must be obvious
    }
    let ax = recipe.anchor[0] + PAD; let ay = recipe.anchor[1] + PAD;
    let canvas = ctx.canvas;
    if (damaged) {
      const wr = wreck(canvas, type, ay);
      canvas = wr.img; ax += wr.ox;
      ctx.flames = []; ctx.glows = [];
    }
    let img = canvas.outline((near) => dim(near, 0.5));
    if (overturned) { img = rotateCW(img); ax = Math.round(img.w / 2); ay = img.h - 1; ctx.flames = []; ctx.glows = []; }
    const out = { img, ax, ay, flames: ctx.flames, glows: ctx.glows, w: img.w, h: img.h };
    cache.set(key, out);
    return out;
  }

  /** One frame (0..3) of a flame filling the box w × h: base wide, tip narrow, flickering. */
  function flame(w, h, frame = 0) {
    const key = `flame|${w}|${h}|${frame}`;
    if (cache.has(key)) return cache.get(key);
    const img = new Img(w, h);
    const rng = rngFor(`${key}`);
    const tongues = Math.max(2, Math.round(w / 5));
    for (let t = 0; t < tongues; t++) {
      const cx = ((t + 0.5) / tongues) * w;
      const th = h * (0.55 + rng() * 0.45);
      const bwid = (w / tongues) * (0.9 + rng() * 0.5);
      for (let y = 0; y < th; y++) {
        const f = y / th; // 0 at the base, 1 at the tip
        const half = (bwid / 2) * (1 - f * 0.9);
        const sway = Math.sin((frame + t) * 1.6 + f * 2) * f * 1.2;
        for (let x = Math.round(cx - half + sway); x <= Math.round(cx + half + sway); x++) {
          const c = f < 0.28 ? tone('fire', 2) : f < 0.65 ? tone('fire', 1) : tone('fire', 0);
          const core = Math.abs(x - (cx + sway)) < half * 0.4 && f < 0.5;
          img.set(x, h - 1 - y, core ? mix(c, [255, 240, 170, 255], 0.5) : c);
        }
      }
    }
    cache.set(key, img);
    return img;
  }

  return { sprite, flame, has: (type) => byType.has(type), types: () => [...byType.keys()].filter((t) => !t.startsWith('@')), byType };
}
