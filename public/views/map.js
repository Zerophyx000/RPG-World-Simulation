// Map view (step 8): the living map. A canvas in the centre draws the village from the simulation's own data
// (maps from content/maps, citizens with their body-derived `look`, objects, lasting room effects, the clock) with the
// code-drawn renderer in public/art/scene.js. Pan (drag / arrows / WASD), zoom (wheel, + / -), follow a citizen,
// jump to a room or person, minimap, regions, click a person to open the inspector, click an object to open it,
// hover for a tooltip. Two toggles: true view vs one citizen's surface view of objects, and god view (thoughts, hidden
// things, emotion icons) vs plain view (what a visitor would see). The old room cards live on as the "List" tab.
// The view only READS the store; nothing it does changes the world or reaches a citizen.
import { store, subscribe, subscribeMany, select } from '../store.js';
import { api, esc, prefs, debounce, activityLabel } from '../util.js';
import { colorOf } from '../colors.js';
import { openObject } from './objects-ui.js';
import { makePalette } from '../art/palette.js';
import { createScene, ZOOMS } from '../art/scene.js';
import { CanvasTarget } from '../art/target.js';
import { hex, Img } from '../art/pixels.js';
import { TILE, buildGrid } from '../art/mapdata.js';
import { quality } from '../render/quality.js';
import { createDirectorCam } from '../render/directorcam.js';
import { createReplay } from '../render/replay.js';
import { onEvent as audioEvent } from '../render/audio.js';
import * as convPanelUi from './map-ui/convpanel.js';
import * as hudUi from './map-ui/hud.js';
import * as toastsUi from './map-ui/toasts.js';
import * as watchlistUi from './map-ui/watchlist.js';
import * as searchUi from './map-ui/search.js';
import * as settingsUi from './map-ui/settings.js';
import * as replaybarUi from './map-ui/replaybar.js';

// step 9: the on-map UI modules, each mounted into its own layer over the canvas
const UI_MODULES = [['convpanel', convPanelUi], ['hud', hudUi], ['toasts', toastsUi], ['watchlist', watchlistUi], ['search', searchUi], ['settings', settingsUi], ['replaybar', replaybarUi]];

let assets = null; // { pal, scene, maps }
async function loadAssets() {
  if (assets) return assets;
  const [maps, art] = await Promise.all([api.get('/api/maps'), api.get('/api/art')]);
  const pal = makePalette(art.palette);
  assets = { pal, art, maps: maps.maps, scene: createScene({ pal, recipes: art.recipes, maps: maps.maps, art, quality }) };
  return assets;
}

const hexCache = new Map();
const rgbOf = (id) => { const h = colorOf(id); let c = hexCache.get(h); if (!c) { c = hex(h); hexCache.set(h, c); } return c; };

export function mount(el) {
  el.innerHTML = `
    <div class="mapview">
      <div class="map-toolbar" id="mp-bar">
        <span class="seg" title="Objects: everything that is there, or what one citizen would notice"><button data-o="true">true view</button><button data-o="surface">surface of</button></span>
        <select id="mp-citizen" title="whose surface view"></select>
        <span class="seg" title="God view shows thoughts, hidden things and feelings; plain view shows what a visitor sees"><button data-g="god">god view</button><button data-g="plain">plain</button></span>
        <span class="seg" title="thought bubbles"><button data-t="off">no thoughts</button><button data-t="selected">selected</button><button data-t="all">all</button></span>
        <span class="seg" title="roofs fade when you look inside"><button data-r="auto">roofs</button><button data-r="off">open</button><button data-r="on">closed</button></span>
        <span class="seg" title="light"><button data-l="auto">auto</button><button data-l="day">day</button><button data-l="night">night</button></span>
        <span class="spacer"></span>
        <button id="mp-follow" title="Follow the selected citizen (F)">follow</button>
        <button id="mp-zoomout" title="Zoom out (-)">−</button><span id="mp-zoom" class="dim">1×</span><button id="mp-zoomin" title="Zoom in (+)">+</button>
        <button id="mp-fit" title="Fit the whole map (0)">fit</button>
        <select id="mp-jump" title="Jump to a room"></select>
        <select id="mp-region" class="hidden" title="Region"></select>
        <button id="mp-shot" title="Save a screenshot (PNG)">📷</button>
        <select id="mp-dock" title="Show another view next to the map"><option value="">dock: none</option></select>
        <span id="mp-fps" class="dim"></span>
      </div>
      <div class="map-body">
        <div class="map-stage" id="mp-stage">
          <canvas id="mp-canvas"></canvas>
          <canvas id="mp-mini" class="map-mini" width="64" height="48"></canvas>
          <div class="map-tip hidden" id="mp-tip"></div>
          <div class="map-loading" id="mp-loading">Drawing the village…</div>
          <div class="map-caption hidden" id="mp-caption"></div>
          <div class="map-ui" id="mp-ui"></div>
        </div>
        <div class="map-dock hidden" id="mp-dockpane"></div>
      </div>
    </div>`;
  const $ = (s) => el.querySelector(s);
  const stage = $('#mp-stage'); const canvas = $('#mp-canvas'); const mini = $('#mp-mini'); const tip = $('#mp-tip');
  const target = new CanvasTarget(canvas);
  let alive = true; let raf = 0;
  let sc = null; let pal = null; let maps = [];
  const cam = { x: 32 * TILE, y: 24 * TILE, zoom: prefs.get('mapZoom', 1), w: 800, h: 600 };
  let goal = null;                      // { x, y } the camera glides to
  let dpr = 1;
  let follow = prefs.get('mapFollow', false);
  const opt = {
    objView: prefs.get('mapObjView', 'true'), god: prefs.get('mapGod', 'god'), thoughts: prefs.get('mapThoughts', 'all'),
    roofs: prefs.get('mapRoofs', 'auto'), light: prefs.get('mapLight', 'auto'), surfaceOf: null, dock: prefs.get('mapDock', ''),
  };
  const S = {
    now: 0, mapId: null, rooms: store.rooms, citizens: store.citizens, objects: store.objects, objectsRev: 1, colorOf: rgbOf,
    selectedId: store.selectedId, hoverId: null, hoverRoom: null, bubbles: new Map(), holding: new Set(), faceOf: new Map(),
    uiScale: 1, names: true, icons: true, trueView: true, thoughts: opt.thoughts, roofMode: opt.roofs, rain: false, visibleObjectIds: null,
    // step 9: data for the living map (all read-only, polled from the server)
    social: null, wear: null, decals: [], events: store.events, observer: store.observer, subjective: null, god: true,
  };
  let hits = []; let lastEntries = [];
  canvas.mapHits = () => hits.map((h) => ({ ...h, x: h.x / dpr, y: h.y / dpr, w: h.w / dpr, h: h.h / dpr })); // for tests and tools: pickable things in CSS pixels
  let clockAt = performance.now(); let clockMin = store.clock?.gameMinutes ?? 0;

  // ---------- state mirrors ----------
  const offs = [];
  offs.push(subscribe('clock', (c) => { clockAt = performance.now(); clockMin = c.gameMinutes; }));
  offs.push(subscribe('objects', () => { S.objectsRev++; S.holding = new Set([...store.objects.values()].filter((o) => o.holderId && o.placement?.relation !== 'worn').map((o) => o.holderId)); if (opt.objView === 'surface') refreshSurface(); }));
  offs.push(subscribe('selection', (id) => { S.selectedId = id; if (id && prefs.get('mapJump', true)) jumpToCitizen(id); if (opt.objView === 'surface' && !$('#mp-citizen').dataset.pinned) { opt.surfaceOf = id ?? opt.surfaceOf; refreshSurface(); } }));
  offs.push(subscribe('rooms', () => { S.rain = [...store.rooms.values()].some((r) => (r.tags ?? []).includes('outdoor') && (r.effects ?? []).some((e) => /\b(rain|storm|downpour)/i.test(e.text ?? ''))); fillJump(); }));
  offs.push(subscribe('event', (e) => {
    const t = `${e?.type ?? ''} ${JSON.stringify(e?.data ?? '').slice(0, 400)}`;
    if (/director|effect/i.test(e?.type ?? '') && /explo|blast|detonat/i.test(t)) sc?.blast(performance.now());
  }));
  const seenLine = new Map();
  offs.push(subscribe('conversation', (id) => {
    const conv = store.conversations.get(id);
    const last = conv?.lines?.at(-1);
    if (!last?.speakerId) return;
    const key = `${last.speakerId}|${last.text}|${conv.lines.length}`;
    if (seenLine.get(id) === key) return;
    seenLine.set(id, key);
    S.bubbles.set(last.speakerId, { text: last.text, born: performance.now() });
  }));
  // appearance changes slowly (wounds, bandages, expression, clothes): poll a small endpoint
  let looksTimer = null;
  const pollLooks = async () => {
    try {
      const looks = await api.get('/api/looks');
      for (const [id, look] of Object.entries(looks)) { const c = store.citizens.get(id); if (c) c.look = look; }
    } catch { /* offline */ }
    if (alive) looksTimer = setTimeout(pollLooks, 3000);
  };

  // ---------- surface view ----------
  async function refreshSurfaceNow() {
    if (opt.objView !== 'surface') { S.visibleObjectIds = null; return; }
    const cid = opt.surfaceOf ?? store.selectedId ?? [...store.citizens.keys()][0];
    if (!cid) return;
    opt.surfaceOf = cid; $('#mp-citizen').value = cid;
    const ids = new Set();
    await Promise.all([...store.rooms.keys()].map(async (rid) => {
      try { const r = await api.get(`/api/rooms/${encodeURIComponent(rid)}/objects?view=surface&citizen=${encodeURIComponent(cid)}`); for (const o of r.objects) if (o.listed) ids.add(o.id); } catch { /* ignore */ }
    }));
    S.visibleObjectIds = ids; S.objectsRev++;
  }
  const refreshSurface = debounce(refreshSurfaceNow, 500);

  // ---------- step 9: controllers, polling, the api the on-map UI modules use ----------
  const fetchJson = (url) => api.get(url);
  const directorCam = createDirectorCam({ fetchJson });
  const replay = createReplay({ fetchJson });
  const caption = $('#mp-caption');
  const uis = [];
  let subjectiveOn = false; let perception = null; let pollTimer = null; let pollN = 0; let replayBarOpen = false;
  async function pollExtras() {
    pollN++;
    const want = (url, every) => pollN % every === 1 || every === 1;
    const get = async (url) => { try { return await fetchJson(url); } catch { return null; } };
    if (want('social', 3)) { const s = await get('/api/map/social'); if (s) S.social = s; }
    if (want('decals', 30)) { const d = await get('/api/decals'); if (d) S.decals = d; }
    if (want('wear', 60) && quality.get('wear')) { const wr = await get('/api/wear'); if (wr) S.wear = wr; }
    if (subjectiveOn && S.selectedId && pollN % 2 === 0) { const p = await get(`/api/citizens/${encodeURIComponent(S.selectedId)}/perception`); if (p) perception = p; }
  }
  offs.push(subscribe('event', (e) => { try { audioEvent(e); } catch { /* the audio hook must never break the map */ } }));
  const mapApi = {
    store, quality, directorCam, replay, prefs, colorOf,
    get pal() { return pal; },
    get scene() { return sc; },
    select,
    follow(id) { if (id) select(id); follow = Boolean(id); prefs.set('mapFollow', follow); markSegs(); },
    isFollowing: () => follow,
    jumpTo(id) { if (store.citizens.has(id)) jumpToCitizen(id); else if (store.rooms.has(id)) jumpToRoom(id); else if (store.objects.has(id)) { const o = store.objects.get(id); if (o.roomId) jumpToRoom(o.roomId); else if (o.holderId) jumpToCitizen(o.holderId); } },
    /** World pixels → CSS pixels inside the stage. */
    worldToScreen(wx, wy) { return { x: (wx - cam.x) * cam.zoom + cam.w / dpr / 2, y: (wy - cam.y) * cam.zoom + cam.h / dpr / 2 }; },
    getCamera: () => ({ x: cam.x, y: cam.y, zoom: cam.zoom, w: cam.w / dpr, h: cam.h / dpr }),
    stageSize: () => ({ w: cam.w / dpr, h: cam.h / dpr }),
    isGod: () => opt.god === 'god',
    openConversation(id) { if ((store.viewList ?? []).some((v) => v.id === 'conversations')) { setDock('conversations'); } navigateConversation(id); },
    setSubjective(on) { subjectiveOn = Boolean(on) && Boolean(S.selectedId); if (subjectiveOn) { follow = true; markSegs(); pollExtras(); } },
    isSubjective: () => subjectiveOn,
    toggleDirectorCam() { if (directorCam.active) directorCam.stop(); else { follow = false; directorCam.start(); } markSegs(); },
    toggleReplayBar() { replayBarOpen = !replayBarOpen; },
    isReplayBarOpen: () => replayBarOpen,
  };
  function navigateConversation(id) { import('../store.js').then(({ emit }) => emit('navigate', { view: 'conversations', params: { conversationId: id } })).catch(() => {}); }

  // ---------- toolbar ----------
  function markSegs() {
    el.querySelectorAll('[data-o]').forEach((b) => b.classList.toggle('on', b.dataset.o === opt.objView));
    el.querySelectorAll('[data-g]').forEach((b) => b.classList.toggle('on', b.dataset.g === opt.god));
    el.querySelectorAll('[data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === opt.thoughts));
    el.querySelectorAll('[data-r]').forEach((b) => b.classList.toggle('on', b.dataset.r === opt.roofs));
    el.querySelectorAll('[data-l]').forEach((b) => b.classList.toggle('on', b.dataset.l === opt.light));
    $('#mp-follow').classList.toggle('on', follow);
    $('#mp-citizen').classList.toggle('hidden', opt.objView !== 'surface');
    S.trueView = opt.god === 'god' && opt.objView === 'true';
    S.thoughts = opt.god === 'god' ? opt.thoughts : 'off';
    S.emotionIcons = opt.god === 'god';
    S.roofMode = opt.roofs;
    S.nightOverride = opt.light === 'night' ? 1 : opt.light === 'day' ? 0 : undefined;
    $('#mp-zoom').textContent = `${cam.zoom}×`;
  }
  $('#mp-bar').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.o) { opt.objView = b.dataset.o; prefs.set('mapObjView', opt.objView); refreshSurfaceNow(); }
    if (b.dataset.g) { opt.god = b.dataset.g; prefs.set('mapGod', opt.god); }
    if (b.dataset.t) { opt.thoughts = b.dataset.t; prefs.set('mapThoughts', opt.thoughts); }
    if (b.dataset.r) { opt.roofs = b.dataset.r; prefs.set('mapRoofs', opt.roofs); }
    if (b.dataset.l) { opt.light = b.dataset.l; prefs.set('mapLight', opt.light); }
    markSegs();
  });
  $('#mp-citizen').addEventListener('change', (e) => { opt.surfaceOf = e.target.value; e.target.dataset.pinned = '1'; opt.objView = 'surface'; markSegs(); refreshSurfaceNow(); });
  $('#mp-follow').addEventListener('click', () => { follow = !follow; prefs.set('mapFollow', follow); markSegs(); });
  const zoomBy = (dir, at = null) => {
    const i = ZOOMS.indexOf(cam.zoom);
    const j = Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.indexOf(1) : i) + dir));
    if (ZOOMS[j] === cam.zoom) return;
    const before = at ? screenToWorld(at.x, at.y) : null;
    cam.zoom = ZOOMS[j]; prefs.set('mapZoom', cam.zoom);
    if (before) { const after = screenToWorld(at.x, at.y); cam.x += before.x - after.x; cam.y += before.y - after.y; }
    markSegs();
  };
  $('#mp-zoomin').addEventListener('click', () => zoomBy(1));
  $('#mp-zoomout').addEventListener('click', () => zoomBy(-1));
  const mapSize = () => { const m = maps.find((x) => x.id === S.mapId) ?? maps[0]; return m ? [m.size[0] * TILE, m.size[1] * TILE] : [2048, 1536]; };
  const fit = () => {
    const [mw, mh] = mapSize();
    const w = cam.w / dpr; const h = cam.h / dpr;
    cam.zoom = [...ZOOMS].reverse().find((z) => mw * z <= w && mh * z <= h) ?? ZOOMS[0];
    cam.x = mw / 2; cam.y = mh / 2; goal = null; follow = false; markSegs();
  };
  $('#mp-fit').addEventListener('click', fit);
  $('#mp-jump').addEventListener('change', (e) => { const v = e.target.value; e.target.value = ''; if (v) jumpToRoom(v); });
  $('#mp-shot').addEventListener('click', () => {
    frame(performance.now());
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `agent-world-day${store.clock?.day ?? 0}-${(store.clock?.time ?? '').replace(':', '')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
  });
  const fillJump = () => {
    const sel = $('#mp-jump'); if (!sel || !assets) return;
    const rooms = [...store.rooms.values()];
    sel.innerHTML = `<option value="">jump to…</option>${rooms.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}`;
    const cs = $('#mp-citizen');
    cs.innerHTML = [...store.citizens.values()].map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    if (opt.surfaceOf) cs.value = opt.surfaceOf;
  };
  const roomCentre = (roomId) => {
    const g = sc?.layout.geom(roomId); if (!g) return null;
    return { x: (g.room.rect.x + g.room.rect.w / 2) * TILE, y: (g.room.rect.y + g.room.rect.h / 2) * TILE, rect: g.room.rect, map: g.map.id };
  };
  function jumpToRoom(roomId) {
    const c = roomCentre(roomId); if (!c) return;
    S.mapId = c.map; follow = false;
    const w = cam.w / dpr; const h = cam.h / dpr;
    cam.zoom = [...ZOOMS].reverse().find((z) => c.rect.w * TILE * z <= w * 0.9 && c.rect.h * TILE * z <= h * 0.9) ?? ZOOMS[0];
    goal = { x: c.x, y: c.y }; markSegs();
  }
  function jumpToCitizen(id) {
    const c = store.citizens.get(id); const p = c?.__place;
    if (!p) { const rc = roomCentre(c?.location); if (rc) goal = { x: rc.x, y: rc.y }; return; }
    if (cam.zoom < 1) { cam.zoom = 1; markSegs(); }
    goal = { x: p.x, y: p.y - 20 };
  }

  // ---------- dock ----------
  let dockUnmount = null;
  function setDock(id) {
    dockUnmount?.(); dockUnmount = null;
    opt.dock = id; prefs.set('mapDock', id);
    const pane = $('#mp-dockpane');
    pane.classList.toggle('hidden', !id);
    pane.innerHTML = '';
    $('#mp-dock').value = id;
    if (!id) return;
    const v = (store.viewList ?? []).find((x) => x.id === id);
    if (!v) return;
    pane.className = `map-dock view view-${id}`;
    dockUnmount = v.mod.mount(pane, {}) ?? null;
  }
  $('#mp-dock').addEventListener('change', (e) => setDock(e.target.value));
  for (const v of store.viewList ?? []) if (!['map', 'world'].includes(v.id)) $('#mp-dock').insertAdjacentHTML('beforeend', `<option value="${esc(v.id)}">${esc(v.label)}</option>`);

  // ---------- pointer input ----------
  const screenToWorld = (px, py) => ({ x: (px - cam.w / dpr / 2) / cam.zoom + cam.x, y: (py - cam.h / dpr / 2) / cam.zoom + cam.y });
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false }; });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    if (drag) {
      const dx = e.clientX - drag.x; const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; follow = false; goal = null; directorCam.pause(); markSegs(); }
      if (drag.moved) { cam.x = drag.cx - dx / cam.zoom; cam.y = drag.cy - dy / cam.zoom; canvas.style.cursor = 'grabbing'; return; }
    }
    hover(e.clientX - r.left, e.clientY - r.top);
  });
  canvas.addEventListener('pointerup', (e) => {
    const was = drag; drag = null; canvas.style.cursor = '';
    if (was?.moved) return;
    const r = canvas.getBoundingClientRect();
    click(e.clientX - r.left, e.clientY - r.top, e.shiftKey);
  });
  canvas.addEventListener('pointerleave', () => { S.hoverId = null; S.hoverRoom = null; tip.classList.add('hidden'); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    directorCam.pause();
    zoomBy(e.deltaY < 0 ? 1 : -1, { x: e.clientX - r.left, y: e.clientY - r.top });
  }, { passive: false });
  const pick = (px, py) => {
    const X = px * dpr; const Y = py * dpr;
    for (const type of ['citizen', 'pin', 'object', 'room']) { // step 9: 'pin' = an event pin of the story overlays ({ event, label })
      for (let i = hits.length - 1; i >= 0; i--) {
        const h = hits[i];
        if (h.type !== type) continue;
        if (X >= h.x && X <= h.x + h.w && Y >= h.y && Y <= h.y + h.h) return h;
      }
    }
    return null;
  };
  function hover(px, py) {
    const h = pick(px, py);
    S.hoverId = h?.type === 'citizen' ? h.id : null;
    S.hoverRoom = h?.type === 'room' ? h.id : null;
    canvas.style.cursor = h ? 'pointer' : '';
    if (!h) { tip.classList.add('hidden'); return; }
    let html = '';
    if (h.type === 'citizen') {
      const c = store.citizens.get(h.id);
      html = `<b style="color:${colorOf(h.id)}">${esc(c?.name ?? h.id)}</b><br>${esc(c ? activityLabel(c.activity) : '')}${c?.spot ? `<br><span class="dim">at ${esc(c.spot)}</span>` : ''}`;
    } else if (h.type === 'object') {
      const o = store.objects.get(h.id);
      html = `<b>${esc(o?.typeName ?? h.id)}</b> <span class="dim">${esc(o?.state ?? '')}</span><br>${esc(opt.objView === 'surface' ? (o?.surface ?? '') : (o?.trueText ?? o?.surface ?? o?.label ?? ''))}`;
    } else if (h.type === 'pin') html = `<b>${esc(h.label ?? 'event')}</b><br><span class="dim">click for the events</span>`;
    else html = `<b>${esc(store.rooms.get(h.id)?.name ?? h.id)}</b><br><span class="dim">click to look inside</span>`;
    tip.innerHTML = html; tip.classList.remove('hidden');
    tip.style.left = `${Math.min(px + 14, cam.w / dpr - 240)}px`; tip.style.top = `${Math.min(py + 14, cam.h / dpr - 80)}px`;
  }
  function click(px, py, shift) {
    const h = pick(px, py);
    if (!h) { select(null); return; }
    if (h.type === 'citizen') { if (shift) follow = true; select(h.id); markSegs(); } else if (h.type === 'object') openObject(h.id);
    else if (h.type === 'pin') { if (h.event?.actorId) select(h.event.actorId); setDock('events'); }
    else if (h.type === 'room') jumpToRoom(h.id);
  }
  // minimap: click or drag to jump
  const miniJump = (e) => {
    const r = mini.getBoundingClientRect();
    const [mw, mh] = mapSize();
    goal = null; follow = false;
    cam.x = ((e.clientX - r.left) / r.width) * mw; cam.y = ((e.clientY - r.top) / r.height) * mh; markSegs();
  };
  let miniDown = false;
  mini.addEventListener('pointerdown', (e) => { miniDown = true; mini.setPointerCapture(e.pointerId); miniJump(e); });
  mini.addEventListener('pointermove', (e) => { if (miniDown) miniJump(e); });
  mini.addEventListener('pointerup', () => { miniDown = false; });

  // ---------- keyboard ----------
  const keys = new Set();
  const onKey = (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.type === 'keydown') {
      if (e.key === '+' || e.key === '=') zoomBy(1);
      else if (e.key === '-' || e.key === '_') zoomBy(-1);
      else if (e.key === '0') fit();
      else if (e.key === 'f' || e.key === 'F') { follow = !follow; prefs.set('mapFollow', follow); markSegs(); }
      else if (e.key === 's' || e.key === 'S') mapApi.setSubjective(!mapApi.isSubjective());
      else if (e.key === 'd' || e.key === 'D') mapApi.toggleDirectorCam();
      else if (e.key === 'r' || e.key === 'R') mapApi.toggleReplayBar();
      else if (e.key === 'g' || e.key === 'G') { opt.god = opt.god === 'god' ? 'plain' : 'god'; prefs.set('mapGod', opt.god); markSegs(); }
      else if (e.key === 't' || e.key === 'T') { opt.objView = opt.objView === 'true' ? 'surface' : 'true'; prefs.set('mapObjView', opt.objView); markSegs(); refreshSurfaceNow(); }
      else if (/^[0-9]$/.test(e.key)) {
        // digits pick a dock tab here (0 = none) instead of switching the main view
        e.stopImmediatePropagation(); e.preventDefault();
        const docks = (store.viewList ?? []).filter((v) => !['map', 'world'].includes(v.id));
        setDock(e.key === '0' ? '' : (docks[Number(e.key) - 1]?.id ?? opt.dock));
      }
      else if (/^arrow(up|down|left|right)$/i.test(e.key)) { keys.add(e.key.toLowerCase()); e.preventDefault(); directorCam.pause(); }
    } else keys.delete(e.key.toLowerCase());
  };
  window.addEventListener('keydown', onKey, true); // capture: digits must reach the map before the app's view switch
  window.addEventListener('keyup', onKey, true);

  // ---------- minimap base ----------
  let miniBase = null;
  function buildMini() {
    const m = maps.find((x) => x.id === S.mapId) ?? maps[0];
    if (!m) return;
    const grid = buildGrid(m);
    mini.width = grid.W; mini.height = grid.H;
    const img = new Img(grid.W, grid.H);
    const C = { grass: [74, 124, 64], dirt_path: [150, 118, 78], dirt: [130, 98, 64], cobble: [140, 140, 146], wood_floor: [186, 140, 84], stone_floor: [150, 150, 156], water: [62, 120, 190], stone_wall: [60, 60, 70], timber_wall: [80, 54, 34], door: [120, 80, 40], fence: [120, 90, 60], tree: [40, 90, 44], bush: [56, 108, 50] };
    for (let y = 0; y < grid.H; y++) for (let x = 0; x < grid.W; x++) img.set(x, y, [...(C[grid.structure[y][x]] ?? C[grid.ground[y][x]] ?? C.grass), 255]);
    miniBase = img;
  }
  function drawMini() {
    if (!miniBase) return;
    const g = mini.getContext('2d');
    if (!mini.__img || mini.__img.version !== miniBase.version) {
      mini.__img = document.createElement('canvas'); mini.__img.width = miniBase.w; mini.__img.height = miniBase.h;
      mini.__img.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(miniBase.data), miniBase.w, miniBase.h), 0, 0);
      mini.__img.version = miniBase.version;
    }
    g.imageSmoothingEnabled = false;
    g.drawImage(mini.__img, 0, 0);
    for (const c of store.citizens.values()) {
      const p = c.__place; if (!p) continue;
      g.fillStyle = colorOf(c.id); g.fillRect(Math.floor(p.x / TILE) - 1, Math.floor(p.y / TILE) - 1, 3, 3);
      g.fillStyle = '#000'; g.fillRect(Math.floor(p.x / TILE), Math.floor(p.y / TILE), 1, 1);
    }
    g.strokeStyle = '#fff'; g.lineWidth = 0.8;
    g.strokeRect(((cam.x - cam.w / dpr / 2 / cam.zoom) / TILE), ((cam.y - cam.h / dpr / 2 / cam.zoom) / TILE), cam.w / dpr / cam.zoom / TILE, cam.h / dpr / cam.zoom / TILE);
  }

  // ---------- the frame ----------
  let lastT = 0; let fpsAcc = 0; let fpsN = 0; let fpsShow = 0; let costAcc = 0; let uiAt = 0; let lastPeople = new Map();
  function frame(t) {
    if (!sc) return;
    const dt = Math.min(0.1, (t - lastT) / 1000 || 0.016); lastT = t;
    // size
    const rect = stage.getBoundingClientRect();
    const nd = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const w = Math.max(200, Math.round(rect.width * nd)); const h = Math.max(200, Math.round(rect.height * nd));
    if (w !== canvas.width || h !== canvas.height || nd !== dpr) { dpr = nd; target.resize(w, h); }
    cam.w = w; cam.h = h;
    // keys, glide, follow
    const sp = 420 * dt / cam.zoom;
    if (keys.size) { follow = false; goal = null; if (keys.has('arrowleft')) cam.x -= sp; if (keys.has('arrowright')) cam.x += sp; if (keys.has('arrowup')) cam.y -= sp; if (keys.has('arrowdown')) cam.y += sp; }
    // step 9: the director camera picks the goal while it is active
    if (directorCam.active) {
      const g = directorCam.update(dt, S, { x: cam.x, y: cam.y, zoom: cam.zoom }, lastPeople);
      if (g) { goal = { x: g.x, y: g.y }; if (g.zoom && ZOOMS.includes(g.zoom) && g.zoom !== cam.zoom) { cam.zoom = g.zoom; markSegs(); } }
      caption.textContent = directorCam.caption || ''; caption.classList.toggle('hidden', !directorCam.caption);
    } else caption.classList.add('hidden');
    const tp = follow && S.selectedId ? store.citizens.get(S.selectedId)?.__place : null;
    const tg = tp ? { x: tp.x, y: tp.y - 20 } : goal;
    if (tg) { const k = 1 - Math.exp(-dt * 7); cam.x += (tg.x - cam.x) * k; cam.y += (tg.y - cam.y) * k; if (!tp && Math.hypot(tg.x - cam.x, tg.y - cam.y) < 1) goal = null; }
    const [mw, mh] = mapSize();
    cam.x = Math.max(0, Math.min(mw, cam.x)); cam.y = Math.max(0, Math.min(mh, cam.y));
    // state
    const clock = store.clock;
    const est = clockMin + (clock?.running ? ((performance.now() - clockAt) / 1000) * (60 / (clock.realSecondsPerGameHour || 120)) : 0);
    // the drawn clock never runs backwards when the server corrects it (small corrections are absorbed; a reseed jumps)
    S.now = est < S.now && S.now - est < 30 ? S.now : est;
    S.uiScale = dpr;
    S.rooms = store.rooms; S.citizens = store.citizens; S.objects = store.objects; // loadWorld() replaces these Maps on every resync
    S.faceOf = faces();
    S.events = store.events; S.observer = store.observer; S.god = opt.god === 'god';
    S.subjective = subjectiveOn && S.selectedId ? { id: S.selectedId, perception: perception?.citizenId === S.selectedId ? perception : null } : null;
    const view = { x: cam.x, y: cam.y, zoom: cam.zoom * dpr, w, h };
    const drawState = replay.active ? replay.stateAt(S, t) : S; // step 9: replay draws the past while the world runs on
    const c0 = performance.now();
    const res = sc.draw(target, view, drawState, t);
    costAcc += performance.now() - c0;
    hits = res.hits; lastEntries = res.entries; lastPeople = res.people;
    if (t - uiAt > 100) { uiAt = t; for (const u of uis) { try { u.handle.update(drawState, res); } catch (err) { if (!u.warned) { u.warned = true; console.error(`[map] ${u.id} failed`, err); } } } }
    drawMini();
    fpsAcc += dt; fpsN++;
    if (fpsAcc >= 1) { fpsShow = Math.round(fpsN / fpsAcc); fpsAcc = 0; $('#mp-fps').textContent = `${fpsShow} fps · ${(costAcc / fpsN).toFixed(1)} ms`; costAcc = 0; fpsN = 0; }
  }
  function faces() {
    const m = new Map();
    for (const conv of store.conversations.values()) {
      const ps = conv.participants ?? [];
      if (ps.length < 2) continue;
      const speaker = conv.lines?.at(-1)?.speakerId ?? ps[0];
      for (const p of ps) m.set(p, p === speaker ? ps.find((x) => x !== speaker) : speaker);
    }
    return m;
  }
  const loop = (t) => { if (!alive) return; if (!document.hidden) { try { frame(t); } catch (err) { console.error('[map] frame failed', err); } } raf = requestAnimationFrame(loop); };

  // ---------- boot ----------
  markSegs();
  loadAssets().then((a) => {
    if (!alive) return;
    sc = a.scene; pal = a.pal; maps = a.maps; S.mapId = maps[0]?.id ?? null;
    S.holding = new Set([...store.objects.values()].filter((o) => o.holderId && o.placement?.relation !== 'worn').map((o) => o.holderId));
    if (maps.length > 1) { const r = $('#mp-region'); r.classList.remove('hidden'); r.innerHTML = maps.map((m) => `<option value="${esc(m.id)}">${esc(m.name ?? m.id)}</option>`).join(''); r.addEventListener('change', () => { S.mapId = r.value; buildMini(); fit(); }); }
    buildMini(); fillJump();
    $('#mp-loading').remove();
    if (store.selectedId) jumpToCitizen(store.selectedId);
    setDock(opt.dock);
    if (opt.objView === 'surface') refreshSurfaceNow();
    pollLooks();
    // step 9: on-map UI modules
    const uiLayer = $('#mp-ui');
    for (const [id, mod] of UI_MODULES) {
      const box = document.createElement('div'); box.className = `map-ui-${id}`; uiLayer.append(box);
      try { uis.push({ id, handle: mod.mount(box, mapApi) ?? { update() {}, unmount() {} } }); } catch (err) { console.error(`[map] ${id} could not mount`, err); }
    }
    pollExtras(); pollTimer = setInterval(pollExtras, 1000);
    raf = requestAnimationFrame(loop);
  }).catch((err) => { $('#mp-loading').textContent = `The map could not be drawn: ${err.message}`; console.error(err); });

  return () => {
    alive = false; cancelAnimationFrame(raf); clearTimeout(looksTimer);
    offs.forEach((off) => off());
    window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKey, true);
    for (const u of uis) { try { u.handle.unmount(); } catch { /* ignore */ } }
    clearInterval(pollTimer);
    dockUnmount?.();
  };
}
