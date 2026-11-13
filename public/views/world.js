// World view: room cards laid out like a map (x, y from rooms.json; grid fallback), citizen chips
// in their colors, lasting room effects, 🗣 badges for active conversations, walkers on the paths.
// Step 5: an object strip per room, as the TRUE view (everything; hidden things dashed with their
// placement) or one citizen's SURFACE view (what they'd notice; "(you know)" hidden things dashed).
import { store, subscribeMany } from '../store.js';
import { esc, ICONS, activityLabel, truncate, navigate, needBadges, api, prefs, debounce } from '../util.js';
import { colorOf, tint } from '../colors.js';
import { objectsIn, pillsHtml } from './objects-ui.js';
import { ringStyle, ringTitle, emoIcons, colorOfEmotion } from './emotions-ui.js';
import { subscribe } from '../store.js';

const glows = new Map(); // roomId -> { color, type, until }

let root = null;
let objView = prefs.get('objView', 'true'); // 'off' | 'true' | 'surface'
let surfaceOf = null;                        // citizen id for the surface view
const surface = new Map();                   // roomId -> [{ ...object, tier, listed }]

const refreshSurface = debounce(async () => {
  if (!root || objView !== 'surface') return;
  const cid = surfaceOf ?? store.selectedId ?? [...store.citizens.keys()][0];
  if (!cid) return;
  surfaceOf = cid;
  await Promise.all([...store.rooms.keys()].map(async (rid) => {
    try {
      const r = await api.get(`/api/rooms/${encodeURIComponent(rid)}/objects?view=surface&citizen=${encodeURIComponent(cid)}`);
      surface.set(rid, r.objects);
    } catch { surface.set(rid, []); }
  }));
  render();
}, 400);

export function mount(el) {
  root = el;
  el.innerHTML = `<div class="map-tools"><span class="dim">Objects:</span>
      <span class="seg" id="ov-seg">${['off', 'true', 'surface'].map((v) => `<button data-ov="${v}" class="${v === objView ? 'on' : ''}">${v === 'true' ? 'true view' : v === 'surface' ? 'surface view of' : 'off'}</button>`).join('')}</span>
      <select id="ov-citizen"></select>
      <span class="dim ob-legend"><span class="ob-pill t-obvious">obvious</span><span class="ob-pill t-noticeable">noticeable</span><span class="ob-pill t-hidden">hidden</span></span></div>
    <div class="map" id="map"><svg class="map-paths" id="map-paths" preserveAspectRatio="none" viewBox="0 0 100 100"></svg><div id="map-rooms"></div><div id="map-walkers"></div></div>`;
  el.addEventListener('click', (e) => {
    const badge = e.target.closest('[data-open-conv]');
    if (badge) navigate('conversations', { conversationId: badge.dataset.openConv });
    const ov = e.target.closest('[data-ov]');
    if (ov) {
      objView = ov.dataset.ov;
      prefs.set('objView', objView);
      el.querySelectorAll('[data-ov]').forEach((b) => b.classList.toggle('on', b.dataset.ov === objView));
      if (objView === 'surface') refreshSurface();
      render();
    }
  });
  el.querySelector('#ov-citizen').addEventListener('change', (e) => {
    surfaceOf = e.target.value;
    objView = 'surface';
    el.querySelectorAll('[data-ov]').forEach((b) => b.classList.toggle('on', b.dataset.ov === objView));
    refreshSurface();
  });
  const off = subscribeMany(['rooms', 'citizens', 'conversations', 'filter', 'selection', 'objects'], () => {
    if (objView === 'surface') refreshSurface();
    render();
  });
  if (objView === 'surface') refreshSurface();
  const offClock = subscribeMany(['clock'], renderWalkers);
  // Step 6: a room glows briefly when a feeling spreading through it crosses a band.
  const offGlow = subscribe('emotion_room', (g) => {
    glows.set(g.roomId, { color: g.color ?? colorOfEmotion(g.type), type: g.type, until: Date.now() + 7000 });
    render();
    setTimeout(render, 7200);
  });
  render();
  return () => {
    off();
    offClock();
    offGlow();
    root = null;
  };
}

// Map coordinates in percent of the map box (with a margin so cards stay inside).
function positions() {
  const rooms = [...store.rooms.values()];
  const pos = new Map();
  const missing = rooms.filter((r) => r.x == null || r.y == null);
  const cols = Math.ceil(Math.sqrt(missing.length || 1));
  missing.forEach((r, i) => pos.set(r.id, { x: 10 + (i % cols) * (80 / Math.max(1, cols - 1 || 1)), y: 12 + Math.floor(i / cols) * 25 }));
  for (const r of rooms) if (r.x != null && r.y != null) pos.set(r.id, { x: 8 + r.x * 0.84, y: 9 + r.y * 0.82 });
  return pos;
}

function chip(c) {
  const a = c.activity ?? { type: 'idle' };
  const dim = store.filterCitizen && store.filterCitizen !== c.id ? 'dimmed' : '';
  const label = a.type === 'idle' || a.type === 'thinking' ? '' : `<span class="act">${esc(truncate(activityLabel(c), 26))}</span>`;
  return `<span class="chip ${a.type} ${c.id === store.selectedId ? 'selected' : ''} ${dim}" data-citizen="${esc(c.id)}"
      style="--c:${colorOf(c.id)};--bg:${tint(c.id, 0.16)};${ringStyle(c)}" title="${esc(`${c.name}: ${activityLabel(c)}${ringTitle(c) ? ` · ${ringTitle(c)}` : ''}`)}">
    <span>${ICONS[a.type] ?? '·'}</span><span class="nm">${esc(c.name)}</span>${emoIcons(c)}${needBadges(c)}${label}</span>`;
}

function objectStrip(r) {
  if (objView === 'off') return '';
  if (objView === 'surface') {
    const list = surface.get(r.id);
    if (!list) return '<div class="ob-strip dim">…</div>';
    const html = pillsHtml(list.filter((o) => o.listed), (o) => o.tier) + (list.some((o) => !o.listed) ? `<span class="ob-more" title="perceived but not listed (room detail limit)">+${list.filter((o) => !o.listed).length}</span>` : '');
    return `<div class="ob-strip">${html || '<span class="empty">nothing noticed</span>'}</div>`;
  }
  const list = objectsIn(r.id);
  return list.length ? `<div class="ob-strip">${pillsHtml(list)}</div>` : '';
}

function render() {
  if (!root) return;
  const sel = root.querySelector('#ov-citizen');
  const cur = surfaceOf ?? store.selectedId ?? '';
  const opts = [...store.citizens.values()].map((c) => `<option value="${esc(c.id)}" ${c.id === cur ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  if (sel.dataset.opts !== opts) { sel.innerHTML = opts; sel.dataset.opts = opts; }
  const pos = positions();
  // paths between rooms (each pair once)
  const seen = new Set();
  const paths = [];
  for (const r of store.rooms.values()) {
    for (const e of r.exits ?? []) {
      const key = [r.id, e.to].sort().join('|');
      if (seen.has(key) || !pos.has(e.to)) continue;
      seen.add(key);
      const a = pos.get(r.id);
      const b = pos.get(e.to);
      const blocked = (r.blockedExits ?? []).some((x) => x.to === e.to) || (store.rooms.get(e.to)?.blockedExits ?? []).some((x) => x.to === r.id);
      paths.push(`<line class="${blocked ? 'blocked' : ''}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`);
    }
  }
  root.querySelector('#map-paths').innerHTML = paths.join('');

  const people = [...store.citizens.values()].filter((c) => c.alive !== false);
  const convsByRoom = new Map();
  for (const cv of store.conversations.values()) {
    if (!convsByRoom.has(cv.roomId)) convsByRoom.set(cv.roomId, []);
    convsByRoom.get(cv.roomId).push(cv);
  }
  root.querySelector('#map-rooms').innerHTML = [...store.rooms.values()].map((r) => {
    const p = pos.get(r.id);
    const here = people.filter((c) => c.location === r.id);
    const effects = (r.effects ?? []).map((fx) => `<div class="fx" title="${esc(fx.text)}">⚠ ${esc(truncate(fx.text, 70))}</div>`).join('');
    const convs = (convsByRoom.get(r.id) ?? []).map((cv) =>
      `<button class="conv-badge" data-open-conv="${esc(cv.id)}" title="${esc(`${cv.participants.length} people, ${cv.lines.length} lines`)}">🗣 ${cv.participants.length}</button>`).join('');
    const svc = Object.keys(r.allServices ?? {}).map((k) => {
      const on = Boolean(r.services?.[k]);
      const icon = k === 'food' ? '🍲' : '🛏';
      const why = r.serviceOverrides?.[k]?.reason;
      return `<span class="svc ${on ? '' : 'off'}" title="${esc(on ? (r.allServices[k].description ?? k) : `${k} unavailable${why ? `: ${why}` : ''}`)}">${icon}</span>`;
    }).join('');
    const glow = glows.get(r.id);
    const glowing = glow && glow.until > Date.now();
    return `<div class="room-card ${r.effects?.length ? 'has-fx' : ''} ${glowing ? 'emo-glow' : ''}" style="left:${p.x}%;top:${p.y}%;${glowing ? `--glow:${glow.color}` : ''}">
      <div class="room-head"><span class="room-name">${esc(r.name)}</span>${svc}${convs}${glowing ? `<span class="glow-label" style="color:${glow.color}">${esc(glow.type)} spreading</span>` : ''}</div>
      ${effects}
      <div class="chips">${here.length ? here.map(chip).join('') : '<span class="empty">empty</span>'}</div>
      ${objectStrip(r)}
    </div>`;
  }).join('');
  renderWalkers();
}

// People on the move: a chip on the path between the two rooms, placed by progress.
function renderWalkers() {
  if (!root) return;
  const pos = positions();
  const now = store.clock?.gameMinutes ?? 0;
  const walkers = [...store.citizens.values()].filter((c) => c.activity?.type === 'moving');
  root.querySelector('#map-walkers').innerHTML = walkers.map((c) => {
    const d = c.activity.detail ?? {};
    const a = pos.get(d.from);
    const b = pos.get(d.to);
    if (!a || !b) return '';
    const total = Math.max(0.01, (c.activity.until ?? now) - c.activity.since);
    const t = Math.min(1, Math.max(0, (now - c.activity.since) / total));
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    return `<div class="walker" style="left:${x}%;top:${y}%">${chip(c)}</div>`;
  }).join('');
}
