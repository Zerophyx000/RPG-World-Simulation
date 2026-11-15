// Relationships: SVG graph. Nodes = citizens on a circle (or a deterministic spring layout).
// Edge thickness = addressed speech lines between two people (code, from the event log);
// edge color = warmth (red ↔ grey ↔ green), dashing = tension, label = observer note.
// Directed curved edges when the two directions differ. Time slider scrubs past observer reports.
//
// The edge input is generic ({ from, to, warmth, tension, label, note }), so step 4 can add
// "What X believes" next to the observer view without touching the drawing code.
import { store, subscribe, subscribeMany, select } from '../store.js';
import { api, esc, gameTime, citizenName, who, debounce } from '../util.js';
import { SOURCE_ICON, openReasons } from './social-ui.js';
import { EMO_COLOR } from './emotions-ui.js';
import { colorOf } from '../colors.js';

const VW = 820;
const VH = 600;
const NODE_R = 24;

let root = null;
let history = [];
let index = -1;          // selected history index (-1 = none yet)
let report = null;       // report shown
let counts = [];         // [{from,to,n}]
let windowSel = 'all';
let layout = 'circle';
let selectedEdge = null; // { a, b }
let pairLines = [];
let source = 'observer';  // 'observer' or a citizen id ("what X believes")
let beliefs = [];         // that citizen's relationship rows
let compare = false;      // colour edges by how much the citizen's view differs from the observer's

export function mount(el) {
  root = el;
  el.innerHTML = `
    <div class="rel-toolbar">
      <select id="rel-source" title="Whose view of the relationships"></select>
      <label class="check hidden" id="rel-compare-wrap"><input type="checkbox" id="rel-compare"> compare with observer</label>
      <select id="rel-window">
        <option value="all">all interactions</option>
        <option value="360">last 6 h</option>
        <option value="1440">last 24 h</option>
      </select>
      <label class="check"><input type="checkbox" id="rel-spring"> spring layout</label>
      <label class="check" title="Aimed emotions as arcs: anger red, fear orange, affection pink, gratitude gold, envy green, jealousy purple (the dot on a jealousy arc is who it is about)"><input type="checkbox" id="rel-emotions"> emotions</label>
      <label class="check" title="Step 11: a dashed dark-red arrow from each schemer to the people their live schemes are aimed at (director view)"><input type="checkbox" id="rel-schemes"> schemes</label>
      <label class="check" title="Highlight pairs where warning signs (followed, carrying your property, intruder…) cost trust"><input type="checkbox" id="rel-signals"> signal-driven distrust</label>
      <button id="rel-refresh">Refresh observer</button>
      <span class="dim" id="rel-status"></span>
    </div>
    <div class="rel-body">
      <svg id="rel-svg" viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="xMidYMid meet"></svg>
      <aside class="rel-side" id="rel-side"></aside>
    </div>
    <div class="rel-slider">
      <input type="range" id="rel-range" min="0" max="0" value="0">
      <div id="rel-when" class="dim"></div>
    </div>`;
  fillSources();
  el.querySelector('#rel-source').addEventListener('change', async (e) => {
    source = e.target.value;
    root.querySelector('#rel-compare-wrap').classList.toggle('hidden', source === 'observer');
    await loadBeliefs();
    render();
  });
  el.querySelector('#rel-compare').addEventListener('change', (e) => {
    compare = e.target.checked;
    render();
  });
  el.querySelector('#rel-window').addEventListener('change', (e) => {
    windowSel = e.target.value;
    loadCounts();
  });
  el.querySelector('#rel-spring').addEventListener('change', (e) => {
    layout = e.target.checked ? 'spring' : 'circle';
    render();
  });
  el.querySelector('#rel-refresh').addEventListener('click', refreshObserver);
  el.querySelector('#rel-emotions').addEventListener('change', async (e) => {
    emoOverlay = e.target.checked;
    if (emoOverlay) await loadAimed();
    render();
  });
  el.querySelector('#rel-schemes').addEventListener('change', async (e) => {
    schemeOverlay = e.target.checked;
    if (schemeOverlay) await loadSchemes();
    render();
  });
  el.querySelector('#rel-signals').addEventListener('change', async (e) => {
    signalFilter = e.target.checked;
    if (signalFilter) signalPairs = await api.get('/api/relationships/signals').catch(() => []);
    render();
  });
  el.querySelector('#rel-range').addEventListener('input', debounce((e) => selectReport(Number(e.target.value)), 120));
  el.querySelector('#rel-svg').addEventListener('click', onClick);

  const offs = [
    subscribe('observer', () => loadHistory(true)),
    subscribe('scheming', debounce(() => schemeOverlay && loadSchemes().then(render), 1500)),
    subscribeMany(['citizens', 'filter'], () => { fillSources(); render(); }),
    subscribe('relationship', debounce((r) => r?.citizenId === source && loadBeliefs().then(render), 1500)),
    subscribe('event', debounce((e) => e?.type === 'action' && index === history.length - 1 && loadCounts(), 2000)),
  ];
  loadHistory(true);
  return () => {
    offs.forEach((off) => off());
    root = null;
  };
}

async function refreshObserver() {
  const status = root.querySelector('#rel-status');
  status.textContent = 'observer is thinking…';
  try {
    const r = await api.post('/api/observer/run');
    status.textContent = r.error ? `failed: ${r.error}` : r.queued ? 'queued after the current run' : r.skipped ? r.skipped : '';
  } catch (err) {
    status.textContent = err.message;
  }
}

async function loadHistory(jumpToLatest) {
  try {
    history = await api.get('/api/observer/history?limit=200');
  } catch {
    history = [];
  }
  if (!root) return;
  const range = root.querySelector('#rel-range');
  range.max = String(Math.max(0, history.length - 1));
  range.disabled = history.length < 2;
  if (jumpToLatest || index < 0 || index >= history.length) index = history.length - 1;
  range.value = String(Math.max(0, index));
  await selectReport(index);
}

async function selectReport(i) {
  index = i;
  report = null;
  if (history[i]) {
    try {
      report = await api.get(`/api/observer/${history[i].id}`);
    } catch {
      report = null;
    }
  }
  if (!root) return;
  root.querySelector('#rel-when').innerHTML = report
    ? `Report ${i + 1}/${history.length} · ${esc(gameTime(report.gameTime))} — ${esc(report.headline)}`
    : 'No observer report yet. Edge thickness already shows who talks to whom; press “Refresh observer” for colors and labels.';
  await loadCounts();
}

function timeTo() {
  const latest = index === history.length - 1 || !report;
  return latest ? store.clock?.gameMinutes ?? null : report.gameTime;
}

async function loadCounts() {
  const to = timeTo();
  const from = windowSel === 'all' || to == null ? null : to - Number(windowSel);
  const q = [from != null ? `from=${from}` : '', to != null ? `to=${to}` : ''].filter(Boolean).join('&');
  try {
    counts = await api.get(`/api/relationships${q ? `?${q}` : ''}`);
  } catch {
    counts = [];
  }
  render();
  if (selectedEdge) loadPairLines();
}

// ---------- layout ----------
function nodes() {
  return [...store.citizens.values()].filter((c) => c.kind === 'citizen' || !c.kind).sort((a, b) => a.id.localeCompare(b.id));
}

function circlePositions(list) {
  const pos = new Map();
  const r = Math.min(VW, VH) / 2 - 80;
  list.forEach((c, i) => {
    const a = -Math.PI / 2 + (i / list.length) * Math.PI * 2;
    pos.set(c.id, { x: VW / 2 + r * Math.cos(a), y: VH / 2 + r * Math.sin(a) });
  });
  return pos;
}

// Deterministic force layout seeded from the circle, so it never jumps between renders.
function springPositions(list, weights) {
  const pos = circlePositions(list);
  const ids = list.map((c) => c.id);
  const k = Math.sqrt((VW * VH) / Math.max(1, ids.length)) * 0.6;
  let temp = 60;
  for (let iter = 0; iter < 300; iter++) {
    const disp = new Map(ids.map((id) => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i]);
        const b = pos.get(ids[j]);
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const rep = (k * k) / d;
        dx /= d;
        dy /= d;
        disp.get(ids[i]).x += dx * rep;
        disp.get(ids[i]).y += dy * rep;
        disp.get(ids[j]).x -= dx * rep;
        disp.get(ids[j]).y -= dy * rep;
        const w = weights.get([ids[i], ids[j]].sort().join('|')) ?? 0;
        if (w > 0) {
          const att = ((d * d) / k) * Math.min(3, 0.3 + Math.sqrt(w) * 0.3);
          disp.get(ids[i]).x -= dx * att;
          disp.get(ids[i]).y -= dy * att;
          disp.get(ids[j]).x += dx * att;
          disp.get(ids[j]).y += dy * att;
        }
      }
    }
    for (const id of ids) {
      const p = pos.get(id);
      const dsp = disp.get(id);
      dsp.x += (VW / 2 - p.x) * 0.02 * k / 50; // gentle gravity
      dsp.y += (VH / 2 - p.y) * 0.02 * k / 50;
      const len = Math.max(0.01, Math.hypot(dsp.x, dsp.y));
      p.x = Math.min(VW - 60, Math.max(60, p.x + (dsp.x / len) * Math.min(len, temp)));
      p.y = Math.min(VH - 60, Math.max(60, p.y + (dsp.y / len) * Math.min(len, temp)));
    }
    temp *= 0.985;
  }
  return pos;
}

// ---------- sources: observer vs what a citizen believes ----------
function fillSources() {
  const sel = root?.querySelector('#rel-source');
  if (!sel) return;
  sel.innerHTML = '<option value="observer">Observer view</option>'
    + [...store.citizens.values()].filter((c) => c.kind === 'citizen' || !c.kind)
      .map((c) => `<option value="${esc(c.id)}">What ${esc(c.name)} believes</option>`).join('');
  sel.value = source;
}

async function loadBeliefs() {
  if (source === 'observer') return void (beliefs = []);
  try {
    beliefs = await api.get(`/api/citizens/${encodeURIComponent(source)}/beliefs`);
  } catch {
    beliefs = [];
  }
}

const observerRels = () => new Map((report?.relationships ?? []).map((r) => [`${r.from}>${r.to}`, r]));

/** Edge data for the chosen source. Citizen mode: their own rows; other pairs are unknown to them (until step 8). */
function relsFor() {
  if (source === 'observer') return observerRels();
  const obs = observerRels();
  const m = new Map();
  for (const b of beliefs) {
    const o = obs.get(`${b.from}>${b.to}`);
    m.set(`${b.from}>${b.to}`, {
      from: b.from, to: b.to, warmth: Math.round(b.affinity), tension: Math.max(0, Math.round(-b.trust)),
      label: b.summary ? b.summary.slice(0, 40) : 'known', note: b.summary ?? '',
      diff: o ? Math.abs(Math.round(b.affinity) - o.warmth) : null,
    });
  }
  return m;
}

// ---------- edges ----------
function warmthColor(w) {
  if (w == null) return '#7d8490';
  const t = Math.min(1, Math.abs(w) / 5);
  const [r0, g0, b0] = [125, 132, 144];
  const [r1, g1, b1] = w >= 0 ? [95, 200, 120] : [225, 85, 85];
  return `rgb(${Math.round(r0 + (r1 - r0) * t)}, ${Math.round(g0 + (g1 - g0) * t)}, ${Math.round(b0 + (b1 - b0) * t)})`;
}

function diffColor(d) {
  const t = Math.min(1, d / 4);
  return `rgb(${Math.round(95 + (225 - 95) * t)}, ${Math.round(200 + (85 - 200) * t)}, ${Math.round(120 + (85 - 120) * t)})`;
}

const dashFor = (t) => (!t ? '' : `${Math.max(2, 11 - t * 1.8)} ${1 + t}`);
const widthFor = (n) => Math.min(12, 1.2 + 1.6 * Math.sqrt(n || 0));

let emoOverlay = false;
let aimed = [];
async function loadAimed() {
  aimed = await api.get('/api/emotions/aimed').catch(() => []);
}

// Thin animated arcs for aimed emotions, bowed further out than the relationship edges.
function emotionArcs(pos) {
  const out = [];
  const seen = new Map();
  for (const e of aimed) {
    const p1 = pos.get(e.from);
    const p2 = pos.get(e.to);
    if (!p1 || !p2) continue;
    const k = `${e.from}>${e.to}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const off = len * (0.3 + n * 0.09);
    const cx = (p1.x + p2.x) / 2 - (dy / len) * off;
    const cy = (p1.y + p2.y) / 2 + (dx / len) * off;
    const color = EMO_COLOR[e.type] ?? e.color ?? '#aaa';
    const title = `${citizenName(e.from)} → ${citizenName(e.to)}: ${e.type} ${e.intensity}${e.about ? ` (about ${store.citizens.get(e.about)?.name ?? e.about})` : ''}${e.cause ? `\n${e.cause.replace(/\{\{[cp]:([\w-]+)\}\}/g, (_m, id) => citizenName(id))}` : ''}`;
    out.push(`<g class="emo-arc"><title>${esc(title)}</title>
      <path d="M${p1.x},${p1.y} Q${cx},${cy} ${p2.x},${p2.y}" fill="none" stroke="${color}" stroke-width="${1 + e.intensity * 0.22}" stroke-opacity="${0.35 + e.intensity * 0.06}" stroke-dasharray="7 6"/>
      <text x="${(p1.x + 2 * cx + p2.x) / 4}" y="${(p1.y + 2 * cy + p2.y) / 4 - 5}" text-anchor="middle" class="emo-arc-label" fill="${color}">${esc(e.type)}</text>
      ${e.type === 'jealousy' && e.about && store.citizens.has(e.about) ? `<circle cx="${(p1.x + 2 * cx + p2.x) / 4}" cy="${(p1.y + 2 * cy + p2.y) / 4 + 6}" r="5" fill="${colorOf(e.about)}" stroke="#111"/>` : ''}</g>`);
  }
  return out;
}

// step 11: who is scheming against whom — a dashed arrow schemer → target, bowed the other way from the emotion arcs.
let schemeOverlay = false;
let schemeList = [];
async function loadSchemes() {
  schemeList = await api.get('/api/schemes?limit=200').catch(() => []);
}
function schemeArcs(pos) {
  const out = [];
  for (const s of schemeList) {
    if (!['planning', 'active', 'paused'].includes(s.status)) continue;
    for (const t of s.targetIds ?? []) {
      const p1 = pos.get(s.ownerId);
      const p2 = pos.get(t);
      if (!p1 || !p2 || s.ownerId === t) continue;
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.max(1, Math.hypot(dx, dy));
      const off = len * 0.22;
      const cx = (p1.x + p2.x) / 2 + (dy / len) * off;
      const cy = (p1.y + p2.y) / 2 - (dx / len) * off;
      // arrowhead a little short of the target node
      const ex = p2.x - (p2.x - cx) / Math.max(1, Math.hypot(p2.x - cx, p2.y - cy)) * 22;
      const ey = p2.y - (p2.y - cy) / Math.max(1, Math.hypot(p2.x - cx, p2.y - cy)) * 22;
      const ang = Math.atan2(ey - cy, ex - cx);
      const head = [[ex, ey], [ex - 9 * Math.cos(ang - 0.4), ey - 9 * Math.sin(ang - 0.4)], [ex - 9 * Math.cos(ang + 0.4), ey - 9 * Math.sin(ang + 0.4)]].map((p) => p.join(',')).join(' ');
      const done = (s.steps ?? []).filter((st) => st.status === 'done').length;
      const title = `${citizenName(s.ownerId)} → ${citizenName(t)}: ${s.goal} (${s.status}, ${done}/${(s.steps ?? []).length} steps)${(s.accomplices ?? []).length ? `
with ${s.accomplices.map((a) => `${citizenName(a.citizen_id)} (${a.status})`).join(', ')}` : ''}`;
      out.push(`<g class="scheme-arc"><title>${esc(title)}</title>
        <path d="M${p1.x},${p1.y} Q${cx},${cy} ${ex},${ey}" fill="none" stroke="#b0303a" stroke-width="2" stroke-opacity="0.85" stroke-dasharray="4 4"/>
        <polygon points="${head}" fill="#b0303a"/>
        <text x="${(p1.x + 2 * cx + p2.x) / 4}" y="${(p1.y + 2 * cy + p2.y) / 4 - 5}" text-anchor="middle" class="emo-arc-label" fill="#d06070">🕸</text></g>`);
    }
  }
  return out;
}

let signalFilter = false;
let signalPairs = [];
let pairReasons = null; // { ab: [...], ba: [...] } for the selected edge

function edgeData() {
  const rels = relsFor();
  const n = new Map(counts.map((c) => [`${c.from}>${c.to}`, c.n]));
  const pairs = new Map();
  for (const key of new Set([...rels.keys(), ...n.keys(), ...(signalFilter ? signalPairs.map((s) => `${s.from}>${s.to}`) : [])])) {
    const [a, b] = key.split('>');
    const pk = [a, b].sort().join('|');
    if (!pairs.has(pk)) pairs.set(pk, { a: [a, b].sort()[0], b: [a, b].sort()[1] });
  }
  return { rels, n, pairs };
}

const sameRel = (x, y) => (x?.warmth ?? null) === (y?.warmth ?? null) && (x?.tension ?? null) === (y?.tension ?? null)
  && (x?.label ?? '') === (y?.label ?? '');

function render() {
  if (!root) return;
  const svg = root.querySelector('#rel-svg');
  const list = nodes();
  const { rels, n, pairs } = edgeData();
  const weights = new Map([...pairs.keys()].map((pk) => {
    const [a, b] = pk.split('|');
    return [pk, (n.get(`${a}>${b}`) ?? 0) + (n.get(`${b}>${a}`) ?? 0)];
  }));
  const pos = layout === 'spring' ? springPositions(list, weights) : circlePositions(list);
  const out = [];
  const sig = new Set(signalPairs.map((s) => [s.from, s.to].sort().join('|')));
  const dim = (ids) => ((store.filterCitizen && !ids.includes(store.filterCitizen)) || (signalFilter && ids.length === 2 && !sig.has([...ids].sort().join('|'))) ? ' opacity="0.12"' : '');

  for (const [pk, { a, b }] of pairs) {
    const pa = pos.get(a);
    const pb = pos.get(b);
    if (!pa || !pb) continue;
    const unknown = { unknown: true };
    const viewOf = (x, y) => (source === 'observer' || x === source ? rels.get(`${x}>${y}`) : unknown);
    const ab = viewOf(a, b);
    const ba = viewOf(b, a);
    const nab = n.get(`${a}>${b}`) ?? 0;
    const nba = n.get(`${b}>${a}`) ?? 0;
    const selected = selectedEdge && [selectedEdge.a, selectedEdge.b].sort().join('|') === pk;
    if (sameRel(ab, ba)) {
      out.push(edgeSvg(pa, pb, { rel: ab, n: nab + nba, a, b, curve: 0, arrow: false, selected, extra: dim([a, b]) }));
    } else {
      if (ab || nab) out.push(edgeSvg(pa, pb, { rel: ab, n: nab, a, b, curve: 1, arrow: true, selected, extra: dim([a, b]) }));
      if (ba || nba) out.push(edgeSvg(pb, pa, { rel: ba, n: nba, a: b, b: a, curve: 1, arrow: true, selected, extra: dim([a, b]) }));
    }
  }
  if (emoOverlay) out.push(...emotionArcs(pos));
  if (schemeOverlay) out.push(...schemeArcs(pos)); // step 11
  for (const c of list) {
    const p = pos.get(c.id);
    // step 9.5: the dead are grey — in "what X believes" only when X knows
    const shownDead = source === 'observer' ? c.alive === false : beliefs.some((b) => b.to === c.id && b.dead);
    const col = shownDead ? '#777' : colorOf(c.id);
    out.push(`<g class="rnode" data-node="${esc(c.id)}"${dim([c.id])}>
      <circle cx="${p.x}" cy="${p.y}" r="${NODE_R}" fill="${col}" fill-opacity="0.22" stroke="${col}" stroke-width="2.5"${shownDead ? ' stroke-dasharray="4 3"' : ''}/>
      <text x="${p.x}" y="${p.y + 4}" text-anchor="middle" class="rnode-initial" fill="${col}">${esc(c.name.slice(0, 2))}</text>
      <text x="${p.x}" y="${p.y + NODE_R + 16}" text-anchor="middle" class="rnode-label">${esc(c.name)}</text></g>`);
  }
  svg.innerHTML = out.join('');
  renderSide();
}

function edgeSvg(p1, p2, { rel, n, a, b, curve, arrow, selected, extra }) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / len;
  const uy = dy / len;
  // control point offset to the right of the direction of travel → A→B and B→A sit on opposite sides
  const off = curve ? len * 0.16 : 0;
  const cx = (p1.x + p2.x) / 2 - uy * off;
  const cy = (p1.y + p2.y) / 2 + ux * off;
  // trim the ends at the node circles
  const s = trim(p1, cx, cy, NODE_R + 2);
  const e = trim(p2, cx, cy, NODE_R + (arrow ? 8 : 2));
  // compare mode: green = the citizen sees it like the observer, red = very differently
  const color = rel?.unknown ? '#4a4f5a' : compare && rel?.diff != null ? diffColor(rel.diff) : warmthColor(rel?.warmth);
  const width = rel?.unknown ? 1 : widthFor(n);
  const title = rel?.unknown
    ? `What ${citizenName(source)} believes about ${citizenName(a)} → ${citizenName(b)}: unknown`
    : `${citizenName(a)} → ${citizenName(b)}: ${rel ? `${rel.label} (warmth ${rel.warmth}, tension ${rel.tension})${rel.note ? `\n${rel.note}` : ''}${rel.diff != null ? `\ndiffers from the observer by ${rel.diff}` : ''}` : 'no note'}\n${n} addressed line${n === 1 ? '' : 's'}`;
  let head = '';
  if (arrow) {
    const tx = e.x - cx;
    const ty = e.y - cy;
    const tl = Math.max(1, Math.hypot(tx, ty));
    const hx = tx / tl;
    const hy = ty / tl;
    const tipX = e.x + hx * 7;
    const tipY = e.y + hy * 7;
    const size = 5 + width * 0.5;
    head = `<path d="M${tipX},${tipY} L${tipX - hx * size * 1.6 - hy * size},${tipY - hy * size * 1.6 + hx * size} L${tipX - hx * size * 1.6 + hy * size},${tipY - hy * size * 1.6 - hx * size} Z" fill="${color}"/>`;
  }
  return `<g class="redge ${selected ? 'selected' : ''}" data-edge="${esc(a)}|${esc(b)}"${extra}><title>${esc(title)}</title>
    <path d="M${s.x},${s.y} Q${cx},${cy} ${e.x},${e.y}" class="hit"/>
    <path d="M${s.x},${s.y} Q${cx},${cy} ${e.x},${e.y}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" ${rel?.unknown ? 'stroke-dasharray="2 4" opacity="0.5"' : rel?.tension ? `stroke-dasharray="${dashFor(rel.tension)}"` : ''}/>
    ${head}</g>`;
}

function trim(p, cx, cy, by) {
  const dx = cx - p.x;
  const dy = cy - p.y;
  const d = Math.max(1, Math.hypot(dx, dy));
  return { x: p.x + (dx / d) * by, y: p.y + (dy / d) * by };
}

// ---------- side panel ----------
function onClick(e) {
  const node = e.target.closest('[data-node]');
  if (node) return select(node.dataset.node);
  const edge = e.target.closest('[data-edge]');
  if (edge) {
    const [a, b] = edge.dataset.edge.split('|');
    selectedEdge = { a, b };
    pairReasons = null;
    render();
    loadPairLines();
    loadPairReasons();
  }
}

async function loadPairLines() {
  if (!selectedEdge) return;
  const to = timeTo();
  try {
    pairLines = await api.get(`/api/relationships/lines?a=${encodeURIComponent(selectedEdge.a)}&b=${encodeURIComponent(selectedEdge.b)}${to != null ? `&until=${to}` : ''}`);
  } catch {
    pairLines = [];
  }
  renderSide();
}

async function loadPairReasons() {
  if (!selectedEdge) return;
  const { a, b } = selectedEdge;
  const get = (x, y) => api.get(`/api/citizens/${encodeURIComponent(x)}/relationships/${encodeURIComponent(y)}/events`).then((d) => d.events).catch(() => []);
  const [ab, ba] = await Promise.all([get(a, b), get(b, a)]);
  if (selectedEdge?.a !== a || selectedEdge?.b !== b) return;
  pairReasons = { ab, ba };
  renderSide();
}

const topReasons = (list) => (list ?? []).filter((e) => (Math.abs(e.dTrust) + Math.abs(e.dAffinity) > 0 || e.evidence?.weight) && e.source !== 'group')
  .sort((x, y) => (Math.abs(y.dTrust) + Math.abs(y.dAffinity)) * y.strength - (Math.abs(x.dTrust) + Math.abs(x.dAffinity)) * x.strength).slice(0, 3);

function renderSide() {
  const side = root?.querySelector('#rel-side');
  if (!side) return;
  if (!selectedEdge) {
    side.innerHTML = `<p class="muted">Click an edge to see the observer's note and the last lines between the two.</p>
      <div class="legend-box">
        <div><span class="sw" style="background:${warmthColor(-5)}"></span> hostile … <span class="sw" style="background:${warmthColor(0)}"></span> neutral … <span class="sw" style="background:${warmthColor(5)}"></span> warm</div>
        <div class="dim">thicker = more addressed lines · dashed = tension · arrows when the two directions differ</div>
      </div>`;
    return;
  }
  const { a, b } = selectedEdge;
  const rels = relsFor();
  const n = new Map(counts.map((c) => [`${c.from}>${c.to}`, c.n]));
  const dir = (x, y) => {
    const r = rels.get(`${x}>${y}`);
    return `<div class="rel-dir">${who(x)} → ${who(y)} <span class="dim">· ${n.get(`${x}>${y}`) ?? 0} lines</span>
      ${r ? `<div><b style="color:${warmthColor(r.warmth)}">${esc(r.label)}</b> <span class="dim">warmth ${r.warmth}, tension ${r.tension}</span></div>
        ${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}` : '<div class="dim">no observer note</div>'}
      ${pairReasons ? `<div class="edge-reasons"><span class="dim">${esc(citizenName(x))}'s own reasons:</span>${
        topReasons(x === a ? pairReasons.ab : pairReasons.ba).map((e) => `<div class="rel-reason" style="opacity:${Math.max(0.45, Math.min(1, 0.3 + e.strength))}">${SOURCE_ICON[e.source] ?? '·'} ${esc(e.reason)}
          <span class="dim">${e.dTrust ? `trust ${e.dTrust > 0 ? '+' : ''}${e.dTrust}` : ''} ${e.dAffinity ? `liking ${e.dAffinity > 0 ? '+' : ''}${e.dAffinity}` : ''}</span></div>`).join('') || ' <span class="dim">none on record</span>'}
        <button class="link" data-edge-reasons="${esc(x)}|${esc(y)}">all reasons…</button></div>` : ''}</div>`;
  };
  side.innerHTML = `<button class="close" data-close-edge>✕</button>${dir(a, b)}${dir(b, a)}
    <h3>Last lines between them</h3>
    ${pairLines.length ? pairLines.map((l) => `<div class="tline">${who(l.from)}: “${esc(l.text)}”${l.thought ? `<div class="tthought">${esc(l.thought)}</div>` : ''}</div>`).join('') : '<p class="muted">None yet.</p>'}`;
  side.querySelectorAll('[data-edge-reasons]').forEach((btn) => btn.addEventListener('click', () => {
    const [x, y] = btn.dataset.edgeReasons.split('|');
    openReasons(x, y);
  }));
  side.querySelector('[data-close-edge]').addEventListener('click', () => {
    selectedEdge = null;
    render();
  });
}
