// Step 9: wind. A slowly changing value per map region from smooth seeded noise of real time (gusts every 20-60 s),
// twice as strong when it rains. Trees and bushes sway with it, chimney smoke drifts, capes flutter. Pure functions.
import { hash32 } from '../art/rand.js';

const smooth = (t) => t * t * (3 - 2 * t);
function noise1(seed, x) {
  const i = Math.floor(x); const f = x - i;
  const a = (hash32(`${seed}|${i}`) % 1000) / 1000; const b = (hash32(`${seed}|${i + 1}`) % 1000) / 1000;
  return a + (b - a) * smooth(f); // 0..1
}

/** → { x: -1..1 (direction and strength along x), strength: 0..1 } */
export function windAt(mapId, ms, _gameMinutes = 0, raining = false) {
  const t = ms / 1000;
  const base = noise1(`wind|${mapId}`, t / 40) * 0.7 + noise1(`gust|${mapId}`, t / 9) * 0.3; // slow drift plus gusts
  const dir = noise1(`dir|${mapId}`, t / 90) * 2 - 1;
  const strength = Math.min(1, base * (raining ? 2 : 1));
  return { x: Math.max(-1, Math.min(1, (dir >= 0 ? 1 : -1) * (0.3 + Math.abs(dir) * 0.7) * strength)), strength };
}

/** Pixel offset for the crown of a tree (up to 2 px) or a bush (up to 1 px) at a tile; 0 for anything else. */
export function swayFor(kind, tx, ty, ms, wind) {
  const amp = kind === 'tree' ? 2 : kind === 'bush' ? 1 : 0;
  if (!amp || !wind || wind.strength < 0.05) return 0;
  const phase = (hash32(`${tx},${ty}`) % 628) / 100;
  const hz = 0.5 + (hash32(`f${tx},${ty}`) % 50) / 100;
  const s = Math.sin((ms / 1000) * hz * Math.PI * 2 + phase) * 0.6 + (wind.x ?? 0) * 0.6;
  return Math.max(-amp, Math.min(amp, Math.round(s * amp * Math.min(1, wind.strength * 1.5))));
}
