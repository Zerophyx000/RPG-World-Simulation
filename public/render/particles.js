// Step 9: particles. A small pooled system in WORLD pixels: sparks off the anvil, flour from the dough, z's above
// sleepers, dust at the feet, smoke puffs, rain splashes, fireflies, dust motes, falling soot. emit() adds some,
// overEntities(F) moves and draws them. Quality: off on low (emit does nothing), capped by quality.budget('particles').
const KINDS = {
  //          count       life ms        speed            gravity  size  colour [ramp, tone]   alpha
  spark: { n: [4, 7], life: [250, 450], v: [40, 90], up: 0.8, g: 220, size: 1, color: ['fire', 2], a: 1 },
  flour: { n: [4, 6], life: [600, 900], v: [8, 22], up: 0.6, g: -6, size: 2, color: ['flour', 2], a: 0.8 },
  z: { n: [1, 1], life: [1500, 1500], v: [0, 0], up: 0, g: 0, size: 3, color: null, a: 0.9 },
  dust: { n: [2, 4], life: [350, 450], v: [6, 16], up: 0.3, g: 0, size: 2, color: ['dirt', 2], a: 0.6 },
  smoke: { n: [1, 2], life: [1500, 2500], v: [4, 8], up: 1, g: -10, size: 3, color: ['smoke', 1], a: 0.45 },
  splash: { n: [3, 4], life: [180, 240], v: [20, 40], up: 0.5, g: 120, size: 1, color: ['water', 2], a: 0.9 },
  firefly: { n: [1, 1], life: [3000, 5000], v: [4, 10], up: 0, g: 0, size: 1, color: ['gold', 2], a: 1 },
  mote: { n: [1, 1], life: [4000, 6000], v: [2, 5], up: 0, g: -1, size: 1, color: ['flour', 2], a: 0.35 },
  soot: { n: [2, 3], life: [900, 1100], v: [2, 6], up: -0.5, g: 12, size: 1, color: ['black', 0], a: 0.8 },
};
const Z_COLOR = [150, 180, 245, 255];

export function createParticles(ctx) {
  const { pal, quality } = ctx;
  const pool = [];      // reusable particle objects
  const live = [];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const range = ([a, b]) => a + (b - a) * rnd();

  function emit(kind, wx, wy, opts = {}) {
    if (!quality?.get('particles')) return;
    const k = KINDS[kind];
    if (!k) return;
    const cap = quality.budget?.('particles') ?? 250;
    const n = opts.count ?? Math.round(range(k.n));
    for (let i = 0; i < n; i++) {
      if (live.length >= cap) { pool.push(live.shift()); }
      const p = pool.pop() ?? {};
      const ang = rnd() * Math.PI * 2;
      const sp = range(k.v);
      p.kind = kind; p.x = wx + (rnd() - 0.5) * 4; p.y = wy + (rnd() - 0.5) * 3;
      p.vx = opts.vx ?? Math.cos(ang) * sp; p.vy = opts.vy ?? (Math.sin(ang) * sp * 0.5 - sp * k.up);
      p.life = opts.life ?? range(k.life); p.age = 0; p.phase = rnd() * 6.28;
      p.color = opts.color ?? (k.color ? pal.color(k.color[0], k.color[1]) : Z_COLOR);
      live.push(p);
    }
  }

  function drawZ(F, p, alpha) {
    // a tiny "z": top bar, diagonal, bottom bar (3x3)
    const x = F.X(p.x); const y = F.Y(p.y); const s = Math.max(1, F.z);
    F.target.rect(x, y, 3 * s, s, p.color, alpha);
    F.target.rect(x + s, y + s, s, s, p.color, alpha);
    F.target.rect(x, y + 2 * s, 3 * s, s, p.color, alpha);
  }

  return {
    id: 'particles',
    emit,
    count: () => live.length,
    overEntities(F) {
      if (!live.length) return;
      const dt = Math.min(0.1, F.dt);
      const wind = F.wind?.x ?? 0;
      let w = 0;
      for (let i = 0; i < live.length; i++) {
        const p = live[i];
        const k = KINDS[p.kind];
        p.age += dt * 1000;
        if (p.age >= p.life) { pool.push(p); continue; }
        if (p.kind === 'firefly' || p.kind === 'mote') { p.vx += (Math.sin(p.age / 400 + p.phase) * 6 - p.vx * 0.5) * dt; p.vy += (Math.cos(p.age / 500 + p.phase) * 4 - p.vy * 0.5) * dt; }
        if (p.kind === 'z') { p.vy = -14; p.vx = Math.sin(p.age / 250 + p.phase) * 6; }
        if (p.kind === 'smoke') p.vx += wind * 10 * dt;
        p.vy += k.g * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        live[w++] = p;
      }
      live.length = w;
      if (F.lod) return;
      for (const p of live) {
        if (!F.inView(p.x, p.y)) continue;
        const k = KINDS[p.kind];
        const t = p.age / p.life;
        let alpha = k.a * (p.kind === 'spark' ? 1 - t * 0.5 : 1 - t);
        if (p.kind === 'firefly') alpha = Math.sin(p.age / 300 + p.phase) > 0.2 ? 1 : 0.15;
        if (alpha <= 0.02) continue;
        if (p.kind === 'z') { drawZ(F, p, alpha); continue; }
        const s = k.size * F.z * (p.kind === 'smoke' ? 1 + t * 2 : 1);
        if (p.kind === 'smoke') F.target.ellipse(F.X(p.x), F.Y(p.y), s, s * 0.8, p.color, alpha);
        else F.target.rect(F.X(p.x) - s / 2, F.Y(p.y) - s / 2, Math.max(1, s), Math.max(1, s), p.color, alpha);
      }
    },
  };
}
