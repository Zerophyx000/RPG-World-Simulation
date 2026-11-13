// Step 9: light and shadow. STUB (keeps the step-8 night tint): the task "lighting" implements drop and cast shadows by
// the sun, ambient occlusion, lit windows with light spill, flicker, banded dithered falloff, darkness at night.
import { nightFactor } from '../art/scene.js';

export function createLighting(_ctx) {
  return {
    id: 'lighting',
    light(F) {
      const { target, X, Y, z, inView, lights } = F;
      const night = F.S.nightOverride ?? nightFactor(F.dayMin);
      const lit = lights.filter((l) => inView(l.wx, l.wy)).map((l) => ({ x: X(l.wx), y: Y(l.wy), r: l.r * z * 1.3, k: l.k }));
      if (night > 0.01) target.ambient([18, 24, 60, 255], night * 0.55, lit);
    },
  };
}
