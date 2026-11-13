// Step 9: traces. STUB (keeps the step-8 bloodstains from room effects): the task "traces-client" implements worn paths
// (S.wear), persisted decals (S.decals), and room clutter (content/art/clutter.json).
import { Img, rngFor } from '../art/pixels.js';
import { hash32 } from '../art/rand.js';

export function createTraces(ctx) {
  const { pal } = ctx;
  const stainCache = new Map();
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
  return {
    id: 'traces',
    ground(F) {
      const { target, X, Y, z, inView, layout, now } = F;
      for (const room of F.S.rooms.values()) {
        for (const ef of room.effects ?? []) {
          const v = ef.visual;
          if (v?.kind !== 'bloodstain') continue;
          const p = layout.standPx(room.id, v.spot ?? null, `stain${ef.id}`);
          if (!p || !inView(p.x, p.y)) continue;
          const ageDays = Math.max(0, (now - (v.at ?? now)) / 1440);
          const a = Math.max(0.2, Math.min(0.9, 0.9 - ageDays * 0.28));
          target.blit(stainImg(hash32(ef.id) % 6), Math.round(X(p.x - 13)), Math.round(Y(p.y - 7)), { scale: z, alpha: a });
        }
      }
    },
  };
}
