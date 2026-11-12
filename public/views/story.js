// Story: the observer's storylines as cards (active first), with a one-sentence headline on top.
// Observer output is for the UI only; citizens never see it.
import { store, subscribe, subscribeMany } from '../store.js';
import { api, esc, gameTime, dot, who, showEvent } from '../util.js';

const ORDER = { active: 0, dormant: 1, resolved: 2 };
let root = null;
let busy = false;
let message = '';

export function mount(el) {
  root = el;
  el.addEventListener('click', async (e) => {
    const km = e.target.closest('[data-ev]');
    if (km) return showEvent(km.dataset.ev);
    if (e.target.closest('#story-refresh')) {
      busy = true;
      message = 'observer is thinking…';
      render();
      try {
        const r = await api.post('/api/observer/run');
        message = r.error ? `failed: ${r.error}` : r.queued ? 'queued after the current run' : r.skipped ? r.skipped : '';
      } catch (err) {
        message = err.message;
      }
      busy = false;
      render();
    }
  });
  const offs = [subscribe('observer', render), subscribeMany(['citizens', 'filter'], render)];
  render();
  return () => {
    offs.forEach((off) => off());
    root = null;
  };
}

function render() {
  if (!root) return;
  const r = store.observer;
  const threads = (r?.threads ?? [])
    .filter((t) => !store.filterCitizen || t.involved?.includes(store.filterCitizen))
    .sort((a, b) => (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3));
  root.innerHTML = `
    <div class="story-head">
      <div>
        <div class="headline">${r ? esc(r.headline) : 'No observer report yet.'}</div>
        <div class="dim">${r ? `Observer report from ${esc(gameTime(r.gameTime))} · covers events up to #${r.lastEventId}` : 'The observer runs after conversations end and every game hour while the clock runs.'}
          ${store.observerStatus?.lastError ? ` · <span class="bad">last run failed: ${esc(store.observerStatus.lastError)}</span>` : ''}</div>
      </div>
      <div class="story-actions"><button id="story-refresh" ${busy ? 'disabled' : ''}>Refresh</button><div class="dim">${esc(message)}</div></div>
    </div>
    <div class="threads">${threads.length ? threads.map(card).join('') : '<p class="muted">No storylines yet.</p>'}</div>`;
}

function card(t) {
  return `<article class="thread ${esc(t.status)}">
    <header><h3>${esc(t.title)}</h3><span class="pill ${esc(t.status)}">${esc(t.status)}</span></header>
    <div class="people">${(t.involved ?? []).map((id) => `${dot(id)}${who(id)}`).join(' ')}</div>
    <p>${esc(t.summary)}</p>
    ${(t.keyMoments ?? []).length ? `<ul class="moments">${t.keyMoments.map((k) => `<li>${k.eventId ? `<a href="#" data-ev="${k.eventId}">#${k.eventId}</a> ` : ''}${esc(k.text)}</li>`).join('')}</ul>` : ''}
    <div class="dim tid">${esc(t.id)}</div>
  </article>`;
}
