// Step 9: the director camera. While active it polls GET /api/interest every 3 s and glides to what matters most
// (critical bleeding first, then fresh dramatic events, tense conversations, storylines), holds a focus at least
// 8 s unless something of importance >= 9 happens, frames a whole conversation, and shows a caption ("Greta and
// Tomas argue (anger)"). Any manual pan or zoom pauses it; D or the button resumes it.
import { TILE } from '../art/mapdata.js';

const ZOOMS = [0.25, 0.5, 1, 2, 3, 4];
const HOLD_MS = 8000;
const POLL_MS = 3000;

/** Where to look and how close, for a focus: the bounding box of its people (or the room centre). */
export function frameFocus(focus, people, roomCentre = null) {
  if (!focus) return null;
  const pts = (focus.citizenIds ?? []).map((id) => people?.get(id)).filter(Boolean);
  if (focus.kind !== 'room' && pts.length) {
    const xs = pts.map((p) => p.x); const ys = pts.map((p) => p.y);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / TILE;
    const zoom = pts.length === 1 || span < 6 ? 2 : span <= 14 ? 1 : 0.5;
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 - 20, zoom };
  }
  const c = focus.roomId && roomCentre ? roomCentre(focus.roomId) : null;
  if (c) return { x: c.x, y: c.y, zoom: 1 };
  if (pts.length) return { x: pts[0].x, y: pts[0].y - 20, zoom: 1 };
  return null;
}

export function createDirectorCam({ fetchJson, now = () => Date.now(), roomCentre = null } = {}) {
  let focuses = [];
  let current = null; let since = 0;
  let lastPoll = -Infinity; let polling = false;

  async function poll() {
    if (polling) return;
    polling = true; lastPoll = now();
    try { const r = await fetchJson('/api/interest'); focuses = r?.focuses ?? []; } catch { /* keep the old ones */ }
    polling = false;
  }
  const keyOf = (f) => (f ? `${f.kind}:${f.id}` : '');

  const cam = {
    active: false,
    caption: '',
    roomCentre,
    start() { cam.active = true; current = null; since = 0; lastPoll = -Infinity; poll(); },
    stop() { cam.active = false; cam.caption = ''; current = null; },
    pause() { if (cam.active) { cam.active = false; cam.caption = ''; } },
    /** The goal for this frame ({ x, y, zoom } in world px) or null. */
    update(_dt, _S, _cam, people) {
      if (!cam.active) return null;
      const t = now();
      if (t - lastPoll >= POLL_MS) poll();
      const top = focuses[0] ?? null;
      if (!top) { cam.caption = ''; return current ? frameFocus(current, people, cam.roomCentre) : null; }
      const fresh = current ? focuses.find((f) => keyOf(f) === keyOf(current)) : null;
      // hold a focus 8 s; something of importance >= 9 (at least as important as what we watch) cuts in at once
      const urgent = (top.importance ?? 0) >= 9 && (top.importance ?? 0) >= (current?.importance ?? 0);
      if (!current || (keyOf(top) !== keyOf(current) && (t - since >= HOLD_MS || urgent))) {
        current = top; since = t;
      } else if (fresh) current = fresh;
      cam.caption = current?.caption ?? '';
      const g = frameFocus(current, people, cam.roomCentre);
      if (g && !ZOOMS.includes(g.zoom)) g.zoom = 1;
      return g;
    },
  };
  return cam;
}
