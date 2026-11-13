// Step 8: pixel buffers. Every sprite, tile and effect is an `Img` (RGBA bytes) built by code, so the same art
// code runs in the browser (an Img becomes a cached offscreen canvas) and in Node (art gallery and screenshots as
// PNG for checking by eye). Colours are [r, g, b, a] arrays; the palette hands them out.
import { mulberry } from './rand.js';

export class Img {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4);
    this.version = 0;      // bumped when the pixels change (canvas caches watch it)
    this.canvas = null;
  }

  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    const i = (y * this.w + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  alphaAt(x, y) {
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? 0 : this.data[(y * this.w + x) * 4 + 3];
  }

  set(x, y, c) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || !c) return this;
    const i = (y * this.w + x) * 4;
    this.data[i] = c[0]; this.data[i + 1] = c[1]; this.data[i + 2] = c[2]; this.data[i + 3] = c[3] ?? 255;
    return this;
  }

  /** Source-over a pixel with partial alpha. */
  over(x, y, c, a = 1) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || !c) return this;
    const i = (y * this.w + x) * 4;
    const sa = ((c[3] ?? 255) / 255) * a;
    if (sa >= 0.999) return this.set(x, y, c);
    const da = this.data[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return this;
    for (let k = 0; k < 3; k++) this.data[i + k] = Math.round((c[k] * sa + this.data[i + k] * da * (1 - sa)) / oa);
    this.data[i + 3] = Math.round(oa * 255);
    return this;
  }

  fill(c) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.set(x, y, c);
    return this;
  }

  rect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
    return this;
  }

  /** Filled ellipse inscribed in the box x, y, w, h. */
  ellipse(x, y, w, h, c) {
    const cx = x + w / 2; const cy = y + h / 2;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const dx = (i + 0.5 - w / 2) / (w / 2); const dy = (j + 0.5 - h / 2) / (h / 2);
        if (dx * dx + dy * dy <= 1.0) this.set(x + i, y + j, c);
      }
    }
    return this;
  }

  line(x0, y0, x1, y1, c) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0); const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1; const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
    return this;
  }

  /** Scanline polygon fill. points: [[x, y], ...] */
  poly(points, c) {
    const ys = points.map((p) => p[1]);
    const y0 = Math.floor(Math.min(...ys)); const y1 = Math.ceil(Math.max(...ys));
    for (let y = y0; y <= y1; y++) {
      const xs = [];
      for (let i = 0; i < points.length; i++) {
        const [ax, ay] = points[i]; const [bx, by] = points[(i + 1) % points.length];
        if ((ay <= y + 0.5 && by > y + 0.5) || (by <= y + 0.5 && ay > y + 0.5)) xs.push(ax + ((y + 0.5 - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.round(xs[k]); x < Math.round(xs[k + 1]); x++) this.set(x, y, c);
    }
    return this;
  }

  /** Draw another image on this one. opts: { flipX, alpha, tint: [r,g,b], tintAmount, replace } */
  blit(src, x, y, opts = {}) {
    const { flipX = false, alpha = 1 } = opts;
    for (let j = 0; j < src.h; j++) {
      for (let i = 0; i < src.w; i++) {
        const si = (j * src.w + (flipX ? src.w - 1 - i : i)) * 4;
        const a = src.data[si + 3];
        if (!a) continue;
        let c = [src.data[si], src.data[si + 1], src.data[si + 2], a];
        if (opts.tint) c = mix(c, opts.tint, opts.tintAmount ?? 0.5);
        if (alpha >= 1 && a === 255) this.set(x + i, y + j, c);
        else this.over(x + i, y + j, c, alpha);
      }
    }
    return this;
  }

  clone() {
    const o = new Img(this.w, this.h);
    o.data.set(this.data);
    return o;
  }

  crop(x, y, w, h) {
    const o = new Img(w, h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) o.set(i, j, this.get(x + i, y + j));
    return o;
  }

  /** Integer upscale (nearest neighbour). */
  scale(n) {
    const o = new Img(this.w * n, this.h * n);
    for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) o.set(x, y, this.get((x / n) | 0, (y / n) | 0));
    return o;
  }

  /** Per-pixel transform of visible pixels: fn(c, x, y) → colour | null. */
  map(fn) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = (y * this.w + x) * 4;
        if (!this.data[i + 3]) continue;
        const r = fn([this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]], x, y);
        if (r) { this.data[i] = r[0]; this.data[i + 1] = r[1]; this.data[i + 2] = r[2]; this.data[i + 3] = r[3] ?? this.data[i + 3]; } else this.data[i + 3] = 0;
      }
    }
    return this;
  }

  /** Move toward a colour (a fever's pallor, a bruise). */
  tint(color, amount) {
    return this.map((c) => mix(c, color, amount));
  }

  desaturate(amount = 1) {
    return this.map((c) => {
      const g = Math.round(c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11);
      return mix(c, [g, g, g, c[3]], amount);
    });
  }

  /** A 1-px outline around everything visible, in the given colour (or by `pick(neighbourColour)`). */
  outline(color) {
    const add = [];
    for (let y = -1; y <= this.h; y++) {
      for (let x = -1; x <= this.w; x++) {
        if (this.alphaAt(x, y)) continue;
        let near = null;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (this.alphaAt(x + dx, y + dy) > 128) { near = this.get(x + dx, y + dy); break; }
        if (near && x >= 0 && y >= 0 && x < this.w && y < this.h) add.push([x, y, typeof color === 'function' ? color(near) : color]);
      }
    }
    for (const [x, y, c] of add) this.set(x, y, c);
    return this;
  }

  /** Expanded copy with `pad` transparent pixels on every side. */
  padded(pad) {
    const o = new Img(this.w + pad * 2, this.h + pad * 2);
    o.blit(this, pad, pad);
    return o;
  }

  touch() {
    this.version++;
    return this;
  }
}

export function mix(a, b, t) {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t), a[3] ?? 255];
}

export const hex = (s) => {
  const n = parseInt(String(s).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
};

/** A stable pseudo-random generator from any string or number. */
export function rngFor(key) {
  let h = 2166136261;
  for (const ch of String(key)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return mulberry(h >>> 0);
}
