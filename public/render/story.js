// Step 9: story overlays (god view only, quality 'overlays'). Drawn over the people, in pixel lines:
//   tension     red between two people present when anger, fear or distrust (trust <= -2) runs between them;
//               thicker with intensity
//   affection   a soft pink dotted line
//   envy        a green arc, jealousy a purple arc with a dot on the beloved
//   watching    a faint dotted grey line from someone following or staring at another
//   event pins  where key things happened (death, director events, injuries, critical bleeding, thefts), fading over
//               three game days; clickable (they become 'pin' hits for the map view)
//   storyline   a storyline focused in the Story view: gold rings around its people and the rooms they are in
//   rumors      a hook for the knowledge step (rumor.add), drawn later
// Read-only: everything comes from S.social, S.events, S.observer.
import { Img } from '../art/pixels.js';
import { TILE } from '../art/mapdata.js';
import { hash32 } from '../art/rand.js';

const RED = [214, 64, 58, 255];
const PINK = [236, 140, 190, 255];
const GREEN = [96, 186, 92, 255];
const PURPLE = [168, 110, 220, 255];
const GREY = [190, 190, 200, 255];
const GOLD = [236, 196, 90, 255];
const PIN_COLORS = { death: [200, 200, 205, 255], blast: [236, 140, 50, 255], injury: [214, 64, 58, 255], critical: [255, 70, 70, 255], theft: [168, 110, 220, 255] };
const DAYS3 = 4320;

export function createStory(ctx) {
  const { layout, quality } = ctx;
  const pinCache = new Map();

  function pinImg(kind) {
    let img = pinCache.get(kind);
    if (img) return img;
    img = new Img(9, 12);
    const c = PIN_COLORS[kind] ?? GOLD;
    img.ellipse(0, 0, 9, 9, c);
    for (let y = 8; y < 12; y++) img.set(4, y, [60, 60, 66, 255]);
    if (kind === 'death') { img.rect(3, 2, 3, 3, [40, 40, 44, 255]); img.set(3, 5, [40, 40, 44, 255]); img.set(5, 5, [40, 40, 44, 255]); }
    else img.rect(3, 2, 3, 3, [255, 255, 255, 200]);
    img.outline([20, 18, 22, 255]);
    pinCache.set(kind, img);
    return img;
  }

  /** A pixel line from a to b (screen px), dashed by `dash` = [on, off] or solid, `w` px thick. */
  function line(F, ax, ay, bx, by, color, { w = 1, dash = null, alpha = 0.85 } = {}) {
    const dx = bx - ax; const dy = by - ay;
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / Math.max(1, w)));
    for (let i = 0; i <= n; i++) {
      if (dash && (i % (dash[0] + dash[1])) >= dash[0]) continue;
      F.target.rect(Math.round(ax + (dx * i) / n - w / 2), Math.round(ay + (dy * i) / n - w / 2), w, w, color, alpha);
    }
  }
  function arc(F, ax, ay, bx, by, color, bulge) {
    const mx = (ax + bx) / 2; const my = (ay + by) / 2;
    const nx = -(by - ay); const ny = bx - ax; const nl = Math.hypot(nx, ny) || 1;
    const cx = mx + (nx / nl) * bulge; const cy = my + (ny / nl) * bulge;
    let px = ax; let py = ay;
    for (let i = 1; i <= 12; i++) {
      const t = i / 12; const x = (1 - t) ** 2 * ax + 2 * (1 - t) * t * cx + t * t * bx; const y = (1 - t) ** 2 * ay + 2 * (1 - t) * t * cy + t * t * by;
      line(F, px, py, x, y, color, { w: 1, alpha: 0.85 });
      px = x; py = y;
    }
  }

  function pinKind(e, S) {
    const d = e.data ?? {};
    if (e.type === 'death') return 'death';
    if (e.type === 'director' && d.action === 'event') return 'blast';
    if (e.type === 'director_effect') return 'blast';
    if (e.type === 'injury') return 'injury';
    if (e.type === 'critical_window') return 'critical';
    if (e.type === 'notice') return 'theft';
    if (e.type === 'object' && ['take', 'steal'].includes(d.action)) {
      const owner = S.objects?.get(d.objectId)?.ownerId;
      if (owner && owner !== (e.actorId ?? e.actor_id)) return 'theft';
    }
    // fights come with a later step
    return null;
  }

  return {
    id: 'story',
    rumor: { pulses: [], add(fromId, toId) { this.pulses.push({ fromId, toId, at: Date.now() }); } }, // filled by the knowledge step
    overEntities(F) {
      const S = F.S;
      if (!S.god || !quality?.get('overlays') || F.lod) return;
      const z = F.z;
      const at = (id) => { const p = F.people.get(id); return p ? { x: F.X(p.x), y: F.Y(p.y - 18), p } : null; };
      // relationship lines (both directions merged for tension and affection)
      const merged = new Map();
      for (const pr of S.social?.pairs ?? []) {
        const a = at(pr.from); const b = at(pr.to);
        if (!a || !b || a.p.roomId == null || F.map.id !== (layout.geom(a.p.roomId)?.map.id ?? F.map.id)) continue;
        const key = pr.from < pr.to ? `${pr.from}|${pr.to}` : `${pr.to}|${pr.from}`;
        const m = merged.get(key) ?? { a: pr.from < pr.to ? a : b, b: pr.from < pr.to ? b : a, tension: 0, affection: 0 };
        m.tension = Math.max(m.tension, pr.anger >= 3 ? pr.anger : 0, pr.fear >= 3 ? pr.fear : 0, pr.trust <= -2 ? -pr.trust * 2 : 0);
        m.affection = Math.max(m.affection, pr.affection >= 5 ? pr.affection : 0);
        merged.set(key, m);
        if (pr.envy >= 3) arc(F, a.x, a.y, b.x, b.y, GREEN, 18 * z);
        if (pr.jealousy >= 3) {
          arc(F, a.x, a.y, b.x, b.y, PURPLE, -18 * z);
          const bel = pr.beloved && at(pr.beloved);
          if (bel) F.target.rect(bel.x - 2 * z, bel.y - 14 * z, 4 * z, 4 * z, PURPLE, 0.95);
        }
      }
      for (const m of merged.values()) {
        if (m.tension) line(F, m.a.x, m.a.y, m.b.x, m.b.y, RED, { w: Math.max(1, Math.min(3, Math.round(m.tension / 3))) });
        if (m.affection) line(F, m.a.x, m.a.y + 3, m.b.x, m.b.y + 3, PINK, { w: 1, dash: [2, 1] });
      }
      for (const w of S.social?.watching ?? []) {
        const a = at(w.from); const b = at(w.to);
        if (a && b) line(F, a.x, a.y - 6, b.x, b.y - 6, GREY, { w: 1, dash: [1, 2], alpha: 0.55 });
      }
      // event pins
      const used = new Map();
      for (const e of S.events ?? []) {
        const t = e.gameTime ?? e.game_time ?? 0;
        if (F.now - t > DAYS3) break; // newest first
        if (F.now - t < -5) continue;
        if (S.pinFilter?.has(e.type)) continue;
        const kind = pinKind(e, S);
        const room = e.location ?? e.data?.roomId;
        if (!kind || !room) continue;
        const g = layout.geom(room);
        if (!g || g.map.id !== F.map.id) continue;
        const n = used.get(room) ?? 0; used.set(room, n + 1);
        if (n > 6) continue;
        const r = g.room.rect;
        const h = hash32(String(e.id));
        const wx = (r.x + r.w / 2) * TILE + ((n % 4) - 1.5) * 14 + (h % 7) - 3; const wy = (r.y + r.h / 2) * TILE - Math.floor(n / 4) * 16;
        if (!F.inView(wx, wy)) continue;
        const age = Math.max(0, F.now - t);
        let alpha = 1 - (age / DAYS3) * 0.75;
        if (kind === 'critical') alpha *= 0.65 + 0.35 * Math.sin(F.ms / 200);
        const img = pinImg(kind);
        const x = F.X(wx) - (img.w * z) / 2; const y = F.Y(wy) - img.h * z;
        F.target.blit(img, x, y, { scale: z, alpha });
        const who = e.actorId ?? e.actor_id;
        const label = `${kind === 'blast' ? 'event' : kind}${who ? `: ${S.citizens?.get(who)?.name ?? who}` : ''}${e.data?.texts?.here ? ` — ${String(e.data.texts.here).slice(0, 50)}` : ''}`;
        F.hits.push({ type: 'pin', id: e.id, event: { ...e, actorId: who }, label, x, y, w: img.w * z, h: img.h * z });
      }
      // storyline highlight
      if (S.storylineFocus) {
        const th = (S.observer?.threads ?? []).find((x) => x.id === S.storylineFocus);
        if (th) {
          const rooms = new Set();
          for (const id of th.involved ?? []) {
            const p = F.people.get(id);
            if (!p) continue;
            F.target.ring(F.X(p.x), F.Y(p.y - 2), 17 * z, 7 * z, GOLD);
            if (p.c.location) rooms.add(p.c.location);
          }
          for (const rid of rooms) {
            const g = layout.geom(rid); if (!g) continue;
            const r = g.room.rect;
            const x = F.X(r.x * TILE); const y = F.Y(r.y * TILE); const w = r.w * TILE * z; const h = r.h * TILE * z;
            for (const [rx, ry, rw, rh] of [[x, y, w, 2], [x, y + h - 2, w, 2], [x, y, 2, h], [x + w - 2, y, 2, h]]) F.target.rect(rx, ry, rw, rh, GOLD, 0.7);
          }
        }
      }
    },
  };
}
