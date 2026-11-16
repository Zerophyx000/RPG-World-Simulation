// Step 8: the master palette. `pal.color('wood', 1)` is the base tone of the wood ramp (0 = shadow, 2 = highlight);
// `pal.outline('wood')` is the dark outline shade of a ramp. Everything the renderer draws comes from here.
import { hex } from './pixels.js';

export function makePalette(json) {
  const ramps = {};
  for (const [name, tones] of Object.entries(json.ramps ?? {})) ramps[name] = tones.map(hex);
  const k = json.light?.outline ?? 0.55;
  const dim = (c, f) => [Math.round(c[0] * f), Math.round(c[1] * f), Math.round(c[2] * f), 255];
  const all = Object.values(ramps).flat();
  const pal = {
    ramps,
    has: (name) => Boolean(ramps[name]),
    ramp: (name) => ramps[name] ?? ramps.grey,
    color: (name, tone = 1) => (ramps[name] ?? ramps.grey)[Math.max(0, Math.min(2, tone))],
    outline: (name) => dim((ramps[name] ?? ramps.grey)[0], k),
    /** The nearest palette colour (for tints that should stay on the palette). */
    snap(c) {
      let best = all[0]; let bd = Infinity;
      for (const p of all) {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bd) { bd = d; best = p; }
      }
      return [best[0], best[1], best[2], c[3] ?? 255];
    },
    names: () => Object.keys(ramps),
    all,
  };
  return pal;
}
