// Conversations: active ones as live chat panels (bubbles in the speaker's color, the speaker's
// inner thought under each line, "…" for lines held by the reading floor), past ones below.
import { store, subscribe, subscribeMany } from '../store.js';
import { api, esc, gameTime, clockOnly, citizenName, roomName, who, dot, prefs } from '../util.js';
import { colorOf, tint } from '../colors.js';

let root = null;
let showThoughts = prefs.get('showThoughts', true);
let pastFilter = '';
let focusId = null;
const expanded = new Map(); // past conversation id -> full conversation (or 'loading')

/** Chat bubbles for a conversation (also used by the inspector). */
export function bubblesHtml(conv, { thoughts = true, compact = false } = {}) {
  const lines = (conv.lines ?? []).map((l) => {
    const to = l.toId ? ` <span class="b-to">→ ${esc(citizenName(l.toId))}</span>` : '';
    return `<div class="bubble" style="--c:${colorOf(l.speakerId)};--bg:${tint(l.speakerId, 0.14)}">
      <div class="b-head"><span class="b-who" data-citizen="${esc(l.speakerId)}">${esc(citizenName(l.speakerId))}</span>${to}
        <span class="b-time">${esc(clockOnly(l.gameTime))}</span></div>
      <div class="b-text">${esc(l.text)}</div>
      ${thoughts && l.thought ? `<div class="b-thought">${esc(l.thought)}</div>` : ''}
    </div>`;
  }).join('');
  const held = (conv.held ?? []).map((h) => `<div class="bubble typing" style="--c:${colorOf(h.citizenId)};--bg:${tint(h.citizenId, 0.1)}">
      <div class="b-head"><span class="b-who">${esc(citizenName(h.citizenId))}</span> <span class="dim">is about to speak</span></div>
      <div class="b-text"><span class="dots"><i></i><i></i><i></i></span></div></div>`).join('');
  return `<div class="bubbles ${compact ? 'compact' : ''}">${lines || '<p class="muted">Nothing said yet.</p>'}${held}</div>`;
}

export function mount(el, params = {}) {
  root = el;
  focusId = params.conversationId ?? null;
  pastFilter = store.filterCitizen ?? '';
  el.innerHTML = `
    <div class="conv-toolbar">
      <h2>Active conversations</h2>
      <label class="check"><input type="checkbox" id="cv-thoughts" ${showThoughts ? 'checked' : ''}> Show thoughts</label>
    </div>
    <div class="conv-panels" id="cv-active"></div>
    <div class="conv-toolbar">
      <h2>Past conversations</h2>
      <select id="cv-filter"><option value="">everyone</option></select>
    </div>
    <div id="cv-past" class="conv-past"></div>`;

  el.querySelector('#cv-thoughts').addEventListener('change', (e) => {
    showThoughts = e.target.checked;
    prefs.set('showThoughts', showThoughts);
    renderActive();
    renderPast();
  });
  el.querySelector('#cv-filter').addEventListener('change', (e) => {
    pastFilter = e.target.value;
    loadPast();
  });
  el.querySelector('#cv-past').addEventListener('click', (e) => {
    const row = e.target.closest('[data-past]');
    if (!row || e.target.closest('[data-citizen]')) return;
    togglePast(row.dataset.past);
  });

  const offs = [
    subscribe('conversations', renderActive),
    subscribe('conversation', renderPanel),
    subscribe('conversationEnded', () => {
      renderActive();
      loadPast();
    }),
    subscribeMany(['citizens'], fillFilter),
    subscribe('filter', (id) => {
      pastFilter = id ?? '';
      fillFilter();
      loadPast();
      renderActive();
    }),
  ];
  fillFilter();
  renderActive();
  loadPast();
  return () => {
    offs.forEach((off) => off());
    root = null;
  };
}

export function update(params = {}) {
  focusId = params.conversationId ?? null;
  renderActive();
  if (focusId && !store.conversations.has(focusId)) togglePast(focusId, true);
}

function fillFilter() {
  const sel = root?.querySelector('#cv-filter');
  if (!sel) return;
  sel.innerHTML = `<option value="">everyone</option>${[...store.citizens.values()]
    .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}`;
  sel.value = pastFilter;
}

// ---------- active ----------
function panelHtml(conv) {
  const people = (conv.participants ?? []).map((id) => `${dot(id)}${who(id)}`).join(' ');
  return `<section class="conv-panel ${conv.id === focusId ? 'focused' : ''}" data-conv="${esc(conv.id)}">
    <header><b>${esc(roomName(conv.roomId))}</b> <span class="people">${people}</span>
      <span class="dim">${(conv.lines ?? []).length} lines</span></header>
    <div class="conv-scroll">${bubblesHtml(conv, { thoughts: showThoughts })}</div>
  </section>`;
}

function visibleActive() {
  const list = [...store.conversations.values()];
  return pastFilter ? list.filter((c) => c.everParticipants?.includes(pastFilter) || c.participants?.includes(pastFilter)) : list;
}

function renderActive() {
  const box = root?.querySelector('#cv-active');
  if (!box) return;
  const list = visibleActive();
  box.innerHTML = list.length ? list.map(panelHtml).join('') : '<p class="muted">Nobody is talking right now.</p>';
  for (const s of box.querySelectorAll('.conv-scroll')) s.scrollTop = s.scrollHeight;
  if (focusId) box.querySelector(`[data-conv="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'nearest' });
}

// Re-render one panel, keeping the scroll position unless the reader was at the bottom.
function renderPanel(id) {
  const panel = root?.querySelector(`[data-conv="${CSS.escape(id)}"]`);
  const conv = store.conversations.get(id);
  if (!panel || !conv) return renderActive();
  const scroller = panel.querySelector('.conv-scroll');
  const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
  const prev = scroller.scrollTop;
  panel.outerHTML = panelHtml(conv);
  const fresh = root.querySelector(`[data-conv="${CSS.escape(id)}"] .conv-scroll`);
  fresh.scrollTop = atBottom ? fresh.scrollHeight : prev;
}

// ---------- past ----------
let pastList = [];

async function loadPast() {
  try {
    pastList = await api.get(`/api/conversations?active=0&limit=80${pastFilter ? `&citizen=${encodeURIComponent(pastFilter)}` : ''}`);
  } catch {
    pastList = [];
  }
  renderPast();
}

async function togglePast(id, forceOpen = false) {
  if (expanded.has(id) && !forceOpen) {
    expanded.delete(id);
    return renderPast();
  }
  expanded.set(id, 'loading');
  renderPast();
  try {
    expanded.set(id, await api.get(`/api/conversations/${encodeURIComponent(id)}`));
  } catch (err) {
    expanded.set(id, { error: err.message });
  }
  renderPast();
  root?.querySelector(`[data-past="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

function renderPast() {
  const box = root?.querySelector('#cv-past');
  if (!box) return;
  if (!pastList.length) {
    box.innerHTML = '<p class="muted">No finished conversations yet.</p>';
    return;
  }
  box.innerHTML = pastList.map((c) => {
    const ex = expanded.get(c.id);
    const body = !ex ? '' : ex === 'loading' ? '<p class="muted">Loading…</p>'
      : ex.error ? `<p class="bad">${esc(ex.error)}</p>` : bubblesHtml(ex, { thoughts: showThoughts });
    return `<div class="past ${ex ? 'open' : ''} ${c.id === focusId ? 'focused' : ''}" data-past="${esc(c.id)}">
      <div class="past-row">
        <span class="people">${c.participants.map((id) => `${dot(id)}${who(id)}`).join(' ')}</span>
        <span>${esc(roomName(c.roomId))}</span>
        <span class="dim">${esc(gameTime(c.startedAt))}–${esc(clockOnly(c.endedAt))}</span>
        <span class="dim">${c.lineCount} lines</span>
        <span class="pill">${esc(c.reason)}</span>
      </div>
      ${body ? `<div class="past-body">${body}</div>` : ''}
    </div>`;
  }).join('');
}
