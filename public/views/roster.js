// Roster: always-visible left column. One card per citizen in their color, with the latest
// inner thought (flashes when it changes). Click = inspector, shift-click = filter the main view.
import { store, subscribe, select, setFilter } from '../store.js';
import { esc, ICONS, activityLabel, roomName, needBadges } from '../util.js';
import { colorOf } from '../colors.js';
import { trimmedNote } from './inspector.js';
import { ringStyle, ringTitle, emoIcons } from './emotions-ui.js';
import { bodyChips } from './body-ui.js';

let root = null;
const lastThought = new Map();

export function mount(el) {
  root = el;
  el.addEventListener('click', (e) => {
    const card = e.target.closest('.roster-card');
    if (!card) return;
    if (e.shiftKey) setFilter(card.dataset.id);
    else select(store.selectedId === card.dataset.id ? null : card.dataset.id);
  });
  subscribe('citizens', renderAll);
  subscribe('citizen', renderOne);
  subscribe('selection', renderAll);
  subscribe('filter', renderAll);
  subscribe('conversations', renderAll);
  subscribe('clock', updateCountdowns);
  renderAll();
}

function sorted() {
  return [...store.citizens.values()].filter((c) => c.kind !== 'shadow').sort((a, b) => a.name.localeCompare(b.name));
}

function renderAll() {
  if (!root) return;
  const list = sorted();
  root.innerHTML = `<h2>Villagers <span class="dim">${list.length}</span></h2>${list.map(cardHtml).join('')}`;
  for (const c of list) lastThought.set(c.id, c.lastInnerThought ?? null);
}

function renderOne(id) {
  const c = store.citizens.get(id);
  const card = root?.querySelector(`.roster-card[data-id="${CSS.escape(id)}"]`);
  if (!c || !card) return renderAll();
  const changed = (c.lastInnerThought ?? null) !== (lastThought.get(id) ?? null);
  lastThought.set(id, c.lastInnerThought ?? null);
  card.outerHTML = cardHtml(c);
  if (changed && c.lastInnerThought) {
    const fresh = root.querySelector(`.roster-card[data-id="${CSS.escape(id)}"] .r-thought`);
    fresh?.classList.add('flash');
  }
}

function cardHtml(c) {
  const a = c.activity ?? { type: 'idle' };
  const thinking = a.type === 'thinking';
  const classes = ['roster-card', a.type === 'sleeping' ? 'asleep' : '', a.type === 'collapsed' ? 'down' : '', c.id === store.selectedId ? 'selected' : '', store.filterCitizen && store.filterCitizen !== c.id ? 'dimmed' : '', c.alive === false ? 'dead' : ''];
  return `<div class="${classes.join(' ')}" data-id="${esc(c.id)}" style="--c:${colorOf(c.id)};${ringStyle(c)}" title="Click: inspect · Shift-click: filter${ringTitle(c) ? `\n${ringTitle(c)}` : ''}">
    <div class="r-head">
      <span class="r-name">${esc(c.name)}</span>${emoIcons(c)}${bodyChips(c)}
      ${thinking ? '<span class="pulse" title="thinking"></span>' : ''}
      <span class="badges">${needBadges(c)}</span>
      <span class="r-loc">${esc(roomName(c.location))}</span>
    </div>
    <div class="r-act"><span>${ICONS[a.type] ?? '·'}</span> <span class="r-act-label" data-countdown="${esc(c.id)}">${esc(activityLabel(c))}</span></div>
    ${planLine(c)}
    <div class="r-thought">${c.lastInnerThought ? esc(c.lastInnerThought) : '<span class="dim">no thought yet</span>'}</div>
    ${c.lastInnerThought ? trimmedNote(c.lastInnerThought) : ''}
  </div>`;
}

// "3/6 · baking the morning bread", dimmed while the plan is on hold.
function planLine(c) {
  const p = c.plan;
  if (!p || !p.total || p.status === 'abandoned') return '';
  const pct = Math.min(100, (p.cursor / p.total) * 100);
  const label = p.status === 'done' ? 'plan done' : `${Math.min(p.cursor + 1, p.total)}/${p.total} · ${p.current ?? ''}`;
  return `<div class="r-plan ${p.interrupted ? 'paused' : ''}" title="${esc(p.interrupted ? 'plan on hold' : "today's plan")}"><i style="width:${pct}%"></i><span>${esc(label)}</span></div>`;
}

function updateCountdowns() {
  if (!root) return;
  for (const el of root.querySelectorAll('[data-countdown]')) {
    const c = store.citizens.get(el.dataset.countdown);
    if (c?.activity?.until != null) el.textContent = activityLabel(c);
  }
}
