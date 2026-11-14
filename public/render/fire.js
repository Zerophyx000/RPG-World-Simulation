// Step 10: fire on the map, visual only. A burning object (o.data.burning) carries tongues of flame across its width
// (the same animated flame the hearths use, several columns, growing as it burns), throws embers and smoke, and lights
// the room around it with a flickering fire glow; a burnt one is drawn charred and smokes for a while. How it catches
// depends on the material (content/art/item-motions.json, handled in items.js). Rates follow the graphics quality.
import { hash32 } from '../art/rand.js';

export function createFire(ctx) {
  const last = new Map(); // object id -> ms of the last emit
  const charred = new Map(); // sprite img -> charred copy
  const charOf = (img) => {
    let c = charred.get(img);
    if (!c) {
      c = img.clone ? img.clone() : img;
      if (c.map) c = c.map((px) => (px && px[3] ? [Math.round(px[0] * 0.28), Math.round(px[1] * 0.24), Math.round(px[2] * 0.22), px[3]] : px));
      if (charred.size > 200) charred.clear();
      charred.set(img, c);
    }
    return c;
  };
  return {
    id: 'fire',
    // after the objects are placed (F.objectPos), with the other y-sorted things
    entities(F) {
      const S = F.S;
      const ms = F.ms;
      const particles = ctx.quality?.get?.('particles') !== false;
      for (const [id, e] of F.objectPos ?? []) {
        const o = e.o;
        const burning = o.data?.burning;
        const burnt = !burning && o.data?.burnt;
        if (!burning && !burnt) continue;
        const sp = e.sprite;
        const h = sp?.h ?? 12; const w = sp?.w ?? 12;
        // the glow: lit even slightly off screen, flickering
        if (burning) {
          const age = Math.max(0, (S.now ?? 0) - (burning.since ?? S.now));
          const grow = Math.min(1, 0.45 + age / 6);
          F.lights?.push({ wx: e.x, wy: e.y - h / 2, r: (40 + w) * grow * (0.9 + 0.1 * Math.sin(ms / 90 + (hash32(id) & 7))), k: 1, roomId: e.roomId, objectId: id, fire: true });
          if (!F.inView(e.x, e.y)) continue;
          const cols = Math.max(1, Math.min(4, Math.round(w / 9)));
          F.ents.push({
            y: e.y + 0.5, id: `flames-${id}`, draw: () => {
              for (let i = 0; i < cols; i++) {
                const fw = 6; const fh = Math.round((8 + (i % 2) * 3) * grow + 2);
                const fx = e.x - w / 2 + ((i + 0.5) * w) / cols - fw / 2;
                const img = ctx.objs?.flame?.(fw, fh, Math.floor(ms / 100) + i + (hash32(id) & 3));
                if (img) F.target.blit(img, F.X(fx), F.Y(e.y - h * 0.35 - fh), { scale: F.z });
              }
            },
          });
        } else if (sp && F.inView(e.x, e.y)) {
          // charred: drawn dark over the object's own sprite
          F.ents.push({ y: e.y + 0.3, id: `char-${id}`, draw: () => F.target.blit(charOf(sp.img), F.X(e.x - sp.ax), F.Y(e.y - sp.ay), { scale: F.z, alpha: 0.85 }) });
        }
        if (!particles || !F.inView(e.x, e.y)) continue;
        const smoking = burning || (S.now - (o.updatedAt ?? 0)) < 120;
        if (!smoking) continue;
        const every = burning ? 90 : 500;
        if (ms - (last.get(id) ?? 0) < every) continue;
        last.set(id, ms);
        if (burning) {
          F.emit('flame', e.x + (Math.random() * w - w / 2), e.y - h * 0.5);
          if (Math.random() < 0.4) F.emit('ember', e.x, e.y - h * 0.7);
          if (Math.random() < 0.5) F.emit('smoke', e.x, e.y - h);
        } else F.emit('smoke', e.x, e.y - h * 0.5);
      }
    },
  };
}
