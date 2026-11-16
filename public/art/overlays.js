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

/** A short version of a line for the overview: the first clause, cut at a word, with "…". */
export function summarize(text, max = 22) {
  let s = String(text ?? '').replace(/\s+/g, ' ').replace(/^["'“‘]+|["'”’]+$/g, '').trim();
  const first = s.split(/(?<=[.!?;:])\s|\s[—–-]\s/)[0] ?? s;
  if (first.length >= 6) s = first;
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[ ,.;:]+$/, '')}…`;
}

/** What someone is busy with, in a few words ('' when nothing worth a tag). */
export function taskText(c) {
  const a = c.activity ?? {};
  const d = a.detail ?? {};
  if (c.alive === false) return '';
  if (a.type === 'sleeping') return 'sleeping';
  if (a.type === 'collapsed') return 'collapsed';
  if (a.type === 'doing' && d.kind !== 'walk') return d.description ?? d.kind ?? 'busy';
  if (a.type === 'waiting') return d.reason ?? d.description ?? 'waiting';
  return '';
}

const TAG_BG = [28, 30, 38, 255];
const TAG_INK = [236, 230, 210, 255];

/**
 * entries: [{ c, x, y (feet, screen px), head (screen px above the head), color, selected, hovered }]
 * S: { bubbles: Map id -> { text, born }, thoughts: 'off'|'selected'|'all', names, icons, emotionIcons, uiScale }
 * Focused people (selected or hovered) get the full text; everyone else a one-line summary, for the overview.
 */
export function drawOverlays(target, entries, S, ms, zoom) {
  const ui = Math.max(1, Math.round(S.uiScale ?? 1));
  const ts = ui * (zoom >= 1 ? 2 : 1);   // text and icons: big enough to read at a glance
  const showDetail = zoom >= 0.5;
  for (const e of entries) {
    if (e.selected) {
      const pulse = 1 + Math.sin(ms / 260) * 0.5;
      target.ring(e.x, e.y - 2 * zoom, 15 * zoom + pulse, 6 * zoom + pulse / 2, e.color);
    }
  }
  if (!showDetail) return;
  // focused people last, so their full bubbles sit on top
  const ordered = [...entries].sort((a, b) => (a.selected || a.hovered ? 1 : 0) - (b.selected || b.hovered ? 1 : 0) || a.y - b.y);
  for (const e of ordered) {
    const { c } = e;
    const focused = e.selected || e.hovered;
    let y = e.head;
    // name
    if (S.names !== false && (zoom >= 1 || focused)) {
      const t = cachedText(S.nameOf?.(c) ?? c.name, e.color); // step 9: the subjective camera names strangers by their look
      target.blit(t, e.x - (t.w * ts) / 2, y - t.h * ts, { scale: ts });
      y -= t.h * ts + ts;
    }
    // what they are doing
    const task = taskText(c);
    if (task && zoom >= 1) {
      const short = summarize(task, focused ? 34 : 16);
      const label = /…$/.test(short) ? short : `${short}…`;
      const t = cachedText(label, TAG_INK, [0, 0, 0, 0]);
      const w = t.w * ts + 4 * ts; const h = t.h * ts + 2 * ts;
      target.rect(e.x - w / 2, y - h, w, h, TAG_BG, 0.82);
      target.blit(t, e.x - w / 2 + 2 * ts, y - h + ts, { scale: ts });
      y -= h + ts;
    }
    // icons: feelings and the body
    if (S.icons !== false && zoom >= 1) {
      const icons = [];
      const dom = c.emotion?.dominant;
      if (c.alive === false) icons.push('skull');
      else {
        if (S.emotionIcons !== false && dom && dom.intensity >= 3 && ICON_DEFS[dom.type]) icons.push(dom.type);
        if (c.activity?.type === 'sleeping') icons.push('sleep');
        if ((c.body?.bleeding ?? 0) > 0.5) icons.push('blood');
        if ((c.body?.pain ?? 0) >= 6) icons.push('pain');
        if (c.activity?.type === 'thinking') icons.push('think');
      }
      const crit = c.body?.critical;
      const parts = icons.map(iconImg).filter(Boolean);
      let critImg = null;
      if (crit != null && c.alive !== false) critImg = cachedText(`${Math.max(0, Math.round(crit))} min`, [255, 120, 110, 255]);
      const iw = 10 * ts;
      let w = parts.length * iw + (critImg ? critImg.w * ts + 2 : 0);
      let x = e.x - w / 2;
      for (const p of parts) { target.blit(p, x, y - 9 * ts, { scale: ts }); x += iw; }
      if (critImg) target.blit(critImg, x + 2, y - critImg.h * ts, { scale: ts });
      if (parts.length || critImg) y -= 10 * ts;
    }
    e.top = y;
  }
  // speech (a spoken line stays for its reading time) and thoughts
  for (const e of ordered) {
    const { c } = e;
    const focused = e.selected || e.hovered;
    const b = S.bubbles?.get(c.id);
    const age = b ? ms - b.born : Infinity;
    if (b && age < readMs(b.text)) {
      const said = S.muted?.(c) ? '…' : b.text; // step 9: a deaf viewer sees only that someone speaks
      const lines = focused ? wrapText(said, 26, 4) : [summarize(said, 22)];
      bubble(target, lines, e.x, e.top - 2, { ts: focused ? ts : ui * (zoom >= 1 ? 2 : 1), alpha: Math.min(1, age / 120) });
    } else if (S.thoughts && S.thoughts !== 'off' && c.lastInnerThought && c.alive !== false && zoom >= 1 && (focused || S.thoughts === 'all')) {
      const lines = focused ? wrapText(c.lastInnerThought, 30, 3) : [summarize(c.lastInnerThought, 20)];
      bubble(target, lines, e.x, e.top - 4, { ts, bg: THOUGHT, border: [90, 104, 150, 255], alpha: focused ? 0.95 : 0.8, round: true });
    }
  }
}
