// Schemes tab (step 11): the director's view of everyone's long game — ambitions (kind, intensity, secrecy, history
// of changes with reasons), schemes (goal, owner, targets, status, steps done / due / pending / failed, accomplices with
// commitment, who knows, revision history; a step links to its moment on the timeline) and lies (said vs. truth, kind,
// why, who heard it and each one's verdict, retellings, status; filter by liar, listener, standing / caught).
// You see everything. Nothing here reaches any citizen.
import { store, subscribeMany, select } from '../store.js';
import { api, esc, gameTime, roomName, debounce, navigate } from '../util.js';
import { colorOf } from '../colors.js';

let root = null;
let data = { ambitions: [], schemes: [], lies: [] };
const filter = { liar: '', listener: '', status: '' };
const KIND_ICON = { mastery: '⚒', wealth: '💰', status: '👑', bond: '❤', protect: '🛡', revenge: '🗡', belonging: '🏠', freedom: '🕊', secret: '🔒', other: '•' };
const SECRECY = { open: '', private: '🤐', secret: '🔒' };
const STEP_ICON = { done: '✔', failed: '✘', pending: '·' };
const who = (id) => `<span class="who" data-citizen="${esc(id)}" style="color:${colorOf(id)}">${esc(store.citizens.get(id)?.name ?? id)}</span>`;

const CSS = `
.sch-view { padding: 10px 14px; display: grid; gap: 14px; }
.sch-view h3 { margin: 4px 0; }
.sch-card { background: var(--panel, #1a1d23); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
.sch-card .head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.sch-card .muted, .sch-view .muted { color: var(--muted); }
.sch-steps { margin: 4px 0 0; padding-left: 0; list-style: none; }
.sch-steps li { padding: 1px 0; }
.sch-steps li.due { color: #f0c060; }
.sch-steps li.done { color: #7fbf7f; }
.sch-steps li.failed { color: #e07070; text-decoration: line-through; }
.sch-pill { font-size: 11px; padding: 0 6px; border-radius: 8px; background: #2a2f38; }
.sch-pill.exposed, .sch-pill.caught, .sch-pill.betrayed, .sch-pill.failed { background: #5a2a2a; }
.sch-pill.done, .sch-pill.confessed, .sch-pill.achieved { background: #2a4a2a; }
.sch-truth { color: #d8b47a; }
.sch-hist { font-size: 11px; color: var(--muted); margin-top: 3px; }
.sch-filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.sch-bar { display: inline-block; height: 6px; background: #c08040; border-radius: 3px; vertical-align: middle; }
`;
const injectCss = () => { if (document.getElementById('css-schemes')) return; const s = document.createElement('style'); s.id = 'css-schemes'; s.textContent = CSS; document.head.append(s); };

export function mount(el) {
  root = el;
  injectCss();
  el.innerHTML = '<div class="sch-view" id="sch"><p class="muted">Loading…</p></div>';
  el.addEventListener('click', (e) => {
    const c = e.target.closest('[data-citizen]');
    if (c) { select(c.dataset.citizen); return; }
    const t = e.target.closest('[data-at]');
    if (t) navigate("timeline", { at: Number(t.dataset.at) }); // the moment a step was done
  });
  el.addEventListener('change', (e) => {
    const f = e.target.closest('[data-filter]');
    if (f) { filter[f.dataset.filter] = f.value; render(); }
  });
  const reload = debounce(load, 400);
  const off = subscribeMany(['scheming', 'citizens'], reload);
  load();
  return () => { off(); root = null; };
}

async function load() {
  try {
    const [ambitions, schemes, lies] = await Promise.all([api.get('/api/ambitions'), api.get('/api/schemes?limit=200'), api.get('/api/lies?limit=300')]);
    data = { ambitions, schemes, lies };
  } catch { /* keep the last */ }
  render();
}

function ambitionsHtml() {
  const by = new Map();
  for (const a of data.ambitions) (by.get(a.citizenId) ?? by.set(a.citizenId, []).get(a.citizenId)).push(a);
  if (!by.size) return '<p class="muted">No ambitions yet (they are generated soon after boot).</p>';
  return [...by].map(([cid, list]) => `<div class="sch-card"><div class="head">${who(cid)}</div>
    <ul class="sch-steps">${list.map((a) => `<li class="${a.status === 'active' ? '' : 'done'}" title="${esc((a.data.history ?? []).map((h) => `${gameTime(h.at)} ${h.op}${h.why ? `: ${h.why}` : ''}`).join('\n'))}">
      ${KIND_ICON[a.kind] ?? '•'} ${esc(a.text)} ${SECRECY[a.secrecy] ?? ''} <span class="sch-bar" style="width:${a.intensity * 6}px" title="intensity ${a.intensity}"></span>
      ${a.status !== 'active' ? `<span class="sch-pill ${esc(a.status)}">${esc(a.status)}</span>` : ''}${a.targetNames?.length ? ` <span class="muted">→ ${esc(a.targetNames.join(', '))}</span>` : ''} <span class="muted">(${esc(a.origin)})</span>
      ${(a.data.history ?? []).length > 1 ? `<div class="sch-hist">${(a.data.history ?? []).slice(-3).map((h) => `${esc(gameTime(h.at))} ${esc(h.op)}${h.why ? `: ${esc(h.why)}` : ''}`).join(' · ')}</div>` : ''}</li>`).join('')}</ul></div>`).join('');
}

function schemesHtml() {
  if (!data.schemes.length) return '<p class="muted">No schemes. (Planning happens only at reflection and in sleep; many people would rather wait and see.)</p>';
  return data.schemes.map((s) => {
    const due = s.steps.find((st) => st.status === 'pending' && st.dueSince != null);
    return `<div class="sch-card"><div class="head">${who(s.ownerId)} <b>${esc(s.goal)}</b> <span class="sch-pill ${esc(s.status)}">${esc(s.status)}</span>
      ${s.targetIds.length ? `<span class="muted">against</span> ${s.targetIds.map(who).join(', ')}` : ''}</div>
      <ol class="sch-steps">${s.steps.map((st) => `<li class="${st === due ? 'due' : st.status}"${st.doneAt != null ? ` data-at="${Math.floor(st.doneAt)}" style="cursor:pointer"` : ''}>
        ${STEP_ICON[st.status] ?? '·'} ${esc(st.text)} <span class="muted">[${esc(st.kind)}${st.placeName ? ` @ ${esc(st.placeName)}` : ''}${st.objectType ? `, ${esc(st.objectType)}` : ''}${st.when?.not_before != null ? `, not before ${esc(gameTime(st.when.not_before))}` : ''}]</span>${st === due ? ' <b>due</b>' : ''}${st.result ? ` — <i>${esc(st.result)}</i>` : ''}</li>`).join('')}</ol>
      ${s.accomplices.length ? `<div>Accomplices: ${s.accomplices.map((a) => `${who(a.citizen_id)} <span class="sch-pill ${esc(a.status)}">${esc(a.status)}${a.commitment != null ? ` ${a.commitment}` : ''}</span> <span class="muted">(${esc(a.knows)}, ${esc(a.role)})</span>`).join(' · ')}</div>` : ''}
      ${s.exposedTo.length ? `<div>Knows about it: ${s.exposedTo.map(who).join(', ')}</div>` : ''}
      ${s.data.risks ? `<div class="muted">Risks they see: ${esc(s.data.risks)}</div>` : ''}
      <div class="sch-hist">${(s.data.history ?? []).slice(-6).map((h) => `${esc(gameTime(h.at))} ${esc(h.op)}${h.why ? `: ${esc(h.why)}` : ''}`).join('<br>')}</div></div>`;
  }).join('');
}

function liesHtml() {
  const list = data.lies.filter((l) => (!filter.liar || l.liarId === filter.liar) && (!filter.listener || l.heardBy.some((h) => h.citizen_id === filter.listener)) && (!filter.status || l.status === filter.status));
  const people = [...store.citizens.values()];
  const opts = (sel) => `<option value="">anyone</option>${people.map((c) => `<option value="${esc(c.id)}"${sel === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}`;
  const filters = `<div class="sch-filters">liar <select data-filter="liar">${opts(filter.liar)}</select> heard by <select data-filter="listener">${opts(filter.listener)}</select>
    status <select data-filter="status"><option value="">any</option>${['standing', 'caught', 'confessed', 'retracted'].map((s) => `<option${filter.status === s ? ' selected' : ''}>${s}</option>`).join('')}</select> <span class="muted">${list.length} of ${data.lies.length}</span></div>`;
  if (!list.length) return `${filters}<p class="muted">No lies${data.lies.length ? ' match' : ' told yet'}.</p>`;
  return filters + list.map((l) => `<div class="sch-card"><div class="head">${who(l.liarId)} <span class="muted">${esc(gameTime(l.gameTime))}</span> <span class="sch-pill">${esc(l.kind)}</span> <span class="sch-pill ${esc(l.status)}">${esc(l.status)}</span>${l.schemeId ? ` <span class="muted">(scheme #${l.schemeId})</span>` : ''}</div>
    <div>said: “${esc(l.said)}”</div><div class="sch-truth">truth: ${esc(l.truth)}${l.why ? ` <span class="muted">— why: ${esc(l.why)}</span>` : ''}</div>
    ${l.checkWho || l.checkWhere ? `<div class="muted">claim: ${esc(l.checkWhoName ?? '?')} @ ${esc(l.checkWhereName ?? '?')}${l.checkFrom != null ? `, ${esc(gameTime(l.checkFrom))}–${esc(gameTime(l.checkTo))}` : ''}</div>` : ''}
    <div>heard by: ${l.heardBy.length ? l.heardBy.map((h) => `${who(h.citizen_id)} <span class="muted">(${esc(h.how)}${h.how === 'retold' ? ` from ${esc(h.fromName)}` : ''}, ${esc(h.verdict)})</span>`).join(' · ') : '<span class="muted">nobody (an act)</span>'}</div>
    ${(l.data.contradicted ?? []).length ? `<div class="sch-hist">contradictions: ${(l.data.contradicted ?? []).map((x) => `${esc(store.citizens.get(x.listener)?.name ?? x.listener)}: ${esc(x.why.replace(/\{\{[cp]:(\w+)\}\}/g, (_m, id) => store.citizens.get(id)?.name ?? id))}`).join(' · ')}</div>` : ''}</div>`).join('');
}

function render() {
  if (!root) return;
  const box = root.querySelector('#sch');
  box.innerHTML = `<section><h3>Ambitions</h3>${ambitionsHtml()}</section><section><h3>Schemes</h3>${schemesHtml()}</section><section><h3>Lies</h3>${liesHtml()}</section>`;
}
