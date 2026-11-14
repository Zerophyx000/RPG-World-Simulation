// Step 9: room and weather effects (moved from scene.js). The task "lighting" extends it: chimney smoke drifting with
// the wind, fire, smoke haze, rubble from room effects, rain, the blast flash and camera shake.
import { TILE } from '../art/mapdata.js';
import { rngFor } from '../art/pixels.js';
import { hash32 } from '../art/rand.js';

export const effectKind = (text = '') => /rubble|collaps|blast|debris|explo/i.test(text) ? 'rubble' : /\bfire\b|burning|flames|ablaze/i.test(text) ? 'fire' : /smoke|smok/i.test(text) ? 'smoke' : null;

export function createEffects(ctx) {
  const { pal, objs } = ctx;
  const blasts = [];
  return {
    id: 'effects',
    blast(ms) { blasts.push({ at: ms }); },
    shake(ms) {
      let dx = 0; let dy = 0;
      for (let i = blasts.length - 1; i >= 0; i--) {
        const age = ms - blasts[i].at;
        if (age > 700) { blasts.splice(i, 1); continue; }
        const k = (1 - age / 700) * 5; dx += Math.sin(age / 18) * k; dy += Math.cos(age / 23) * k;
      }
      return { dx, dy };
    },
    overEntities(F) {
      const { target, X, Y, z, inView, ms, layout, lights } = F;
      // chimney smoke from buildings with a lit hearth, oven or forge
      const chimneys = new Map();
      for (const p of F.objectPos.values()) {
        if (!['lit', 'hot', 'roaring', 'smouldering'].includes(p.o.state)) continue;
        const g = layout.geom(p.roomId);
        if (g?.room.kind !== 'building') continue;
        chimneys.set(p.roomId, { x: (g.room.rect.x + g.room.rect.w * 0.72) * TILE, y: g.room.rect.y * TILE + 6, strong: p.o.state !== 'smouldering' });
      }
      for (const s of chimneys.values()) {
        if (!inView(s.x, s.y)) continue;
        for (let k = 0; k < 6; k++) {
          const ph = ((ms / 5200) * (s.strong ? 1 : 0.6) + k / 6) % 1;
          const px = s.x + Math.sin(ph * 5 + k * 1.7) * 7 + ph * 8 + ph * 64 * (F.wind?.x ?? 0) * 0.6; const py = s.y - ph * 64; // drifts with the wind
          target.ellipse(X(px), Y(py), (3 + ph * 7) * z, (2.5 + ph * 5) * z, pal.color('smoke', ph < 0.5 ? 1 : 2), (1 - ph) * 0.55);
        }
      }
      // lasting room effects by their text
      for (const room of F.S.rooms.values()) {
        const drawn = new Set();
        for (const ef of room.effects ?? []) {
          const kind = ef.visual?.kind ?? effectKind(ef.text);
          if (!kind || kind === 'bloodstain' || drawn.has(kind)) continue;
          drawn.add(kind);
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
              target.blit(objs.flame(18, 22, Math.floor(ms / 110) + i), X(wx - 9), Y(wy - 22), { scale: z });
              lights.push({ wx, wy: wy - 10, r: 44, k: 0.9, roomId: room.id });
            } else if (kind === 'smoke') {
              if (i === 0) target.rect(X(r.x * TILE), Y(r.y * TILE), r.w * TILE * z, r.h * TILE * z, pal.color('smoke', 2), 0.08 + 0.03 * Math.sin(ms / 900));
              const ph = ((ms / 7000) + i / n) % 1;
              const top = (r.y + 1) * TILE + ((h >>> 12) % Math.max(1, Math.round(r.h * TILE / 3)));
              target.ellipse(X(wx + Math.sin(ph * 6) * 10), Y(top - ph * 24), (8 + ph * 12) * z, (3 + ph * 4) * z, pal.color('smoke', 2), Math.sin(ph * Math.PI) * 0.22);
            }
          }
        }
      }
    },
    screen(F) {
      const { target, cam, ms } = F;
      if (F.S.rain && !F.lod) {
        // splashes on the ground (particles, if on)
        const v = F.view;
        for (let i = 0; i < 3; i++) F.emit('splash', v.x0 + Math.random() * (v.x1 - v.x0), v.y0 + Math.random() * (v.y1 - v.y0));
      }
      if (F.S.rain) {
        const rr = rngFor('rain');
        for (let i = 0; i < Math.round(cam.w * cam.h / 6000); i++) {
          const bx = rr() * cam.w; const by = rr() * cam.h; const sp = 0.6 + rr() * 0.6;
          const yy = (by + ms * sp * 0.9) % cam.h; const xx = (bx - ms * 0.15 * sp + cam.w) % cam.w;
          target.rect(xx, yy, 1, 6, [170, 190, 230, 255], 0.55);
        }
      }
      for (const b of blasts) {
        const age = ms - b.at;
        if (age >= 0 && age < 320) target.rect(0, 0, cam.w, cam.h, [255, 236, 190, 255], (1 - age / 320) * 0.75);
      }
    },
  };
}
