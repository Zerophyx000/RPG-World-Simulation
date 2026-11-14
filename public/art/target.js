// Step 8: drawing targets. The scene draws through this tiny interface so the same renderer runs in two places:
//   CanvasTarget  the browser: sprites are cached as offscreen canvases and drawn with drawImage, smoothing OFF,
//                 at integer (or 0.5 / 0.25) scales, which is what keeps pixel art crisp and 60 fps cheap
//   ImgTarget     Node: a software renderer onto an `Img`, used for screenshots (PNG), the art gallery tests and the
//                 acceptance checks. Slow, exact, no browser needed.
// Interface (all coordinates are SCREEN pixels):
//   blit(img, x, y, { scale = 1, flipX, alpha })   rect(x, y, w, h, color, alpha)   ellipse(cx, cy, rx, ry, color, alpha)
//   ring(cx, cy, rx, ry, color)                      ambient(color, alpha, lights[{ x, y, r, k }]) (banded)
//   warm(x, y, r, color, alpha) (added warm light near fires)
import { Img } from './pixels.js';

// step 9: light falls off in bands: [radius fraction, share of the darkness removed]
const BANDS = [[1, 0.25], [0.78, 0.5], [0.56, 0.75], [0.34, 1]];
const rgba = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${((c[3] ?? 255) / 255) * a})`;

export class CanvasTarget {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.w = canvas.width;
    this.h = canvas.height;
    this.layer = null;
  }

  resize(w, h) {
    this.canvas.width = w; this.canvas.height = h;
    this.w = w; this.h = h;
    this.layer = null;
  }

  begin() {
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.globalAlpha = 1;
    this.ctx.globalCompositeOperation = 'source-over';
  }

  static canvasOf(img) {
    if (!img.canvas) {
      img.canvas = document.createElement('canvas');
      img.canvas.width = img.w; img.canvas.height = img.h;
      img.canvasVersion = -1;
    }
    if (img.canvasVersion !== img.version) {
      const g = img.canvas.getContext('2d');
      g.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.w, img.h), 0, 0);
      img.canvasVersion = img.version;
    }
    return img.canvas;
  }

  blit(img, x, y, { scale = 1, flipX = false, alpha = 1 } = {}) {
    const c = this.ctx;
    const cv = CanvasTarget.canvasOf(img);
    if (alpha !== 1) c.globalAlpha = alpha;
    const w = img.w * scale; const h = img.h * scale;
    if (flipX) {
      c.save(); c.translate(Math.round(x) + w, Math.round(y)); c.scale(-1, 1);
      c.drawImage(cv, 0, 0, w, h); c.restore();
    } else c.drawImage(cv, Math.round(x), Math.round(y), w, h);
    if (alpha !== 1) c.globalAlpha = 1;
  }

  rect(x, y, w, h, color, alpha = 1) {
    this.ctx.fillStyle = rgba(color, alpha);
    this.ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  ellipse(cx, cy, rx, ry, color, alpha = 1) {
    const c = this.ctx;
    c.fillStyle = rgba(color, alpha);
    c.beginPath(); c.ellipse(Math.round(cx), Math.round(cy), Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2); c.fill();
  }

  ring(cx, cy, rx, ry, color) {
    const c = this.ctx;
    c.strokeStyle = rgba(color); c.lineWidth = 2;
    c.beginPath(); c.ellipse(Math.round(cx), Math.round(cy), rx, ry, 0, 0, Math.PI * 2); c.stroke();
  }

  /**
   * Night tint with holes for light sources (step 9: cut in stepped bands, so light falls off like pixel art).
   * Each light removes 25 / 62 / 91 / 100 % of the darkness in four rings.
   */
  ambient(color, alpha, lights = []) {
    if (alpha <= 0.01) return;
    if (!this.layer || this.layer.width !== this.w || this.layer.height !== this.h) {
      this.layer = document.createElement('canvas'); this.layer.width = this.w; this.layer.height = this.h;
    }
    const L = this.layer.getContext('2d');
    L.globalCompositeOperation = 'source-over';
    L.clearRect(0, 0, this.w, this.h);
    L.fillStyle = rgba(color, alpha); L.fillRect(0, 0, this.w, this.h);
    L.globalCompositeOperation = 'destination-out';
    for (const l of lights) {
      const k = Math.min(1, l.k ?? 1);
      for (const [f, s] of BANDS) {
        L.fillStyle = `rgba(0,0,0,${Math.min(1, k * s)})`;
        L.beginPath(); L.arc(Math.round(l.x), Math.round(l.y), Math.max(1, l.r * f), 0, Math.PI * 2); L.fill();
      }
    }
    this.ctx.drawImage(this.layer, 0, 0);
  }

  /** A warm glow around a light (stepped discs, added light). */
  warm(x, y, r, color, alpha) {
    if (alpha <= 0.005 || r <= 1) return;
    const c = this.ctx;
    c.globalCompositeOperation = 'lighter';
    for (const f of [1, 0.66, 0.36]) {
      c.fillStyle = rgba(color, alpha * 0.45);
      c.beginPath(); c.arc(Math.round(x), Math.round(y), r * f, 0, Math.PI * 2); c.fill();
    }
    c.globalCompositeOperation = 'source-over';
  }
}

/** Software target for Node: draws onto an Img (screenshots, tests). */
export class ImgTarget {
  constructor(w, h, bg = [20, 24, 20, 255]) {
    this.img = new Img(w, h).fill(bg);
    this.w = w;
    this.h = h;
  }

  begin() {}

  blit(src, x, y, { scale = 1, flipX = false, alpha = 1 } = {}) {
    x = Math.round(x); y = Math.round(y);
    const dw = Math.max(1, Math.round(src.w * scale)); const dh = Math.max(1, Math.round(src.h * scale));
    const x0 = Math.max(0, -x); const x1 = Math.min(dw, this.w - x); const y0 = Math.max(0, -y); const y1 = Math.min(dh, this.h - y);
    const dst = this.img.data;
    for (let j = y0; j < y1; j++) {
      const sy = Math.min(src.h - 1, Math.floor(j / scale));
      for (let i = x0; i < x1; i++) {
        let sx = Math.min(src.w - 1, Math.floor(i / scale));
        if (flipX) sx = src.w - 1 - sx;
        const si = (sy * src.w + sx) * 4; const a = src.data[si + 3];
        if (!a) continue;
        const di = ((y + j) * this.w + (x + i)) * 4;
        const k = (a / 255) * alpha;
        if (k >= 0.999) { dst[di] = src.data[si]; dst[di + 1] = src.data[si + 1]; dst[di + 2] = src.data[si + 2]; dst[di + 3] = 255; continue; }
        for (let q = 0; q < 3; q++) dst[di + q] = Math.round(src.data[si + q] * k + dst[di + q] * (1 - k));
        dst[di + 3] = 255;
      }
    }
  }

  rect(x, y, w, h, color, alpha = 1) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    const k = ((color[3] ?? 255) / 255) * alpha;
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++) {
      for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) {
        const di = (j * this.w + i) * 4; const d = this.img.data;
        for (let q = 0; q < 3; q++) d[di + q] = Math.round(color[q] * k + d[di + q] * (1 - k));
      }
    }
  }

  ellipse(cx, cy, rx, ry, color, alpha = 1) {
    const k = ((color[3] ?? 255) / 255) * alpha; const d = this.img.data;
    for (let j = Math.floor(cy - ry); j <= Math.ceil(cy + ry); j++) {
      for (let i = Math.floor(cx - rx); i <= Math.ceil(cx + rx); i++) {
        if (i < 0 || j < 0 || i >= this.w || j >= this.h) continue;
        const dx = (i + 0.5 - cx) / rx; const dy = (j + 0.5 - cy) / ry;
        if (dx * dx + dy * dy > 1) continue;
        const di = (j * this.w + i) * 4;
        for (let q = 0; q < 3; q++) d[di + q] = Math.round(color[q] * k + d[di + q] * (1 - k));
      }
    }
  }

  ring(cx, cy, rx, ry, color) {
    for (let a = 0; a < 360; a += 3) {
      const r = (a * Math.PI) / 180;
      const x = Math.round(cx + Math.cos(r) * rx); const y = Math.round(cy + Math.sin(r) * ry);
      this.rect(x, y, 2, 2, color, 1);
    }
  }

  ambient(color, alpha, lights = []) {
    if (alpha <= 0.01) return;
    const d = this.img.data;
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        let hole = 0;
        for (const l of lights) {
          const dist = Math.hypot(i - l.x, j - l.y);
          if (dist >= l.r) continue;
          // stepped bands with a dithered edge between them (checkerboard on the boundary)
          const f = 1 - dist / l.r; const k = Math.min(1, l.k ?? 1);
          const dith = (i + j) % 2 ? 0.04 : -0.04;
          let h = 0;
          for (const [rf, s] of BANDS) if (f + dith >= 1 - rf) h = 1 - (1 - h) * (1 - k * s);
          hole = Math.max(hole, h);
        }
        const k = alpha * (1 - Math.min(1, hole));
        const di = (j * this.w + i) * 4;
        for (let q = 0; q < 3; q++) d[di + q] = Math.round(color[q] * k + d[di + q] * (1 - k));
      }
    }
  }

  warm(x, y, r, color, alpha) {
    if (alpha <= 0.005 || r <= 1) return;
    const d = this.img.data;
    for (let j = Math.max(0, Math.floor(y - r)); j < Math.min(this.h, Math.ceil(y + r)); j++) {
      for (let i = Math.max(0, Math.floor(x - r)); i < Math.min(this.w, Math.ceil(x + r)); i++) {
        const f = 1 - Math.hypot(i - x, j - y) / r;
        if (f <= 0) continue;
        const a = alpha * 0.45 * (f > 0.64 ? 3 : f > 0.34 ? 2 : 1);
        const di = (j * this.w + i) * 4;
        for (let q = 0; q < 3; q++) d[di + q] = Math.min(255, d[di + q] + color[q] * a);
      }
    }
  }
}

