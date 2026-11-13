// Inspector: right drawer for one citizen, ordered for reading:
// header → needs → inner thought → model reasoning → plan → conversation → inbox → memories (core memory +
// constellation) → relationships → nights → places → carrying / known objects / last seen → act → persona →
// prompt preview → LLM calls.
import { store, subscribe, select } from '../store.js';
import { api, esc, gameTime, ICONS, activityLabel, roomName, debounce, navigate } from '../util.js';
import { colorOf } from '../colors.js';
import { bubblesHtml } from './conversations.js';
import { showCall } from './llm.js';
import { actPanelHtml, bindActPanels } from './act.js';
import { memState, constellationHtml, coreMemoryHtml, nightsHtml, relationshipsHtml, planHtml } from './memories.js';
import { showEvent } from '../util.js';
import { openReasons, warinessHtml, groupChip } from './social-ui.js';
import { emotionsPanelHtml, emotionTypes } from './emotions-ui.js';

let emoHistory = null; // GET /api/citizens/:id/emotions/history (last game days)
let emoFor = null;

let root = null;
let data = null;
let mems = null;   // GET /api/citizens/:id/memories
let nights = null; // GET /api/citizens/:id/consolidations
const open = new Set(['reasoning', 'plan', 'memories', 'rels', 'objects']); // which <details> are open (reasoning starts open)

export function mount(el) {
  root = el;
  subscribe('selection', () => {
    data = null;
    mems = null;
    nights = null;
    memState.pinned = null;
    memState.person = null;
    root.classList.toggle('hidden', !store.selectedId);
    if (store.selectedId) load();
  });
  const refresh = debounce(load, 250);
  subscribe('citizen', (id) => id === store.selectedId && refresh());
  subscribe('conversation', (id) => data?.conversationId === id && refresh());
  subscribe('llm', (call) => call?.citizenId === store.selectedId && refresh());
  subscribe('clock', updateCountdown);
  const refreshMem = debounce(loadMemories, 800);
  subscribe('memory', (m) => m?.citizenId === store.selectedId && refreshMem());
  subscribe('relationship', (r) => r?.citizenId === store.selectedId && refresh());
  subscribe('objects', () => store.selectedId && refresh());

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) select(null);
    const call = e.target.closest('[data-call]');
    if (call) {
      navigate('llm');
      showCall(Number(call.dataset.call));
    }
    const conv = e.target.closest('[data-open-conv]');
    if (conv) navigate('conversations', { conversationId: conv.dataset.openConv });
    const why = e.target.closest('[data-reasons]');
    if (why && data) openReasons(data.id, why.dataset.reasons);
    const ev = e.target.closest('[data-show-event]');
    if (ev) showEvent(ev.dataset.showEvent);
    const dot = e.target.closest('[data-mem]');
    if (dot) {
      memState.pinned = memState.pinned === Number(dot.dataset.mem) ? null : Number(dot.dataset.mem);
      render();
    }
    const person = e.target.closest('[data-mem-person]');
    if (person) {
      memState.person = memState.person === person.dataset.memPerson ? null : person.dataset.memPerson;
      render();
    }
    if (e.target.closest('[data-core-history]')) {
      memState.coreHistory = !memState.coreHistory;
      render();
    }
  });
  el.addEventListener('change', (e) => {
    const t = e.target.closest('[data-mem-toggle]');
    if (!t) return;
    memState[t.dataset.memToggle] = t.checked;
    render();
  });
  bindActPanels(el, () => setTimeout(load, 300));
  el.addEventListener('focusout', () => setTimeout(() => renderPending && render(), 50));
  el.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d.tagName === 'DETAILS' && d.dataset.key) d.open ? open.add(d.dataset.key) : open.delete(d.dataset.key);
  }, true);
}

async function load() {
  const id = store.selectedId;
  if (!id) return;
  try {
    const d = await api.get(`/api/citizens/${encodeURIComponent(id)}`);
    if (id !== store.selectedId) return;
    data = d;
    if (!mems) loadMemories();
    loadEmotionHistory(id);
  } catch (err) {
    root.innerHTML = `<button class="close" data-close>✕</button><p class="bad">${esc(err.message)}</p>`;
    return;
  }
  render();
}

// The mood line needs the hourly samples; refetched at most every few seconds.
let emoLoadedAt = 0;
async function loadEmotionHistory(id) {
  if (emoFor === id && Date.now() - emoLoadedAt < 8000) return;
  emoFor = id;
  emoLoadedAt = Date.now();
  await emotionTypes();
  const now = store.clock?.gameMinutes ?? 0;
  try {
    const h = await api.get(`/api/citizens/${encodeURIComponent(id)}/emotions/history?from=${Math.floor(now - 5 * 1440)}&limit=1500`);
    if (id !== store.selectedId) return;
    emoHistory = h;
    render();
  } catch { /* panel shows without the mood line */ }
}

async function loadMemories() {
  const id = store.selectedId;
  if (!id) return;
  try {
    const [m, n] = await Promise.all([
      api.get(`/api/citizens/${encodeURIComponent(id)}/memories`),
      api.get(`/api/citizens/${encodeURIComponent(id)}/consolidations`),
    ]);
    if (id !== store.selectedId) return;
    mems = m;
    nights = n;
  } catch { /* ignore */ }
  render();
}

// UI shows real names: {{c:id}} tokens in stored texts become names.
const detok = (t) => String(t ?? '').replace(/\{\{c:([\w-]+)\}\}/g, (_m, id) => store.citizens.get(id)?.name ?? id);

// Need bars with tick marks at the level thresholds.
function needBars(c) {
  const v = c.needsView;
  if (!v) return '';
  const bar = (k, label) => {
    const n = v[k];
    const max = n.max || 100;
    const pct = Math.max(0, Math.min(100, (n.value / max) * 100));
    // hunger/fatigue: higher is worse; hp: lower is worse
    const sev = k === 'hp' ? 1 - pct / 100 : pct / 100;
    const ticks = n.thresholds.filter((t) => t.at > 0 && t.at < max)
      .map((t) => `<i style="left:${(t.at / max) * 100}%" title="${esc(t.name)}"></i>`).join('');
    const remind = n.nextReminderIn != null ? ` · reminder in ${Math.ceil(n.nextReminderIn)} min` : '';
    return `<div class="nbar"><div class="nbar-head"><span>${label}</span><b>${esc(n.levelName)}</b>
        <span class="dim">${Math.round(n.value)}/${max}${remind}</span></div>
      <div class="nbar-track"><div class="nbar-fill" style="width:${pct}%;--sev:${sev}"></div>${ticks}</div></div>`;
  };
  return `<div class="nbars">${bar('hunger', '🍞 hunger')}${bar('fatigue', '😴 fatigue')}${bar('hp', '❤️ health')}</div>`;
}

function knownPlacesHtml(c) {
  const list = c.knownPlacesView ?? [];
  if (!list.length) return '<p class="muted">Knows no places.</p>';
  const src = (k) => (k.source === 'home' ? 'home' : k.source === 'local' ? 'local' : k.source === 'visited' ? 'been there'
    : k.sourceName ? `told by ${esc(k.sourceName)}` : esc(k.source));
  return `<ul class="places">${list.map((k) => `<li><b>${esc(k.name)}</b> ${k.services.map((s) => (s === 'food' ? '🍲' : s === 'bed' ? '🛏' : esc(s))).join('')}
    <span class="dim">${src(k)}</span></li>`).join('')}</ul>`;
}

const details = (key, title, inner) =>
  `<details data-key="${key}" ${open.has(key) ? 'open' : ''}><summary>${esc(title)}</summary>${inner}</details>`;

function stimList(list, pending) {
  return list.map((s) => `<li class="${pending ? 'pending' : ''}">
      <span class="imp ${s.importance >= 8 ? 'hi' : ''}" title="importance">${s.importance}</span>
      <span><span class="dim">${esc(gameTime(s.gameTime))} · ${esc(s.kind)}${s.data?.level ? ` · ${esc(s.data.level)}` : ''}</span><br>${esc(s.text)}</span>
    </li>`).join('');
}

let renderPending = false;

function render() {
  // Don't wipe a field the user is typing in; render when they leave it.
  const ae = document.activeElement;
  if (root && ae && root.contains(ae) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(ae.tagName)) {
    renderPending = true;
    return;
  }
  renderPending = false;
  const c = data;
  if (!root || !c) return;
  const scroll = root.scrollTop;
  const p = c.persona ?? {};
  const a = c.activity ?? { type: 'idle' };
  const color = colorOf(c.id);
  const traits = Object.entries(p.traits ?? {}).map(([k, v]) => `${k} ${Number(v).toFixed(2)}`).join(', ');
  const conv = c.conversation;
  const inbox = stimList(c.thinkingInbox ?? [], true) + stimList(c.inbox ?? [], false);
  const prompt = (c.promptPreview ?? []).map((m) => `=== ${m.role.toUpperCase()} ===\n${m.content}`).join('\n\n');

  root.innerHTML = `
    <button class="close" data-close title="Close (Esc)">✕</button>
    <div class="insp-head" style="--c:${color}">
      <h2 style="color:${color}">${esc(c.name)}</h2>
      <div class="dim">${esc(p.occupation ?? '')} · ${esc(roomName(c.location))}${c.needs?.hp != null && c.needs.hp < 100 ? ` · <span class="bad">hp ${Math.round(c.needs.hp)}</span>` : ''}</div>
      <div class="activity-line">${ICONS[a.type] ?? ''} <b>${esc(a.type)}</b> · <span id="insp-activity">${esc(activityLabel({ ...c, activity: a }))}</span></div>
    </div>

    ${(c.groupsView ?? []).length ? `<div class="gchips">${c.groupsView.map(groupChip).join('')}</div>` : ''}
    ${(p.secretGoals ?? []).length ? `<div class="secret-goals" title="Only in their own prompt">🔒 ${p.secretGoals.map(esc).join(' · ')}</div>` : ''}
    ${needBars(c)}
    ${(c.marks ?? []).length ? `<div class="marks">${c.marks.map((m) => `<span class="mark">${esc(m.text)}</span>`).join('')}</div>` : ''}

    <h3>Emotions</h3>
    <div class="emo-panel">${emotionsPanelHtml(c.emotionsView, emoFor === c.id ? emoHistory : null)}</div>

    <h3>Inner thought</h3>
    ${c.lastInnerThought ? `<div class="inner-thought" style="border-color:${color}">“${esc(c.lastInnerThought)}”</div>` : '<div class="inner-thought none">No inner thought yet.</div>'}
    ${c.lastDecisionAt != null ? `<p class="muted">Last decision ${esc(gameTime(c.lastDecisionAt))}</p>` : ''}

    ${details('reasoning', 'Model reasoning', `<pre class="detail">${esc(c.lastThought ?? '(none)')}</pre>`)}

    ${details('plan', `Plan${c.planView ? ` · ${Math.min(c.planView.cursor, c.planView.steps.length)}/${c.planView.steps.length}` : ''}`, planHtml(c))}

    <h3>Conversation</h3>
    ${conv ? `<div class="mini-conv">${bubblesHtml(conv, { thoughts: true, compact: true })}</div>
      <button class="link" data-open-conv="${esc(conv.id)}">open in Conversations</button>` : '<p class="muted">Not in a conversation.</p>'}

    <h3>Inbox (${(c.inbox ?? []).length}${c.thinkingInbox?.length ? ` + ${c.thinkingInbox.length} being considered` : ''})</h3>
    ${inbox ? `<ul class="stims">${inbox}</ul>` : '<p class="muted">Empty.</p>'}

    ${(c.onMyMind ?? []).length ? `<h3>On their mind</h3><ul class="stims">${c.onMyMind.map((m) => `<li>${esc(detok(m.text))}</li>`).join('')}</ul>` : ''}

    ${details('memories', `Memories (${c.memoryCount ?? 0} active)`, `${coreMemoryHtml(mems, nights)}${constellationHtml(mems)}`)}

    ${details('rels', `Relationships (${(c.relationshipsView ?? []).length})`, relationshipsHtml(c, store.clock?.gameMinutes ?? 0))}

    ${details('strangers', `Strangers · trust in strangers ${Number(c.strangerTrust ?? 0.5).toFixed(2)}`, strangersHtml(c))}

    ${details('nights', `Nights (${(nights ?? []).length})`, nightsHtml(nights))}

    ${details('places', `Known places (${(c.knownPlacesView ?? []).length})`, knownPlacesHtml(c))}

    <h3>Carrying</h3>
    <div class="slots">${carryingHtml(c)}</div>

    ${details('objects', `Known objects (${(c.knownObjectsView ?? []).length}${mismatches(c) ? `, ${mismatches(c)} wrong` : ''})`, knownObjectsHtml(c))}

    ${details('snapshots', `Last seen (${(c.snapshotsView ?? []).length} rooms)`, snapshotsHtml(c))}

    ${details('act', `Act on ${c.name} (director)`, actPanelHtml(c))}

    ${details('persona', 'Persona', `<dl class="kv">
      <dt>Age / sex</dt><dd>${esc(p.age ?? '?')} / ${esc(p.sex ?? '?')}</dd>
      <dt>Home</dt><dd>${esc(roomName(c.home))}</dd>
      <dt>Appearance</dt><dd>${esc(p.appearance)}</dd>
      <dt>Personality</dt><dd>${esc(p.personality)}</dd>
      <dt>Traits</dt><dd class="dim">${esc(traits)}</dd>
      <dt>Speech</dt><dd>${esc(p.speechStyle)}</dd>
      <dt>Backstory</dt><dd>${esc(p.backstory)}</dd>
      <dt>Goals</dt><dd>${(p.goals ?? []).map((g) => `• ${esc(g)}`).join('<br>')}</dd>
      <dt>Recent</dt><dd>${(c.recentActions ?? []).slice().reverse().map((r) => `<span class="dim">${esc(gameTime(r.gameTime))}</span> ${esc(detok(r.text))}`).join('<br>') || '–'}</dd>
    </dl>`)}

    ${details('prompt', `Prompt preview · tools: ${(c.toolsPreview ?? []).join(', ')}`, `<pre class="detail">${esc(prompt)}</pre>`)}

    <h3>Last LLM calls</h3>
    ${(c.lastCalls ?? []).length ? `<ul class="log">${c.lastCalls.map((k) => `<li class="clickable" data-call="${k.id}">
        <span class="t">#${k.id}</span><span class="type">${esc(k.purpose)}</span>
        <span class="${k.status === 'ok' ? '' : 'bad'}">${esc(k.status)} · ${k.duration_ms ?? '–'} ms · ${esc(gameTime(k.game_time))}</span></li>`).join('')}</ul>`
      : '<p class="muted">None yet.</p>'}`;
  root.scrollTop = scroll;
}

// ---------- strangers (step 5.5) ----------
function strangersHtml(c) {
  const log = (c.strangerLog ?? []).slice().reverse().map((l) => `<div class="dim">${esc(gameTime(l.at))}: ${Number(l.value).toFixed(2)} — ${esc(l.why)}</div>`).join('');
  const here = (c.strangersView ?? []).map(warinessHtml).join('');
  const tags = (c.persona?.appearanceTags ?? []).length ? `<div class="dim">How they look to others: ${esc(c.persona.appearanceTags.join(', '))}</div>` : '';
  return `<div class="dim">Learned attitude towards strangers (0 = expects the worst, 1 = trusting; starts at 0.5).</div>${tags}
    ${log || '<div class="dim">No experiences with strangers yet.</div>'}
    ${here ? `<h4>Strangers here right now</h4>${here}` : '<p class="muted">No strangers present.</p>'}`;
}

// ---------- objects (step 5) ----------
function carryingHtml(c) {
  const items = c.carryingView ?? [];
  const slots = [];
  for (const o of items) {
    slots.push(`<div class="slot full" data-object="${esc(o.id)}" title="${esc(o.id)}">✋ ${esc(o.label)}</div>`);
    if (o.size === 2) slots.push('<div class="slot full dim">(both hands)</div>');
  }
  while (slots.length < 2) slots.push('<div class="slot">empty hand</div>');
  return slots.join('');
}

const mismatches = (c) => (c.knownObjectsView ?? []).filter((k) => k.mismatch).length;

function knownObjectsHtml(c) {
  const list = c.knownObjectsView ?? [];
  if (!list.length) return '<p class="muted">Nothing yet.</p>';
  const rows = list.map((k) => (k.gone ? `<tr><td>${esc(k.id)}</td><td colspan="2" class="dim">no longer exists</td></tr>`
    : `<tr class="${k.mismatch ? 'mismatch' : ''}">
        <td><span class="ob-name" data-object="${esc(k.id)}">${esc(k.label)}</span></td>
        <td>${esc(k.believedText)}<span class="dim"> · ${esc(k.believed.state)}</span></td>
        <td>${k.mismatch ? `<b class="bad">${esc(k.actualText)}</b><span class="dim"> · ${esc(k.actual.state)}</span>` : '<span class="dim">✓</span>'}</td>
      </tr>`)).join('');
  return `<table class="known-objs"><tr><th>object</th><th>they think</th><th>really</th></tr>${rows}</table>`;
}

function snapshotsHtml(c) {
  const list = c.snapshotsView ?? [];
  if (!list.length) return '<p class="muted">No rooms remembered yet.</p>';
  return list.map((s) => `<div class="snap-room"><b>${esc(s.roomName)}</b> <span class="dim">${esc(gameTime(s.at))} · visits ${esc(c.roomVisits?.[s.roomId] ?? 0)}</span><br>
    ${s.objects.map((o) => `<span class="ob-name" data-object="${esc(o.id)}">${esc(o.label)}</span> <span class="dim">(${esc(o.sig.replace('|', ', ').replace(/:/g, ' '))})</span>`).join(' · ') || '<span class="dim">nothing</span>'}</div>`).join('');
}

function updateCountdown() {
  const el = root?.querySelector('#insp-activity');
  const c = data && store.citizens.get(data.id);
  if (el && c) el.textContent = activityLabel(c);
}
