// Step 8: overlays drawn on top of the world in SCREEN space (crisp at every zoom): names, speech bubbles (a line stays
// until its reading time is over, matching the server's reading floor), god-view thought bubbles, emotion and status
// icons (incl. the critical countdown) and the selection ring. Overlays only READ what the UI already shows.
import { Img } from './pixels.js';
import { textImg, wrapText, CELL_H, CELL_W } from './font.js';

const INK = [40, 34, 30, 255];
const PAPER = [250, 246, 236, 255];
const THOUGHT = [226, 232, 246, 255];

// 7x7 icons: rows of characters mapped to colours
const ICON_DEFS = {
  joy: { rows: ['..yyy..', '.y...y.', 'y.k.k.y', 'y.....y', 'y.k.k.y', '.y.kk.y', '..yyy..'], map: { y: [235, 190, 60, 255], k: [90, 60, 30, 255] } },
  sadness: { rows: ['...b...', '..bb...', '..bb...', '.bbbb..', '.bbbb..', '.bbbb..', '..bb...'], map: { b: [90, 150, 220, 255] } },
  fear: { rows: ['..vv...', '..vv...', '..vv...', '..vv...', '.......', '..vv...', '..vv...'], map: { v: [180, 150, 235, 255] } },
  anger: { rows: ['r.....r', '.r...r.', '..r.r..', '...r...', '..r.r..', '.r...r.', 'r.....r'], map: { r: [220, 60, 50, 255] } },
  disgust: { rows: ['..ggg..', '.gggg..', 'gg.ggg.', 'ggggggg', '.ggggg.', '..g.g..', '.......'], map: { g: [110, 170, 70, 255] } },
  shame: { rows: ['.......', '.pp.pp.', 'pppppp.', 'pppppp.', '.pppp..', '..pp...', '.......'], map: { p: [230, 130, 150, 255] } },
  guilt: { rows: ['.......', '.nn.nn.', 'nnnnnn.', 'nnnnnn.', '.nnnn..', '..nn...', '.......'], map: { n: [150, 110, 160, 255] } },
  pride: { rows: ['...o...', '...o...', 'ooooooo', '.ooooo.', '..ooo..', '.oo.oo.', '.o...o.'], map: { o: [240, 200, 70, 255] } },
  affection: { rows: ['.rr.rr.', 'rrrrrrr', 'rrrrrrr', '.rrrrr.', '..rrr..', '...r...', '.......'], map: { r: [225, 80, 100, 255] } },
  gratitude: { rows: ['.......', '..yy...', '.yyyy..', '.yyyyy.', '..yyyy.', '...yy..', '.......'], map: { y: [245, 215, 110, 255] } },
  envy: { rows: ['.ggggg.', 'g.....g', 'g.ggg.g', 'g.g.g.g', 'g.ggg.g', 'g.....g', '.ggggg.'], map: { g: [90, 170, 90, 255] } },
  jealousy: { rows: ['.ggggg.', 'g.....g', 'g.ggg.g', 'g.g.g.g', 'g.ggg.g', 'g.....g', '.ggggg.'], map: { g: [120, 190, 70, 255] } },
  sleep: { rows: ['zzzzz..', '...z...', '..z....', '.z.....', 'zzzzz..', '.......', '.......'], map: { z: [140, 170, 240, 255] } },
  blood: { rows: ['...r...', '..rr...', '..rr...', '.rrrr..', '.rrrr..', '.rrrr..', '..rr...'], map: { r: [200, 40, 50, 255] } },
  pain: { rows: ['..yy...', '.yyyy..', '.y..y..', '..yy...', '.......', '..yy...', '..yy...'], map: { y: [255, 160, 60, 255] } },
  think: { rows: ['.......', '.......', '.......', 'k.k.k..', '.......', '.......', '.......'], map: { k: [200, 200, 210, 255] } },
  skull: { rows: ['.wwwww.', 'wwwwwww', 'w.www.w', 'wwwwwww', '.wwwww.', '.w.w.w.', '.......'], map: { w: [230, 226, 214, 255] } },
};

const iconCache = new Map();
function iconImg(name) {
  if (iconCache.has(name)) return iconCache.get(name);
  const def = ICON_DEFS[name];
  if (!def) return null;
  const img = new Img(9, 9);
  def.rows.forEach((row, y) => [...row].forEach((ch, x) => { if (def.map[ch]) img.set(x + 1, y + 1, def.map[ch]); }));
  img.outline([20, 18, 20, 255]);
  iconCache.set(name, img);
  return img;
}

const textCache = new Map();
function cachedText(str, color, outline = [20, 18, 24, 255]) {
  const k = `${str}|${color}|${outline}`;
  let t = textCache.get(k);
  if (!t) {
    if (textCache.size > 600) textCache.clear();
    t = textImg(str, { color, outline });
    textCache.set(k, t);
  }
  return t;
}

/** A speech bubble: wrapped lines in a paper box with a tail pointing down at (tailX, bottomY). Returns its screen box. */
function bubble(target, lines, anchorX, bottomY, { ts, bg = PAPER, border = INK, tail = true, alpha = 1, round = false }) {
  const widest = Math.max(...lines.map((l) => l.length));
  const w = widest * CELL_W * ts + 8 * ts; const h = lines.length * (CELL_H + 1) * ts + 6 * ts;
  let x = Math.round(anchorX - w / 2); const y = Math.round(bottomY - h - 4 * ts);
  x = Math.max(4, Math.min(target.w - w - 4, x));
  target.rect(x - 1, y - 1, w + 2, h + 2, border, alpha);
  target.rect(x, y, w, h, bg, alpha);
  if (round) for (const [cx, cy] of [[x - 1, y - 1], [x + w, y - 1], [x - 1, y + h], [x + w, y + h]]) target.rect(cx, cy, 1, 1, bg, 0);
  if (tail) {
    const tx = Math.max(x + 3, Math.min(x + w - 3 * ts - 3, Math.round(anchorX) - ts));
    if (round) { target.ellipse(tx + 1, y + h + 3 * ts, 2 * ts, 2 * ts, bg, alpha); target.ellipse(tx - 1, y + h + 7 * ts, ts, ts, bg, alpha); } else {
      target.rect(tx - 1, y + h, 3 * ts + 2, 1, border, alpha);
      for (let i = 0; i < 3; i++) target.rect(tx + i * ts, y + h + i * ts, Math.max(1, 3 * ts - i * 2 * ts), ts, bg, alpha);
    }
  }
  lines.forEach((l, i) => target.blit(cachedText(l, bg === PAPER ? INK : [30, 40, 70, 255], [0, 0, 0, 0]), x + 3 * ts - 1, y + 3 * ts + i * (CELL_H + 1) * ts - 1, { scale: ts, alpha }));
  return { x, y, w, h };
}

/** Reading time of a line in real milliseconds (matches the pace of the server's reading floor). */
export const readMs = (text) => Math.max(2800, Math.min(9000, 1400 + String(text).length * 55));

/**
 * entries: [{ c, x, y (feet, screen px), head (screen px above the head), color, selected, hovered }]
 * S: { bubbles: Map id -> { text, born }, thoughts: 'off'|'selected'|'all', names: bool, icons: bool, uiScale }
 */
export function drawOverlays(target, entries, S, ms, zoom) {
  const ts = Math.max(1, Math.round(S.uiScale ?? 1));
  const showDetail = zoom >= 0.5;
  for (const e of entries) {
    const { c } = e;
    if (e.selected) {
      const pulse = 1 + Math.sin(ms / 260) * 0.5;
      target.ring(e.x, e.y - 2 * zoom, 15 * zoom + pulse, 6 * zoom + pulse / 2, e.color);
    }
  }
  if (!showDetail) return;
  // names and icons
  for (const e of entries) {
    const { c } = e;
    let y = e.head;
    if (S.names !== false && (zoom >= 1 || e.selected || e.hovered)) {
      const t = cachedText(c.name, e.color);
      target.blit(t, e.x - (t.w * ts) / 2, y - t.h * ts, { scale: ts });
      y -= t.h * ts + 1;
    }
    if (S.icons !== false && zoom >= 1) {
      const icons = [];
      const dom = c.emotion?.dominant;
      if (c.alive === false) icons.push('skull');
      else {
        if (S.emotionIcons !== false && dom && dom.intensity >= 3 && ICON_DEFS[dom.type]) icons.push(dom.type);
        if (c.activity?.type === 'sleeping') icons.push('sleep');
        if ((c.body?.bleeding ?? 0) > 0.5) icons.push('blood');
        if ((c.body?.pain ?? 0) >= 6) icons.push('pain');
        if (c.activity?.type === 'thinking' && c.alive !== false) icons.push('think');
      }
      const crit = c.body?.critical;
      const parts = icons.map(iconImg).filter(Boolean);
      let w = parts.length * 9 * ts;
      let critImg = null;
      if (crit != null && c.alive !== false) { critImg = cachedText(`${Math.max(0, Math.round(crit))}m`, [255, 120, 110, 255]); w += critImg.w * ts; }
      let x = e.x - w / 2;
      for (const p of parts) { target.blit(p, x, y - 9 * ts, { scale: ts }); x += 9 * ts; }
      if (critImg) target.blit(critImg, x, y - critImg.h * ts, { scale: ts });
      if (parts.length || critImg) y -= 10 * ts;
    }
    e.top = y;
  }
  // speech bubbles (a spoken line stays until its reading time is over) and thoughts
  for (const e of entries) {
    const { c } = e;
    const b = S.bubbles?.get(c.id);
    const age = b ? ms - b.born : Infinity;
    if (b && age < readMs(b.text)) {
      const lines = wrapText(b.text, 26, 4);
      bubble(target, lines, e.x, e.top - 2, { ts, alpha: Math.min(1, age / 120) });
      e.top -= (lines.length * (CELL_H + 1) + 14) * ts;
    } else if (S.thoughts && S.thoughts !== 'off' && c.lastInnerThought && c.alive !== false && (S.thoughts === 'all' || e.selected || e.hovered) && zoom >= 1) {
      const lines = wrapText(c.lastInnerThought, 30, 3);
      bubble(target, lines, e.x, e.top - 4, { ts, bg: THOUGHT, border: [90, 104, 150, 255], alpha: 0.92, round: true });
    }
  }
}
