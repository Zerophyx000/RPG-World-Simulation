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
      <span class="r-name">${esc(c.name)}</span>${lifeMarks(c)}${emoIcons(c)}${bodyChips(c)}
      ${thinking ? '<span class="pulse" title="thinking"></span>' : ''}
      <span class="badges">${needBadges(c)}</span>
      <span class="r-loc">${esc(roomName(c.location))}</span>
    </div>
    <div class="r-act"><span>${ICONS[a.type] ?? '·'}</span> <span class="r-act-label" data-countdown="${esc(c.id)}">${esc(activityLabel(c))}</span></div>
    ${intentionLine(c)}
    <div class="r-thought">${c.lastInnerThought ? esc(c.lastInnerThought) : '<span class="dim">no thought yet</span>'}</div>
    ${c.lastInnerThought ? trimmedNote(c.lastInnerThought) : ''}
  </div>`;
}

// step 9.5: the top intention (small), or what code just did out of habit
function intentionLine(c) {
  if (c.habit) return `<div class="r-intent habit" title="carried out by habit (no model call)">↺ ${esc(c.habit)}</div>`;
  const i = c.intention;
  if (!i) return '';
  return `<div class="r-intent" title="top intention (weight ${i.weight})">→ ${esc(i.text)}</div>`;
}

// step 9.5: a black ribbon while grieving (>= 5), a mark while fearing for their own life
function lifeMarks(c) {
  const out = [];
  if (c.grieving) out.push(`<span class="r-mark ribbon" title="grieving ${esc(store.citizens.get(c.grieving.target)?.name ?? '')} (${c.grieving.intensity})">🎗</span>`);
  if (c.mortal || (c.mortality ?? 0) >= 4) out.push(`<span class="r-mark mortal ${esc(c.mortal ?? '')}" title="fears for their own life${c.mortal ? ` (body ${esc(c.mortal)})` : ''}">☠</span>`);
  return out.join('');
}

function updateCountdowns() {
  if (!root) return;
  for (const el of root.querySelectorAll('[data-countdown]')) {
    const c = store.citizens.get(el.dataset.countdown);
    if (c?.activity?.until != null) el.textContent = activityLabel(c);
  }
}
