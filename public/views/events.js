// Event log: readable sentences with filter chips by category, live, with "load older".
import { store, subscribe } from '../store.js';
import { api, esc, gameTime, eventHtml, eventCategory, showEvent, prefs } from '../util.js';

const CATEGORIES = ['speech', 'action', 'object', 'social', 'body', 'memory', 'movement', 'director', 'interrupt', 'system', 'activity'];
let enabled = new Set(prefs.get('eventCats', ['speech', 'action', 'object', 'social', 'body', 'movement', 'director', 'interrupt']));
let root = null;

export function mount(el) {
  root = el;
  el.innerHTML = `<div class="chipbar" id="ev-chips"></div><ul class="log events" id="ev-list"></ul>
    <div class="row"><button id="ev-older">Load older</button><span class="dim" id="ev-count"></span></div>`;
  el.querySelector('#ev-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    enabled.has(b.dataset.cat) ? enabled.delete(b.dataset.cat) : enabled.add(b.dataset.cat);
    prefs.set('eventCats', [...enabled]);
    renderAll();
  });
  el.querySelector('#ev-list').addEventListener('click', (e) => {
    if (e.target.closest('[data-citizen], details, a, button')) return;
    const li = e.target.closest('li[data-id]');
    if (li) showEvent(li.dataset.id);
  });
  el.querySelector('#ev-older').addEventListener('click', loadOlder);
  const offs = [
    subscribe('event', (e) => {
      if (!visible(e)) return;
      const list = root?.querySelector('#ev-list');
      list?.insertAdjacentHTML('afterbegin', rowHtml(e));
      while (list && list.children.length > 600) list.lastChild.remove();
    }),
    subscribe('events', renderAll),
    subscribe('filter', renderAll),
  ];
  renderAll();
  return () => {
    offs.forEach((off) => off());
    root = null;
  };
}

function visible(e) {
  if (!enabled.has(eventCategory(e))) return false;
  const f = store.filterCitizen;
  if (!f) return true;
  const d = e.data ?? {};
  if (e.type === 'body' && (d.importance ?? 0) < 5) return false;
  return (e.actor_id ?? e.actorId) === f || d.toId === f || d.citizenId === f || (Array.isArray(d.targets) && d.targets.includes(f))
    || (d.participants ?? []).some((p) => p.id === f) || (d.delivered ?? []).some((x) => x.id === f);
}

function rowHtml(e) {
  const cat = eventCategory(e);
  return `<li data-id="${e.id}" class="cat-${cat} ${e.type === 'conversation_end' ? 'conv-end' : ''}">
    <span class="t">${esc(gameTime(e.game_time ?? e.gameTime))}</span><span class="type">${esc(cat)}</span><span class="sentence">${eventHtml(e)}</span></li>`;
}

function renderAll() {
  if (!root) return;
  root.querySelector('#ev-chips').innerHTML = CATEGORIES.map((c) =>
    `<button class="fchip ${enabled.has(c) ? 'on' : ''}" data-cat="${c}">${c}</button>`).join('');
  const rows = store.events.filter(visible).slice(0, 600);
  root.querySelector('#ev-list').innerHTML = rows.map(rowHtml).join('') || '<li class="dim">No events match.</li>';
  root.querySelector('#ev-count').textContent = `${rows.length} shown of ${store.events.length} loaded`;
}

async function loadOlder() {
  const oldest = store.events.at(-1)?.id;
  if (!oldest) return;
  const more = await api.get(`/api/events?before=${oldest}&limit=400`);
  store.events.push(...more);
  renderAll();
}
