// Step 9: depth. The south walls of buildings (front walls) are not part of the ground chunks any more: they are
// drawn as tall y-sorted entities (tiles.wallFront), so a person standing right behind one is hidden from the knees
// down, as in a 3/4 view. The SELECTED citizen stays findable: when a front wall covers them, a 1 px outline of their
// figure is drawn on top in their colour.
import { TILE } from '../art/mapdata.js';
import { Img } from '../art/pixels.js';
import { WALL_H } from '../art/tiles.js';

export function createDepth(ctx) {
  const { tiles } = ctx;
  const fronts = new Map();          // map id -> [[tx, ty], ...]
  const outlines = new WeakMap();    // sprite Img -> Map colour -> outline Img
  let drawnRects = [];

  function frontList(F) {
    let list = fronts.get(F.map.id);
    if (list) return list;
    list = [];
    for (let ty = 0; ty < F.grid.H; ty++) for (let tx = 0; tx < F.grid.W; tx++) if (tiles.isFrontWall?.(F.grid, tx, ty)) list.push([tx, ty]);
    fronts.set(F.map.id, list);
    return list;
  }

  function outlineOf(img, color) {
    let m = outlines.get(img);
    if (!m) { m = new Map(); outlines.set(img, m); }
    const key = color.join(',');
    let out = m.get(key);
    if (out) return out;
    out = new Img(img.w, img.h);
    for (let y = 0; y < img.h; y++) {
      for (let x = 0; x < img.w; x++) {
        if (img.alphaAt(x, y)) continue;
        if (img.alphaAt(x - 1, y) || img.alphaAt(x + 1, y) || img.alphaAt(x, y - 1) || img.alphaAt(x, y + 1)) out.set(x, y, color);
      }
    }
    m.set(key, out);
    return out;
  }

  return {
    id: 'depth',
    entities(F) {
      drawnRects = [];
      if (F.lod || !tiles.wallFront) return;
      for (const [tx, ty] of frontList(F)) {
        const wx = tx * TILE; const wy = ty * TILE;
        if (wx + TILE < F.view.x0 || wx > F.view.x1 || wy + TILE < F.view.y0 || wy - WALL_H > F.view.y1) continue;
        F.ents.push({
          y: (ty + 1) * TILE - 1, draw: () => {
            const w = tiles.wallFront(F.grid, tx, ty);
            if (!w) return;
            const x = F.X(wx); const y = F.Y(wy - WALL_H);
            F.target.blit(w.img, x, y, { scale: F.z });
            drawnRects.push([x, y, w.img.w * F.z, w.img.h * F.z]);
          },
        });
      }
    },
    overEntities(F) {
      const id = F.S.selectedId;
      const p = id ? F.people.get(id) : null;
      const d = p?.drawn;
      if (!d || d.partial || F.lod) return;
      const w = d.img.w * d.scale; const h = d.img.h * d.scale;
      const covered = drawnRects.some(([x, y, rw, rh]) => d.sx < x + rw && d.sx + w > x && d.sy < y + rh && d.sy + h > y && y > d.sy);
      if (!covered) return;
      const color = F.S.colorOf?.(id) ?? [255, 255, 255, 255];
      F.target.blit(outlineOf(d.img, color), d.sx, d.sy, { scale: d.scale, alpha: 0.9 });
    },
  };
}
