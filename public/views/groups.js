// Groups tab (step 5.5): every group with its members, kind and purpose. This is the director's view:
// secret groups and secret memberships are shown, marked 🔒. Parties show founder, purpose and where
// their members are right now.
import { store, subscribeMany, select } from '../store.js';
import { api, esc, gameTime, roomName, debounce } from '../util.js';
import { colorOf } from '../colors.js';
import { KIND_ICON } from './social-ui.js';

let root = null;
let groups = [];

export function mount(el) {
  root = el;
  el.innerHTML = '<div class="groups-view" id="groups-list"><p class="muted">Loading…</p></div>';
  el.addEventListener('click', (e) => {
    const c = e.target.closest('[data-citizen]');
    if (c) select(c.dataset.citizen);
  });
  const reload = debounce(load, 300);
  const off = subscribeMany(['groups', 'citizens'], reload);
  load();
  return () => {
    off();
    root = null;
  };
}

async function load() {
  try {
    groups = await api.get('/api/groups');
  } catch {
    groups = [];
  }
  render();
}

function render() {
  if (!root) return;
  const order = ['party', 'family', 'household', 'gang', 'guild', 'faction', 'village'];
  const live = groups.filter((g) => !g.dissolvedAt).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const gone = groups.filter((g) => g.dissolvedAt);
  const card = (g) => {
    const members = g.members.filter((m) => m.leftAt == null || g.dissolvedAt);
    const founder = g.data?.founderId ? store.citizens.get(g.data.founderId)?.name : null;
    return `<div class="card group-card ${g.public ? '' : 'secret'} ${g.dissolvedAt ? 'gone' : ''}">
      <h3>${KIND_ICON[g.kind] ?? '👥'} ${esc(g.name)} ${g.public ? '' : '<span class="lock" title="not publicly known">🔒 secret</span>'}</h3>
      <div class="dim">${esc(g.kind)} · ${esc(g.origin)}${founder ? ` · founded by ${esc(founder)}` : ''}${g.createdAt != null ? ` · since ${esc(gameTime(g.createdAt))}` : ''}${g.dissolvedAt ? ` · dissolved ${esc(gameTime(g.dissolvedAt))}` : ''}</div>
      ${g.data?.purpose ? `<div class="purpose">Purpose: ${esc(g.data.purpose)}</div>` : ''}
      ${g.data?.description ? `<div class="muted">${esc(g.data.description)}</div>` : ''}
      <div class="chips gmembers">${members.map((m) => `<span class="chip" data-citizen="${esc(m.citizenId)}" style="--c:${colorOf(m.citizenId)}">
          <span class="nm">${esc(m.name)}</span>${m.role && m.role !== 'member' ? `<span class="act">${esc(m.role)}</span>` : ''}${m.secret ? '<span title="secret membership">🔒</span>' : ''}
          ${g.kind === 'party' ? `<span class="act">@ ${esc(roomName(m.location))}</span>` : ''}</span>`).join('') || '<span class="empty">no members in the world</span>'}</div>
    </div>`;
  };
  root.querySelector('#groups-list').innerHTML = `
    <div class="groups-grid">${live.map(card).join('') || '<p class="muted">No groups.</p>'}</div>
    ${gone.length ? `<details><summary>Dissolved (${gone.length})</summary><div class="groups-grid">${gone.map(card).join('')}</div></details>` : ''}`;
}
