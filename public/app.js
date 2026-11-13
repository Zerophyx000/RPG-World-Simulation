// Frontend entry: boot, live stream (SSE) → store, router, header, keyboard shortcuts.
// Plain JS modules, no build step, no libraries.
import { store, emit, subscribe, addEvent, select, setFilter } from './store.js';
import { $, api, esc, citizenName, closeModal, navigate } from './util.js';
import { colorOf } from './colors.js';
import * as roster from './views/roster.js';
import * as inspector from './views/inspector.js';
import * as worldView from './views/world.js';
import * as conversationsView from './views/conversations.js';
import * as timelineView from './views/timeline.js';
import * as relationshipsView from './views/relationships.js';
import * as storyView from './views/story.js';
import * as eventsView from './views/events.js';
import * as llmView from './views/llm.js';
import * as directorView from './views/director.js';
import * as usageView from './views/usage.js';
import * as groupsView from './views/groups.js';
import { onObjectMessage, openObject } from './views/objects-ui.js';

const VIEWS = [
  { id: 'world', label: 'World', mod: worldView },
  { id: 'conversations', label: 'Conversations', mod: conversationsView },
  { id: 'timeline', label: 'Timeline', mod: timelineView },
  { id: 'relationships', label: 'Relationships', mod: relationshipsView },
  { id: 'groups', label: 'Groups', mod: groupsView },
  { id: 'story', label: 'Story', mod: storyView },
  { id: 'events', label: 'Events', mod: eventsView },
  { id: 'llm', label: 'LLM', mod: llmView },
  { id: 'director', label: 'Director', mod: directorView },
  { id: 'usage', label: 'Usage', mod: usageView },
];

// ---------- header ----------
function renderClock(c) {
  store.clock = c;
  if (c.llm) store.llm = c.llm;
  $('#clock-day').textContent = `Day ${c.day}`;
  $('#clock-time').textContent = c.time;
  const status = $('#clock-status');
  status.textContent = `${c.running ? 'running' : 'paused'} ${c.speed}×${c.quietMultiplier > 1 ? ` (quiet: ${c.quietMultiplier}×)` : ''}`;
  status.className = `pill ${c.running ? 'running' : 'paused'}`;
  $('#btn-toggle').textContent = c.running ? '⏸ Pause' : '▶ Resume';
  const sel = $('#speed');
  if (document.activeElement !== sel) sel.value = String(c.speed);
  $('#clock-rate').textContent = `1 game h ≈ ${(c.realSecondsPerGameHour / 60).toFixed(1)} min`;
  if (store.llm) {
    const l = store.llm;
    $('#llm-load').textContent = `llm ${l.active}/${l.maxConcurrent}${l.waiting ? ` +${l.waiting}` : ''}`;
  }
  emit('clock', c);
}

const togglePause = () => api.post('/api/clock', { action: store.clock?.running ? 'pause' : 'resume' }).then(renderClock);
$('#btn-toggle').addEventListener('click', togglePause);
$('#speed').addEventListener('change', (e) => api.post('/api/clock', { action: 'speed', value: Number(e.target.value) }).then(renderClock));

function renderGovernor() {
  const g = store.governor;
  const el = $('#gov');
  if (!el || !g) return;
  el.className = `pill gov-${g.state}`;
  el.textContent = g.enabled ? `budget ${Math.round(g.ratio * 100)}%` : 'budget off';
  el.title = `token governor: ${g.state} (${g.budgetPerHour} output tokens per real hour)`;
}

// ---------- router ----------
let current = null; // { id, unmount }

function renderTabs() {
  $('#tabs').innerHTML = VIEWS.map((v, i) =>
    `<button data-view="${v.id}" class="${store.view === v.id ? 'active' : ''}" title="${i + 1}">${v.label}</button>`).join('');
}

function show(viewId, params = {}) {
  const v = VIEWS.find((x) => x.id === viewId) ?? VIEWS[0];
  if (current?.id === v.id && v.mod.update) {
    v.mod.update(params);
    return;
  }
  current?.unmount?.();
  store.view = v.id;
  renderTabs();
  const el = $('#view');
  el.innerHTML = '';
  el.className = `view view-${v.id}`;
  current = { id: v.id, unmount: v.mod.mount(el, params) };
  if (location.hash !== `#/${v.id}`) history.replaceState(null, '', `#/${v.id}`);
  emit('view', v.id);
}

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) show(b.dataset.view);
});
subscribe('navigate', ({ view, params }) => show(view, params));

// ---------- filter bar (shift-click a citizen) ----------
function renderFilter() {
  const bar = $('#filter-bar');
  const id = store.filterCitizen;
  bar.classList.toggle('hidden', !id);
  bar.innerHTML = id
    ? `Showing <b style="color:${colorOf(id)}">${esc(citizenName(id))}</b> only <button data-clear-filter>clear</button>`
    : '';
}
subscribe('filter', renderFilter);
$('#filter-bar').addEventListener('click', (e) => {
  if (e.target.closest('[data-clear-filter]')) setFilter(store.filterCitizen);
});

// Any element with data-citizen opens the inspector; shift-click filters the main view instead.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-citizen]');
  if (!el || el.closest('.roster-card')) return; // roster handles its own clicks
  e.preventDefault();
  if (e.shiftKey) setFilter(el.dataset.citizen);
  else select(el.dataset.citizen);
});

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === ' ') {
    e.preventDefault();
    togglePause();
  } else if (e.key === 'Escape') {
    if (!closeModal()) select(null);
  } else if (/^[1-9]$/.test(e.key)) {
    show(VIEWS[Number(e.key) - 1].id);
  }
});

// ---------- data loading ----------
async function loadWorld() {
  const [w, convs, obs, events] = await Promise.all([
    api.get('/api/world'),
    api.get('/api/conversations?active=1'),
    api.get('/api/observer/latest').catch(() => ({ report: null, status: null })),
    api.get('/api/events?limit=400'),
  ]);
  store.rooms = new Map(w.rooms.map((r) => [r.id, r]));
  store.citizens = new Map(w.citizens.map((c) => [c.id, c]));
  store.conversations = new Map(convs.map((c) => [c.id, c]));
  store.objects = new Map((w.objects ?? []).map((o) => [o.id, o]));
  store.observer = obs.report;
  store.observerStatus = obs.status;
  store.events = events;
  renderClock(w.clock);
  api.get('/api/governor').then((g) => { store.governor = g; renderGovernor(); }).catch(() => {});
  if (store.selectedId && !store.citizens.has(store.selectedId)) select(null);
  for (const t of ['rooms', 'citizens', 'conversations', 'observer', 'events', 'objects']) emit(t);
}

async function fetchConversation(id) {
  try {
    const conv = await api.get(`/api/conversations/${encodeURIComponent(id)}`);
    if (conv.active) {
      store.conversations.set(id, conv);
      emit('conversations');
      emit('conversation', id);
    }
  } catch { /* ended meanwhile */ }
}

// ---------- live stream ----------
function connect() {
  const es = new EventSource('/api/stream');
  const conn = $('#conn');
  es.onopen = () => {
    store.connected = true;
    conn.textContent = '● live';
    conn.className = 'pill on';
    loadWorld().catch((err) => console.error(err)); // resync after (re)connect
  };
  es.onerror = () => {
    store.connected = false;
    conn.textContent = 'offline';
    conn.className = 'pill off';
  };
  es.addEventListener('clock', (m) => renderClock(JSON.parse(m.data)));
  es.addEventListener('event', (m) => addEvent(JSON.parse(m.data)));
  es.addEventListener('citizen', (m) => {
    const c = JSON.parse(m.data);
    store.citizens.set(c.id, { ...(store.citizens.get(c.id) ?? {}), ...c });
    emit('citizen', c.id);
    emit('citizens');
  });
  es.addEventListener('room', (m) => {
    const r = JSON.parse(m.data);
    store.rooms.set(r.id, { ...(store.rooms.get(r.id) ?? {}), ...r });
    emit('rooms');
  });
  es.addEventListener('conversation', (m) => {
    const cv = JSON.parse(m.data);
    if (cv.ended) {
      store.conversations.delete(cv.id);
      emit('conversations');
      emit('conversationEnded', cv.id);
      return;
    }
    const known = store.conversations.get(cv.id);
    if (!known) return void fetchConversation(cv.id);
    known.participants = cv.participants ?? known.participants;
    known.held = cv.held ?? known.held;
    if (cv.line) {
      known.lines.push({ ...cv.line, speaker: citizenName(cv.line.speakerId), to: cv.line.toId ? citizenName(cv.line.toId) : null });
      for (const id of known.participants) if (!known.everParticipants.includes(id)) known.everParticipants.push(id);
    }
    emit('conversations');
    emit('conversation', cv.id);
  });
  es.addEventListener('observer', async () => {
    const obs = await api.get('/api/observer/latest').catch(() => null);
    if (obs) {
      store.observer = obs.report;
      store.observerStatus = obs.status;
      emit('observer');
    }
  });
  es.addEventListener('world', () => loadWorld());
  es.addEventListener('governor', (m) => {
    store.governor = JSON.parse(m.data);
    renderGovernor();
    emit('governor', store.governor);
  });
  es.addEventListener('memory', (m) => emit('memory', JSON.parse(m.data)));
  es.addEventListener('object', (m) => onObjectMessage(JSON.parse(m.data)));
  es.addEventListener('group', () => emit('groups'));
  es.addEventListener('emotion_room', (m) => emit('emotion_room', JSON.parse(m.data)));
  es.addEventListener('relationship', (m) => emit('relationship', JSON.parse(m.data)));
  es.addEventListener('llm', (m) => emit('llm', JSON.parse(m.data)));
}

// ---------- boot ----------
roster.mount($('#roster'));
inspector.mount($('#inspector'));
await loadWorld().catch((err) => console.error(err));
const initial = location.hash.replace(/^#\//, '');
document.addEventListener('click', (e) => {
  const ob = e.target.closest('[data-object]');
  if (ob && !e.target.closest('.modal form')) {
    e.stopPropagation();
    openObject(ob.dataset.object);
  }
}, true);

show(VIEWS.some((v) => v.id === initial) ? initial : 'world');
connect();

window.addEventListener('hashchange', () => {
  const id = location.hash.replace(/^#\//, '');
  if (id && id !== store.view) navigate(id);
});
