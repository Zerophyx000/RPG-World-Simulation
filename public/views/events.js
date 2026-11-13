// Event log: readable sentences with filter chips by category, live, with "load older".
// Step A5 (display only): an object request and its result become ONE line, and a short walk becomes
// "<Name> goes to <room>". The database keeps every raw event; "show raw" lists them unmerged.
import { store, subscribe } from '../store.js';
import { api, esc, gameTime, eventHtml, eventCategory, showEvent, prefs, who, roomName } from '../util.js';

const CATEGORIES = ['speech', 'action', 'object', 'social', 'emotion', 'body', 'memory', 'movement', 'director', 'interrupt', 'system', 'activity'];
let enabled = new Set(prefs.get('eventCats', ['speech', 'action', 'object', 'social', 'emotion', 'body', 'movement', 'director', 'interrupt']));
let raw = Boolean(prefs.get('eventsRaw', false));
let root = null;

// Merging windows. A result lands a few events after its request (an examine or search takes minutes
// of doing), so that window is counted in events; a walk only folds when the walk itself is short.
const OBJECT_TOOLS = new Set(['take', 'put', 'give', 'examine', 'search', 'use']);
const MOVE_TOOLS = new Set(['move_to', 'travel_to']);
const MERGED_RESULT_TYPES = new Set(['object', 'examine', 'search', 'arrive']); // requests keep type 'action'
const RESULT_WINDOW = 4; // events between a request and its result
const ARRIVE_WINDOW = 2; // game minutes between setting off and arriving (village legs are 1–3)

const actorOf = (e) => e.actor_id ?? e.actorId ?? null;
const whenOf = (e) => e.game_time ?? e.gameTime ?? 0;
/** Events that can gain or lose a line by merging (everything else is just prepended live). */
const pairable = (e) => e.type === 'action'
  ? OBJECT_TOOLS.has(e.data?.tool) || MOVE_TOOLS.has(e.data?.tool)
  : MERGED_RESULT_TYPES.has(e.type);

export function mount(el) {
  root = el;
  el.innerHTML = `<div class="row"><div class="chipbar" id="ev-chips" style="flex:1 1 auto; margin-bottom:0"></div>
      <label class="check"><input type="checkbox" id="ev-raw"> show raw</label></div>
    <ul class="log events" id="ev-list"></ul>
    <div class="row"><button id="ev-older">Load older</button><span class="dim" id="ev-count"></span></div>`;
  el.querySelector('#ev-raw').checked = raw;
  el.querySelector('#ev-raw').addEventListener('change', (e) => {
    raw = e.target.checked;
    prefs.set('eventsRaw', raw);
    renderList();
  });
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
      if (!raw && pairable(e)) return renderList(); // it may fold into (or absorb) a neighbour
      const list = root?.querySelector('#ev-list');
      if (!list) return;
      list.insertAdjacentHTML('afterbegin', rowHtml(e));
      while (list.children.length > 600) list.lastChild.remove();
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

// ---------- merging (step A5) ----------
// The store list is newest first; the pairing pass walks it oldest first, so a request is always seen
// before its result. A folded event is skipped when its turn comes. Both members must survive the same
// category / citizen filters (they are the same actor and category), so filtered views stay correct.

/** The result event that answers the request at i, if it is close enough to merge with. */
function pairFor(events, i, folded) {
  const a = events[i];
  if (a.type !== 'action') return null;
  const actor = actorOf(a);
  if (OBJECT_TOOLS.has(a.data?.tool)) return objectResult(events, i, actor, folded);
  if (MOVE_TOOLS.has(a.data?.tool)) return arrivalFor(events, i, actor, folded);
  return null;
}

// An object result for the same actor: matching thing, a few events later at the most.
function objectResult(events, i, actor, folded) {
  const a = events[i];
  const id = a.data?.objectId ?? a.data?.targetId ?? null;
  for (let j = i + 1; j <= i + RESULT_WINDOW && j < events.length; j++) {
    const e = events[j];
    if (folded.has(e.id) || actorOf(e) !== actor) continue; // folded: already spoken for by an earlier request
    const d = e.data ?? {};
    if (e.type === 'search') {
      if ((d.targetId ?? null) === id && e.location === a.location) return e;
    } else if ((e.type === 'object' || e.type === 'examine') && d.objectId === id) {
      return e;
    }
  }
  return null;
}

// The arrival that ends this leg, when the whole leg is short. A longer journey (route with legs,
// or a slow exit) keeps every line, so passing through stays visible.
function arrivalFor(events, i, actor, folded) {
  const a = events[i];
  const dest = a.data?.args?.destination;
  if (!dest) return null;
  for (let j = i + 1; j < events.length && whenOf(events[j]) - whenOf(a) <= ARRIVE_WINDOW; j++) {
    const e = events[j];
    if (folded.has(e.id) || e.type !== 'arrive' || actorOf(e) !== actor) continue;
    if (e.location !== dest) return null; // an arrival elsewhere means this walk didn't end here
    return e;
  }
  return null;
}

/** What a merged pair shows: the result speaks, the request's inner thought rides along. */
function mergedView(request, result) {
  const thought = request.data?.thought ? ` <span class="ithought">(${esc(request.data.thought)})</span>` : '';
  return {
    id: result.id,
    cat: eventCategory(result),
    html: result.type === 'arrive'
      ? `${who(actorOf(request))} goes to ${esc(roomName(result.location))}${thought}`
      : `${eventHtml(result)}${thought}`,
  };
}

// Newest-first store events → html rows (newest first), request+result pairs folded into one line.
// The pairing pass walks oldest→newest so a request is seen before its result.
function mergedRows(events) {
  const old = [...events].reverse();
  const folded = new Set();
  const rows = [];
  for (let i = 0; i < old.length; i++) {
    const e = old[i];
    if (folded.has(e.id)) continue;
    const result = pairFor(old, i, folded);
    if (!result) {
      rows.push(rowHtml(e));
      continue;
    }
    folded.add(result.id);
    rows.push(rowHtml(e, mergedView(e, result))); // the request's slot keeps the list time-ordered
  }
  return rows.reverse();
}

function rowHtml(e, merged = null) {
  const cat = merged?.cat ?? eventCategory(e);
  return `<li data-id="${merged?.id ?? e.id}" class="cat-${cat} ${e.type === 'conversation_end' ? 'conv-end' : ''}">
    <span class="t">${esc(gameTime(whenOf(e)))}</span><span class="type">${esc(cat)}</span><span class="sentence">${merged?.html ?? eventHtml(e)}</span></li>`;
}

function renderList() {
  if (!root) return;
  const all = store.events.filter(visible);
  const rows = (raw ? all.map((e) => rowHtml(e)) : mergedRows(all)).slice(0, 600);
  root.querySelector('#ev-list').innerHTML = rows.join('') || '<li class="dim">No events match.</li>';
  root.querySelector('#ev-count').textContent = `${rows.length} shown of ${store.events.length} loaded`;
}

function renderAll() {
  if (!root) return;
  root.querySelector('#ev-chips').innerHTML = CATEGORIES.map((c) =>
    `<button class="fchip ${enabled.has(c) ? 'on' : ''}" data-cat="${c}">${c}</button>`).join('');
  renderList();
}

async function loadOlder() {
  const oldest = store.events.at(-1)?.id;
  if (!oldest) return;
  const more = await api.get(`/api/events?before=${oldest}&limit=400`);
  store.events.push(...more);
  renderAll();
}
