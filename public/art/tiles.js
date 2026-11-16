// Step 8: procedural tiles. Every ground, wall, door and fence tile is drawn by code from palette ramps with seeded
// noise (stable per position), 4-neighbour autotiling (path edges, shores, walls) and 2-4 frame cycles for water.
// `tile` is the one producer for tiles: replace it to swap in hand-made art.
import { Img, mix } from './pixels.js';
import { mulberry, cellNoise } from './rand.js';
import { TILE } from './mapdata.js';

const N = 1; const E = 2; const S = 4; const W = 8; // neighbour mask bits

export const WATER_FRAMES = 4;
export const WALL_H = 18; // step 9: how far a front wall rises above its own tile

/** Is this ground material "path-like" for autotiling (blends with neighbours of the same family)? */
const FAMILY = { dirt_path: 'path', cobble: 'path', dirt: 'path', wood_floor: 'floor', stone_floor: 'floor', grass: 'grass', water: 'water' };

export function makeTiles(pal) {
  const cache = new Map();
  const c = (ramp, tone) => pal.color(ramp, tone);

  const speckle = (img, rng, ramp, count, tones = [0, 2]) => {
    for (let i = 0; i < count; i++) img.set((rng() * TILE) | 0, (rng() * TILE) | 0, c(ramp, tones[(rng() * tones.length) | 0]));
  };

  function grass(v) {
    const rng = mulberry(1000 + v);
    const img = new Img(TILE, TILE).fill(c('grass', 1));
    speckle(img, rng, 'grass', 26, [0, 0, 2]);
    for (let i = 0; i < 4; i++) { // little tufts
      const x = 2 + ((rng() * 27) | 0); const y = 3 + ((rng() * 26) | 0);
      img.set(x, y, c('grass', 0)); img.set(x, y - 1, c('grass', 2)); img.set(x + 1, y, c('grass', 0)); img.set(x + 1, y - 2, c('grass', 2));
    }
    return img;
  }

  function dirtish(ramp, v, mask, fringe) {
    const rng = mulberry(2000 + v * 31 + mask);
    const img = new Img(TILE, TILE).fill(c(ramp, 1));
    speckle(img, rng, ramp, 34, [0, 0, 2]);
    for (let i = 0; i < 3; i++) { const x = (rng() * 28) | 0; const y = (rng() * 28) | 0; img.set(x, y, c(ramp, 2)); img.set(x + 1, y, c(ramp, 2)); img.set(x, y + 1, c(ramp, 0)); }
    if (fringe) {
      const edge = (side) => {
        for (let i = 0; i < TILE; i++) {
          const depth = 1 + ((rng() * 3.2) | 0) + (side & (N | W) ? 0 : 1);
          for (let d = 0; d < depth; d++) {
            const [x, y] = side === N ? [i, d] : side === S ? [i, TILE - 1 - d] : side === W ? [d, i] : [TILE - 1 - d, i];
            img.set(x, y, c('grass', d === depth - 1 ? 0 : 1));
          }
          const d2 = depth;
          const [x, y] = side === N ? [i, d2] : side === S ? [i, TILE - 1 - d2] : side === W ? [d2, i] : [TILE - 1 - d2, i];
          img.set(x, y, c(ramp, 0));
        }
      };
      for (const side of [N, E, S, W]) if (mask & side) edge(side);
    }
    return img;
  }

  function cobble(v, mask) {
    const rng = mulberry(3000 + v * 17 + mask);
    const img = new Img(TILE, TILE).fill(c('stone', 0));
    img.rect(0, 0, TILE, TILE, c('stone', 0));
    let y = 0; let row = 0;
    while (y < TILE) {
      const h = 7 + ((rng() * 3) | 0);
      let x = -((rng() * 6) | 0) - (row % 2 ? 5 : 0);
      while (x < TILE) {
        const w = 8 + ((rng() * 5) | 0);
        const tone = [1, 1, 1, 1, 1, 0, 2][(rng() * 7) | 0];
        const sx = Math.max(0, x) + 1; const sy = y + 1; const ex = Math.min(TILE, x + w) - 1; const ey = Math.min(TILE, y + h) - 1;
        if (ex > sx && ey > sy) {
          img.rect(sx, sy, ex - sx, ey - sy, c('stone', tone));
          for (let i = sx; i < ex; i++) if (tone < 2) img.set(i, sy, c('stone', Math.min(2, tone + 1)));      // light on the top edge
          for (let i = sx; i < ex; i++) img.set(i, ey - 1, c('stone', Math.max(0, tone - 1)));  // shadow bottom
          if (rng() < 0.25) img.set(sx + 3, sy + 2, c('stone', 0));
        }
        x += w;
      }
      y += h; row++;
    }
    return img;
  }

  function planks(v) {
    const rng = mulberry(4000 + v);
    const img = new Img(TILE, TILE);
    for (let r = 0; r < 4; r++) {
      const tone = [1, 1, 1, 1, 0, 1, 1, 2][(r * 3 + v + ((rng() * 3) | 0)) % 8];
      img.rect(0, r * 8, TILE, 8, c('wood', tone));
      for (let x = 0; x < TILE; x++) { img.set(x, r * 8, c('wood', Math.min(2, tone + 1))); img.set(x, r * 8 + 7, c('wood', 0)); }
      const joint = (rng() * 26 + 3) | 0;
      for (let y = 1; y < 7; y++) img.set(joint, r * 8 + y, c('wood', 0));
      img.set(joint + 3, r * 8 + 3, c('wood', 0)); img.set(joint - 5, r * 8 + 4, c('wood', 0));
      for (let i = 0; i < 2; i++) img.set((rng() * 32) | 0, r * 8 + 2 + ((rng() * 4) | 0), c('wood', tone === 2 ? 1 : 2));
    }
    return img;
  }

  function slabs(v) {
    const rng = mulberry(5000 + v);
    const img = new Img(TILE, TILE).fill(c('stone', 1));
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const tone = [1, 1, 0, 2][(rng() * 4) | 0];
      img.rect(i * 16 + 1, j * 16 + 1, 14, 14, c('stone', tone));
      for (let k = 0; k < 14; k++) { img.set(i * 16 + 1 + k, j * 16 + 1, c('stone', Math.min(2, tone + 1))); img.set(i * 16 + 1, j * 16 + 1 + k, c('stone', Math.min(2, tone + 1))); }
      img.set(i * 16 + 5 + ((rng() * 6) | 0), j * 16 + 6 + ((rng() * 5) | 0), c('stone', 0));
    }
    for (let k = 0; k < TILE; k++) { img.set(k, 0, c('stone', 0)); img.set(0, k, c('stone', 0)); img.set(k, 16, c('stone', 0)); img.set(16, k, c('stone', 0)); }
    return img;
  }

  function water(v, mask, frame) {
    const rng = mulberry(6000 + v);
    const img = new Img(TILE, TILE).fill(c('water', 1));
    for (let i = 0; i < 7; i++) { // ripples that drift with the frame
      const y = (rng() * 30) | 0; const x0 = (rng() * 26) | 0 + 0;
      const x = (x0 + frame * 2 + (i % 2 ? frame : 0)) % 28;
      img.rect(x, y, 4, 1, c('water', 2));
      img.rect(x + 1, y + 1, 3, 1, c('water', 0));
    }
    for (const [side, ex] of [[N, 0], [S, 1], [W, 2], [E, 3]]) {
      if (!(mask & side)) continue;
      for (let i = 0; i < TILE; i++) {
        const [x, y] = side === N ? [i, 0] : side === S ? [i, TILE - 1] : side === W ? [0, i] : [TILE - 1, i];
        const dx = side === W ? 1 : side === E ? -1 : 0; const dy = side === N ? 1 : side === S ? -1 : 0;
        img.set(x, y, c('dirt', 1)); img.set(x + dx, y + dy, c('dirt', 0)); img.set(x + dx * 2, y + dy * 2, c('water', 2));
        if (rng() < 0.5) img.set(x + dx * 3, y + dy * 3, c('water', 2));
      }
    }
    return img;
  }

  // ----- walls: 3/4 view: a lighter top cap, and a front face when nothing continues below -----
  function wall(kind, v, southWall, mask) {
    const ramp = kind === 'stone_wall' ? 'stone' : 'wood';
    const col = (r, t) => (kind === 'stone_wall' ? c(r, t) : mix(c(r, t), [24, 14, 8, 255], 0.42)); // timber walls: the floor's wood, darker
    const rng = mulberry(7000 + v + (southWall ? 50 : 0));
    const img = new Img(TILE, TILE);
    const cap = southWall ? TILE : 10;
    img.rect(0, 0, TILE, cap, col(ramp, 2));
    for (let x = 0; x < TILE; x++) { img.set(x, 0, col(ramp, 1)); if (!southWall) img.set(x, cap - 1, col(ramp, 1)); }
    if (kind === 'stone_wall') for (let i = 0; i < 5; i++) img.set((rng() * 30) | 0, (rng() * (cap - 2)) | 0 + 1, col(ramp, 1));
    else for (let y = 2; y < cap; y += 5) for (let x = 0; x < TILE; x++) img.set(x, y, col(ramp, 1));
    if (!southWall) {
      img.rect(0, cap, TILE, TILE - cap, col(ramp, 1));
      if (kind === 'stone_wall') {
        for (let r = 0; r < 3; r++) {
          const y = cap + r * 7; const off = r % 2 ? 6 : 0;
          for (let x = 0; x < TILE; x++) img.set(x, y, col(ramp, 0));
          for (let x = off; x < TILE; x += 12) for (let j = 1; j < 7; j++) img.set(x, y + j, col(ramp, 0));
          for (let i = 0; i < 3; i++) img.set((rng() * 30) | 0, y + 2 + ((rng() * 4) | 0), col(ramp, i % 2 ? 2 : 0));
        }
      } else {
        for (let x = 0; x < TILE; x += 8) for (let y = cap; y < TILE; y++) img.set(x, y, col(ramp, 0));
        for (let x = 3; x < TILE; x += 8) for (let y = cap + 2; y < TILE - 4; y += 7) img.set(x, y, col(ramp, 2));
        for (let i = 0; i < 4; i++) img.set((rng() * 30) | 0, cap + 2 + ((rng() * 16) | 0), col(ramp, 0));
      }
      for (let x = 0; x < TILE; x++) { img.set(x, TILE - 1, col(ramp, 0)); img.set(x, TILE - 2, col(ramp, 0)); } // the shadow where it meets the ground
    }
    // vertical edges where the wall ends sideways
    if (!(mask & W)) for (let y = 0; y < TILE; y++) img.set(0, y, pal.outline(ramp));
    if (!(mask & E)) for (let y = 0; y < TILE; y++) img.set(TILE - 1, y, pal.outline(ramp));
    if (!(mask & N)) for (let x = 0; x < TILE; x++) img.set(x, 0, pal.outline(ramp));
    return img;
  }

  function door(v, southWall) {
    const img = new Img(TILE, TILE);
    img.rect(0, 0, TILE, 9, c('wood', 2));
    for (let x = 0; x < TILE; x++) img.set(x, 0, c('wood', 1));
    img.rect(0, 9, 3, TILE - 9, c('wood', 1)); img.rect(TILE - 3, 9, 3, TILE - 9, c('wood', 1)); // the frame
    img.rect(3, 9, TILE - 6, TILE - 9, c('stone', 0));
    for (let x = 3; x < TILE - 3; x++) img.set(x, 9, pal.outline('wood'));
    for (let y = 9; y < TILE; y++) { img.set(3, y, c('wood', 0)); img.set(TILE - 4, y, c('wood', 0)); }
    img.rect(3, TILE - 4, TILE - 6, 4, c('stone', 1)); // the threshold
    return img;
  }

  function fence(v, mask) {
    const img = new Img(TILE, TILE);
    const horiz = mask & (E | W); const vert = mask & (N | S);
    const post = (x, y) => { img.rect(x - 1, y - 8, 3, 12, c('wood', 1)); img.rect(x - 1, y - 8, 1, 12, c('wood', 2)); img.rect(x + 1, y - 8, 1, 12, c('wood', 0)); img.rect(x - 1, y + 4, 3, 1, pal.outline('wood')); };
    if (horiz || !vert) {
      const x0 = mask & W ? 0 : 14; const x1 = mask & E ? TILE : 18;
      for (const y of [17, 23]) { img.rect(x0, y, x1 - x0, 2, c('wood', 1)); img.rect(x0, y, x1 - x0, 1, c('wood', 2)); img.rect(x0, y + 2, x1 - x0, 1, c('wood', 0)); }
    }
    if (vert) {
      const y0 = mask & N ? 0 : 14; const y1 = mask & S ? TILE : 24;
      img.rect(14, y0, 4, y1 - y0, c('wood', 1)); img.rect(14, y0, 1, y1 - y0, c('wood', 2)); img.rect(17, y0, 1, y1 - y0, c('wood', 0));
    }
    post(16, 24);
    return img;
  }

  // ----- the producer -----
  /** Neighbour mask for ground autotiling: a bit is set where the neighbour is NOT of the same family. */
  function groundMask(grid, tx, ty, family) {
    const m = (x, y) => {
      if (x < 0 || y < 0 || x >= grid.W || y >= grid.H) return 0;
      return FAMILY[grid.ground[y][x]] === family ? 0 : 1;
    };
    return (m(tx, ty - 1) ? N : 0) | (m(tx + 1, ty) ? E : 0) | (m(tx, ty + 1) ? S : 0) | (m(tx - 1, ty) ? W : 0);
  }

  const isWallish = (s) => s === 'stone_wall' || s === 'timber_wall' || s === 'door';

  /** The ground tile (material + autotile edges) at tx, ty. frame animates water. */
  function ground(grid, tx, ty, frame = 0) {
    const mat = grid.ground[ty][tx];
    const v = ((tx * 7 + ty * 13) & 3);
    const family = FAMILY[mat] ?? 'grass';
    let mask = groundMask(grid, tx, ty, family);
    // a path next to a building floor or the square is cut by their edge, not by grass: only grass neighbours fringe
    if (mat === 'dirt_path' || mat === 'dirt') {
      mask = 0;
      const g = (x, y) => (x >= 0 && y >= 0 && x < grid.W && y < grid.H && grid.ground[y][x] === 'grass' ? 1 : 0);
      mask = (g(tx, ty - 1) ? N : 0) | (g(tx + 1, ty) ? E : 0) | (g(tx, ty + 1) ? S : 0) | (g(tx - 1, ty) ? W : 0);
    }
    if (mat === 'water') {
      const w = (x, y) => (x < 0 || y < 0 || x >= grid.W || y >= grid.H ? 0 : grid.ground[y][x] === 'water' ? 0 : 1);
      mask = (w(tx, ty - 1) ? N : 0) | (w(tx + 1, ty) ? E : 0) | (w(tx, ty + 1) ? S : 0) | (w(tx - 1, ty) ? W : 0);
    }
    const key = `g|${mat}|${v}|${mask}|${mat === 'water' ? frame % WATER_FRAMES : 0}`;
    let img = cache.get(key);
    if (!img) {
      switch (mat) {
        case 'dirt_path': img = dirtish('dirt', v, mask, true); break;
        case 'dirt': img = dirtish('dirt', v, mask, mask > 0); break;
        case 'cobble': img = cobble(v, 0); break;
        case 'wood_floor': img = planks(v); break;
        case 'stone_floor': img = slabs(v); break;
        case 'water': img = water(v, mask, frame % WATER_FRAMES); break;
        default: img = grass(v);
      }
      cache.set(key, img);
    }
    return img;
  }

  /** The structure tile (wall, door, fence) at tx, ty, or null. */
  function structure(grid, tx, ty) {
    const s = grid.structure[ty][tx];
    if (!s || s === 'tree' || s === 'bush') return null;
    const at = (x, y) => (x < 0 || y < 0 || x >= grid.W || y >= grid.H ? null : grid.structure[y][x]);
    const v = ((tx * 5 + ty * 11) & 3);
    if (s === 'stone_wall' || s === 'timber_wall') {
      const mask = (isWallish(at(tx, ty - 1)) ? N : 0) | (isWallish(at(tx + 1, ty)) ? E : 0) | (isWallish(at(tx - 1, ty)) ? W : 0);
      const southWall = isWallish(at(tx, ty + 1)) && at(tx, ty + 1) !== 'door';
      const key = `w|${s}|${v}|${mask}|${southWall}`;
      let img = cache.get(key);
      if (!img) { img = wall(s, v, southWall, mask); cache.set(key, img); }
      return img;
    }
    if (s === 'door') {
      const key = 'd';
      let img = cache.get(key);
      if (!img) { img = door(0, false); cache.set(key, img); }
      return img;
    }
    if (s === 'fence') {
      const f = (x, y) => (at(x, y) === 'fence' ? 1 : 0);
      const mask = (f(tx, ty - 1) ? N : 0) | (f(tx + 1, ty) ? E : 0) | (f(tx, ty + 1) ? S : 0) | (f(tx - 1, ty) ? W : 0);
      const key = `f|${mask}`;
      let img = cache.get(key);
      if (!img) { img = fence(0, mask); cache.set(key, img); }
      return img;
    }
    return null;
  }

  /**
   * step 9: a FRONT wall is the south wall of a building (a wall or door tile with the room's floor right behind it,
   * to the north). In the 3/4 view it stands in front of the people inside: the scene draws it as a tall y-sorted
   * entity (wallFront) instead of painting it into the ground chunk.
   */
  function isFrontWall(grid, tx, ty) {
    const s = grid.structure[ty]?.[tx];
    if (s !== 'stone_wall' && s !== 'timber_wall' && s !== 'door') return false;
    const n = grid.structure[ty - 1]?.[tx];
    return grid.roomAt[ty - 1]?.[tx]?.kind === 'building' && n !== 'stone_wall' && n !== 'timber_wall' && n !== 'door';
  }

  /** The tall version of a front-wall tile: the face continues WALL_H px upward, so it hides the legs behind it. */
  function wallFront(grid, tx, ty) {
    const base = structure(grid, tx, ty);
    if (!base) return null;
    const s = grid.structure[ty][tx];
    const key = `front|${s}|${tx * 7 + ty * 13 & 3}|${grid.structure[ty][tx - 1]}|${grid.structure[ty][tx + 1]}`;
    let img = cache.get(key);
    if (img) return { img, h: img.h };
    img = new Img(TILE, TILE + WALL_H);
    // the face material: for a door, the wall next to it
    const faceKind = s === 'door' ? (['stone_wall', 'timber_wall'].includes(grid.structure[ty][tx - 1]) ? grid.structure[ty][tx - 1] : grid.structure[ty][tx + 1] ?? 'timber_wall') : s;
    const face = s === 'door' ? (structure({ ...grid, structure: grid.structure.map((row, y) => (y === ty ? row.map((v, x) => (x === tx ? faceKind : v)) : row)) }, tx, ty) ?? base) : base;
    const cap = 10;
    img.blit(face.crop(0, 0, TILE, cap), 0, 0);                          // the top of the wall
    for (let y = cap; y < cap + WALL_H; y++) img.blit(face.crop(0, cap + ((y - cap) % 18), TILE, 1), 0, y); // the face, repeated upward
    img.blit(base, 0, WALL_H);                                            // the tile itself (with the door opening)
    cache.set(key, img);
    return { img, h: img.h };
  }

  /** A full chunk of tiles (cx, cy in chunk units of `size` tiles) rendered into one canvas-sized Img. */
  function chunk(grid, cx, cy, size = 16, frame = 0, opts = {}) {
    const skipFront = opts.skipFrontWalls !== false;
    const img = new Img(size * TILE, size * TILE);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const tx = cx * size + i; const ty = cy * size + j;
        if (tx >= grid.W || ty >= grid.H) continue;
        img.blit(ground(grid, tx, ty, frame), i * TILE, j * TILE);
        const st = skipFront && isFrontWall(grid, tx, ty) ? null : structure(grid, tx, ty);
        if (st) img.blit(st, i * TILE, j * TILE);
      }
    }
    return img;
  }

  /** The old chunk with every wall painted in (the map preview). */
  const chunkWithWalls = (grid, cx, cy, size = 16, frame = 0) => chunk(grid, cx, cy, size, frame, { skipFrontWalls: false });

  return { ground, structure, chunk, chunkWithWalls, wallFront, isFrontWall, cache };
}
