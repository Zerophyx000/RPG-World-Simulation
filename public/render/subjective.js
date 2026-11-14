// Step 9: the subjective camera ("through their eyes"). While following a citizen with S.subjective = { id, perception }
// (perception = GET /api/citizens/:id/perception, built by the same functions as their prompt), the map shows the
// world the way their prompt does:
//   surface view   objects they don't perceive are hidden in their room, people they don't perceive too; strangers
//                  are labelled by how they look, not by name
//   feelings       anger: a vignette narrowing toward the target, others faded; fear: dark edges, the threat outlined
//                  in red, the ways out highlighted; sadness: what reminds them glows; jealousy: the beloved and the
//                  rival stand out, everyone else fades
//   senses         blind: near darkness with voice markers and sounds as words ("footsteps, to the left"); deaf:
//                  others' speech is "…"; concussed: a jittering double image; unconscious: black; asleep: dark
// Fading follows one rule: every reason gives an alpha, the lowest wins.
import { Img } from '../art/pixels.js';
import { TILE } from '../art/mapdata.js';
import { textImg } from '../art/font.js';

const DARK = [6, 6, 12, 255];

export function createSubjective(_ctx) {
  const vignettes = new Map();
  const lastPos = new Map();
  let sounds = [];
  const textCache = new Map();
  const text = (s, color = [230, 226, 214, 255]) => { const k = `${s}|${color}`; let t = textCache.get(k); if (!t) { if (textCache.size > 200) textCache.clear(); t = textImg(s, { color, outline: [10, 10, 16, 255] }); textCache.set(k, t); } return t; };

  /** A dark frame with an elliptical clear hole (dithered ring), for a screen size and hole bucket. */
  function vignette(w, h, cx, cy, rx, ry, alpha) {
    const key = `${w}|${h}|${Math.round(cx / 8)}|${Math.round(cy / 8)}|${Math.round(rx / 8)}|${Math.round(ry / 8)}`;
    let img = vignettes.get(key);
    if (!img) {
      if (vignettes.size > 40) vignettes.clear();
      const s = 4; // built at quarter resolution and scaled up
      img = new Img(Math.ceil(w / s), Math.ceil(h / s));
      for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
        const d = ((x * s - cx) / rx) ** 2 + ((y * s - cy) / ry) ** 2;
        if (d < 1) continue;
        if (d < 1.4 && (x + y) % 2) continue; // dithered edge
        img.set(x, y, DARK);
      }
      img.s = s;
      vignettes.set(key, img);
    }
    return img;
  }
  const drawVignette = (F, cx, cy, rx, ry, alpha) => { const v = vignette(F.cam.w, F.cam.h, cx, cy, rx, ry, alpha); F.target.blit(v, 0, 0, { scale: v.s, alpha }); };

  return {
    id: 'subjective',
    update(F) {
      const sub = F.S.subjective;
      if (!sub?.id) return;
      const viewer = F.S.citizens.get(sub.id);
      const per = sub.perception;
      if (!viewer || !per) return;
      const room = per.roomId ?? viewer.location;
      const fade = (id, a) => F.fade.set(id, Math.min(F.fade.get(id) ?? 1, a));
      const objs = new Set(per.objects ?? []);
      for (const [id, p] of F.objectPos) {
        if (p.roomId === room) { if (!objs.has(id)) F.hide.add(id); } else fade(id, 0.3);
      }
      const people = new Map((per.people ?? []).map((x) => [x.id, x]));
      for (const c of F.S.citizens.values()) {
        if (c.id === viewer.id) continue;
        if (c.location === room) { const pp = people.get(c.id); if (!pp) F.hide.add(c.id); else if (pp.emphasis === 'faded') fade(c.id, 0.45); }
        else fade(c.id, 0.3);
      }
      const dom = per.emphasis?.dominant;
      const highlights = new Set(per.emphasis?.highlights ?? []);
      if (dom?.type === 'anger' && dom.intensity >= 6 && people.has(dom.target)) for (const c of F.S.citizens.values()) if (c.id !== viewer.id && c.id !== dom.target) fade(c.id, 0.5);
      if (dom?.type === 'jealousy' && dom.intensity >= 4) {
        if (!highlights.size) for (const pr of F.S.social?.pairs ?? []) if (pr.from === viewer.id && pr.jealousy > 0) { highlights.add(pr.to); if (pr.beloved) highlights.add(pr.beloved); }
        for (const c of F.S.citizens.values()) if (c.id !== viewer.id && !highlights.has(c.id)) fade(c.id, 0.5);
      }
      F.nameOf = (c) => (c.id === viewer.id ? c.name : people.get(c.id)?.label ?? c.name);
      if (per.senses?.deaf) F.muted = (c) => c.id !== viewer.id;
    },
    screen(F) {
      const sub = F.S.subjective;
      if (!sub?.id) return;
      const { target, cam, ms } = F;
      const viewer = F.people.get(sub.id);
      const per = sub.perception;
      if (!per) { target.rect(0, 0, cam.w, cam.h, DARK, 0.15); return; }
      const sn = per.senses ?? {};
      const vx = viewer ? F.X(viewer.x) : cam.w / 2; const vy = viewer ? F.Y(viewer.y - 20) : cam.h / 2;
      const label = (s, x, y, color, scale = Math.max(1, Math.round(F.z))) => { const t = text(s, color); target.blit(t, x - (t.w * scale) / 2, y, { scale }); };
      if (sn.unconscious) { target.rect(0, 0, cam.w, cam.h, [0, 0, 0, 255], 1); label('…', cam.w / 2, cam.h / 2 - 12, [200, 200, 210, 255], 3); return; }
      if (sn.asleep) { target.rect(0, 0, cam.w, cam.h, DARK, 0.85); label('asleep', cam.w / 2, cam.h / 2, [150, 160, 200, 255], 2); }
      const dom = per.emphasis?.dominant;
      const hits = new Map(F.hits.filter((h) => h.type === 'citizen').map((h) => [h.id, h]));
      if (dom?.type === 'anger' && dom.intensity >= 6 && F.people.get(dom.target)) {
        const t = F.people.get(dom.target);
        const tx = F.X(t.x); const ty = F.Y(t.y - 20);
        const cx = (vx + tx) / 2; const cy = (vy + ty) / 2;
        drawVignette(F, cx, cy, Math.max(80, Math.abs(tx - vx) / 2 + 60 * F.z), Math.max(60, Math.abs(ty - vy) / 2 + 50 * F.z), 0.55);
      } else if (dom?.type === 'fear' && dom.intensity >= 6) {
        drawVignette(F, vx, vy, cam.w * 0.42, cam.h * 0.42, 0.6);
        const threats = new Set([...(per.emphasis?.highlights ?? []), dom.target].filter(Boolean));
        for (const id of threats) { const h = hits.get(id); if (h) for (const [x, y, w, hh] of [[h.x, h.y, h.w, 1], [h.x, h.y + h.h, h.w, 1], [h.x, h.y, 1, h.h], [h.x + h.w, h.y, 1, h.h]]) target.rect(x, y, w, hh, [220, 50, 50, 255], 0.8); }
        const doors = F.layout.geom(per.roomId)?.room?.doors ?? [];
        const pulse = 0.35 + 0.25 * Math.sin(ms / 250);
        for (const d of doors) target.rect(F.X(d.tile[0] * TILE), F.Y(d.tile[1] * TILE), TILE * F.z, TILE * F.z, [240, 240, 200, 255], pulse);
      } else if ((dom?.type === 'sadness' || dom?.type === 'grief') && dom.intensity >= 5) {
        drawVignette(F, vx, vy, cam.w * 0.5, cam.h * 0.5, 0.3);
        for (const id of per.emphasis?.highlights ?? []) {
          const o = F.objectPos.get(id); const h = hits.get(id);
          if (o) target.ring(F.X(o.x), F.Y(o.y - 6), 14 * F.z, 7 * F.z, [236, 196, 90, 255]);
          else if (h) target.ring(h.x + h.w / 2, h.y + h.h, 15 * F.z, 6 * F.z, [236, 196, 90, 255]);
        }
      } else if ((dom?.type === 'jealousy' || dom?.type === 'envy') && dom.intensity >= 4) {
        for (const id of per.emphasis?.highlights ?? []) { const p = F.people.get(id); if (p) target.ring(F.X(p.x), F.Y(p.y - 2), 16 * F.z, 7 * F.z, [236, 196, 90, 255]); }
      }
      if (sn.blind) {
        target.rect(0, 0, cam.w, cam.h, DARK, 0.93);
        // voices where people speak
        for (const [id, b] of F.S.bubbles ?? []) {
          if (ms - b.born > 4000 || id === sub.id) continue;
          const p = F.people.get(id); if (!p) continue;
          const x = F.X(p.x); const y = F.Y(p.y - 24);
          target.ring(x, y, 10 * F.z, 10 * F.z, [200, 200, 220, 255]);
          label(F.nameOf?.(p.c) ?? 'someone', x, y + 12 * F.z, [200, 200, 220, 255]);
        }
        // footsteps nearby, as words
        for (const p of F.people.values()) {
          if (!viewer || p.c.id === sub.id || p.roomId !== viewer.roomId) continue;
          const last = lastPos.get(p.c.id);
          if (last && Math.hypot(p.x - last.x, p.y - last.y) > 0.5 && !sounds.some((s) => s.id === p.c.id && ms - s.at < 1200)) sounds.push({ id: p.c.id, at: ms, text: `footsteps, to the ${p.x < viewer.x ? 'left' : 'right'}` });
          lastPos.set(p.c.id, { x: p.x, y: p.y });
        }
        sounds = sounds.filter((s) => ms - s.at < 1600);
        sounds.forEach((s, i) => label(s.text, vx, vy - 40 - i * 14, [180, 190, 220, 255]));
      }
      if (sn.concussed && target.canvas && target.ctx) {
        const k = Math.floor(ms / 400);
        const dx = (k % 3) - 1; const dy = ((k >> 1) % 3) - 1;
        target.ctx.globalAlpha = 0.25; target.ctx.drawImage(target.canvas, dx * 3, dy * 2); target.ctx.globalAlpha = 1;
      }
      if (viewer) label(`through ${viewer.c.name}'s eyes`, 90, cam.h - 22, [236, 196, 90, 255], 1);
    },
  };
}
