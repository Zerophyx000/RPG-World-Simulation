// A stable color per citizen. Colors are handed out in creation order (born_at, then id) from a
// palette ordered for maximum contrast, so the first citizens never get look-alike colors and a
// newly added citizen never changes anyone else's color. Hashing is only the fallback for unknown ids.
import { store } from './store.js';

const PALETTE = [
  '#e0a43a', // amber
  '#5fb3d9', // sky
  '#e0607e', // rose
  '#6cc28a', // green
  '#a98be6', // violet
  '#3fc9b8', // teal
  '#e58ad6', // pink
  '#b5cf4a', // lime
  '#6f8cf0', // blue
  '#e8804a', // orange
  '#c99a6e', // tan
  '#e6d66a', // yellow
];

let cacheKey = '';
let cache = new Map();

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rebuild() {
  const list = [...store.citizens.values()]
    .sort((a, b) => (a.bornAt ?? 0) - (b.bornAt ?? 0) || String(a.id).localeCompare(String(b.id)));
  const key = list.map((c) => c.id).join('|');
  if (key === cacheKey) return;
  cacheKey = key;
  cache = new Map(list.map((c, i) => [c.id, PALETTE[i % PALETTE.length]]));
}

export function colorOf(id) {
  rebuild();
  return cache.get(id) ?? PALETTE[hash(String(id)) % PALETTE.length];
}

/** Translucent version for backgrounds. */
export function tint(id, alpha = 0.18) {
  const n = parseInt(colorOf(id).slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
