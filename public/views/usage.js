// Usage: LLM output tokens per bucket (stacked by purpose) with the budget line, the governor state,
// per-purpose totals (like scripts/tokens.js), profile health and reflection gating paths.
import { store, subscribe } from '../store.js';
import { api, esc, debounce } from '../util.js';

const PURPOSE_COLORS = {
  decide: '#6f8cf0', plan: '#a98be6', reflect: '#3fc9b8', consolidate: '#e58ad6', score: '#b5cf4a',
  bootstrap: '#c99a6e', observer: '#e0a43a', director_text: '#e8804a', test: '#8b919c', keeper: '#d4c05a',
};
let root = null;
let minutes = 180;
let bucket = 10;
let data = null;
let timer = null;

export function mount(el) {
  root = el;
  el.innerHTML = `
    <div class="usage-head">
      <span id="gov-badge" class="pill">governor …</span>
      <label>window <select id="u-min"><option>60</option><option selected>180</option><option>360</option><option>1440</option></select> min</label>
      <label>bucket <select id="u-bucket"><option>5</option><option selected>10</option><option>30</option><option>60</option></select> min</label>
      <label>budget/hour <input id="u-budget" type="number" min="0" step="10000" class="wide"> <button id="u-set">Set</button></label>
      <span class="dim" id="u-sum"></span>
    </div>
    <svg id="u-chart" class="usage-chart"></svg>
    <div class="usage-legend" id="u-legend"></div>
    <div class="usage-grid">
      <section><h3>Per purpose</h3><table class="tbl" id="u-table"></table></section>
      <section>
        <h3>Profiles</h3><table class="tbl" id="u-profiles"></table>
        <h3 id="u-cutoffs-head" class="hidden">Cut-offs by tier</h3><table class="tbl" id="u-cutoffs"></table>
        <div id="u-cutoff-note" class="dim"></div>
        <h3 id="u-tiers-head" class="hidden">Decisions by tier and reason</h3><div id="u-tiers-note" class="dim"></div><table class="tbl" id="u-tiers"></table>
        <h3>Reflections (gating paths)</h3><div id="u-refl"></div>
      </section>
    </div>`;
  el.querySelector('#u-min').addEventListener('change', (e) => { minutes = Number(e.target.value); load(); });
  el.querySelector('#u-bucket').addEventListener('change', (e) => { bucket = Number(e.target.value); load(); });
  el.querySelector('#u-set').addEventListener('click', async () => {
    await api.post('/api/governor', { budgetPerHour: Number(el.querySelector('#u-budget').value) || 0 });
    load();
  });
  const refresh = debounce(load, 2000);
  const offs = [subscribe('llm', refresh), subscribe('governor', load)];
  timer = setInterval(load, 15000);
  window.addEventListener('resize', render);
  load();
  return () => {
    offs.forEach((off) => off());
    clearInterval(timer);
    window.removeEventListener('resize', render);
    root = null;
  };
}

async function load() {
  if (!root) return;
  try {
    data = await api.get(`/api/llm/usage?minutes=${minutes}&bucket=${bucket}`);
  } catch {
    return;
  }
  render();
}

function render() {
  if (!root || !data) return;
  const g = data.governor;
  const badge = root.querySelector('#gov-badge');
  badge.className = `pill gov-${g?.state ?? 'green'}`;
  badge.textContent = g ? `governor ${g.state}${g.enabled ? ` · ${Math.round(g.ratio * 100)}% of budget` : ' · off'}` : 'governor –';
  const bi = root.querySelector('#u-budget');
  if (document.activeElement !== bi) bi.value = g?.budgetPerHour ?? 0;

  // ---- chart ----
  const svg = root.querySelector('#u-chart');
  const W = svg.clientWidth || 900;
  const H = 260;
  const L = 56;
  const B = 24;
  const purposes = Object.keys(data.purposes).sort((a, b) => (data.purposes[b].output - data.purposes[a].output));
  const budgetPerBucket = g?.enabled ? (g.budgetPerHour * data.bucket) / 60 : 0;
  const maxVal = Math.max(1, budgetPerBucket * 1.15, ...data.buckets.map((b) => Object.values(b.output).reduce((a, v) => a + v, 0)));
  const bw = (W - L - 10) / Math.max(1, data.buckets.length);
  const y = (v) => H - B - (v / maxVal) * (H - B - 10);
  const out = [];
  for (let i = 0; i <= 4; i++) {
    const v = (maxVal * i) / 4;
    out.push(`<line class="grid" x1="${L}" x2="${W - 10}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`);
  }
  data.buckets.forEach((b, i) => {
    let acc = 0;
    const x = L + i * bw + 1;
    for (const p of purposes) {
      const v = b.output[p] ?? 0;
      if (!v) continue;
      out.push(`<rect x="${x}" y="${y(acc + v)}" width="${Math.max(1, bw - 2)}" height="${y(acc) - y(acc + v)}" fill="${PURPOSE_COLORS[p] ?? '#888'}"><title>${esc(`${p}: ${v} output tokens (${new Date(b.t).toLocaleTimeString()})`)}</title></rect>`);
      acc += v;
    }
    if (i % Math.ceil(data.buckets.length / 8) === 0) out.push(`<text class="axis" x="${x}" y="${H - 6}">${new Date(b.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</text>`);
  });
  if (budgetPerBucket) out.push(`<line class="budget" x1="${L}" x2="${W - 10}" y1="${y(budgetPerBucket)}" y2="${y(budgetPerBucket)}"/><text class="axis budget-label" x="${W - 12}" y="${y(budgetPerBucket) - 4}" text-anchor="end">budget per ${data.bucket} min</text>`);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);
  svg.innerHTML = out.join('');
  root.querySelector('#u-legend').innerHTML = purposes.map((p) => `<span><i style="background:${PURPOSE_COLORS[p] ?? '#888'}"></i>${esc(p)}</span>`).join('');

  // ---- tables ----
  const totalOut = Object.values(data.purposes).reduce((a, v) => a + v.output, 0);
  const perHour = Math.round(totalOut / (data.minutes / 60));
  root.querySelector('#u-sum').textContent = `${fmt(totalOut)} output tokens in ${data.minutes} min (≈ ${fmt(perHour)}/h)`;
  root.querySelector('#u-table').innerHTML = `<tr><th>purpose</th><th>calls</th><th>output</th><th>avg out</th><th>input</th><th>avg ms</th><th>timeouts</th><th>errors</th><th>tiers</th></tr>`
    + purposes.map((p) => {
      const v = data.purposes[p];
      return `<tr><td><i class="sw" style="background:${PURPOSE_COLORS[p] ?? '#888'}"></i>${esc(p)}</td><td>${v.calls}</td><td>${fmt(v.output)}</td><td>${v.avgOutput}</td><td>${fmt(v.input)}</td><td>${v.avgMs}</td><td>${v.timeouts || ''}</td><td>${v.errors || ''}</td><td class="dim">${esc(Object.entries(v.tiers).map(([t, n]) => `${t} ${n}`).join(' · '))}</td></tr>`;
    }).join('');
  root.querySelector('#u-profiles').innerHTML = `<tr><th>profile</th><th>status</th><th>model</th><th>in flight</th><th>output</th><th>thinking off</th></tr>`
    + data.llmProfiles.map((p) => `<tr><td>${esc(p.name)}</td><td class="${p.available ? 'ok' : 'bad'}">${p.available ? 'up' : `down${p.lastError ? `: ${esc(p.lastError)}` : ''}`}</td>
      <td class="dim">${esc(p.model)}</td><td>${p.active}/${p.maxConcurrent}${p.waiting ? ` +${p.waiting}` : ''}</td><td>${fmt(data.profiles[p.name]?.output ?? 0)}</td><td>${p.thinkingOff ? 'yes' : 'no'}</td></tr>`).join('');
  // ---- cut-offs by tier (step A6; hidden on older servers without the fields) ----
  const cutoffs = data.cutoffs;
  const co = root.querySelector('#u-cutoffs');
  if (!cutoffs || typeof cutoffs !== 'object') {
    co.innerHTML = '';
    root.querySelector('#u-cutoff-note').textContent = '';
    root.querySelector('#u-cutoffs-head').classList.add('hidden');
  } else {
    root.querySelector('#u-cutoffs-head').classList.remove('hidden');
    const rows = Object.entries(cutoffs).map(([tier, v]) => {
      const calls = v?.calls ?? 0;
      const cut = v?.cutoff ?? 0;
      const rate = v?.rate ?? (calls ? cut / calls : 0);
      const ratePct = `${(rate * 100).toFixed(1)}%`;
      return `<tr><td>${esc(tier)}</td><td>${calls}</td><td>${cut}</td>
        <td class="${rate > 0.05 ? 'warn-red' : 'dim'}">${ratePct}</td></tr>`;
    }).join('');
    co.innerHTML = `<tr><th>tier</th><th>calls</th><th>cut off</th><th>rate</th></tr>${rows || '<tr><td colspan="4" class="dim">no calls in this window</td></tr>'}`;
    const below = data.addressedBelowFull ?? 0;
    const retries = data.retryCutoff ?? 0;
    root.querySelector('#u-cutoff-note').innerHTML =
      `<p class="${below > 0 ? 'warn-red' : 'muted'}">Addressed speech handled below full: ${below}</p>
       <p class="${retries > 0 ? 'warn-red' : 'muted'}">Cut-off retries: ${retries}</p>`;
  }
  // ---- step 10 (0.1): decisions by tier and the reason for it (hidden on older servers) ----
  const dec = data.decide;
  const tt = root.querySelector('#u-tiers');
  root.querySelector('#u-tiers-head').classList.toggle('hidden', !dec);
  if (!dec) { tt.innerHTML = ''; root.querySelector('#u-tiers-note').textContent = ''; }
  else {
    root.querySelector('#u-tiers-note').innerHTML = `<p>${dec.calls} decisions · <b>${(dec.fullShare * 100).toFixed(0)}% full</b> · capped to light: ${data.tierCapped ?? 0} · habits run by code: ${data.habitRuns ?? 0} (blocked ${data.habitBlocked ?? 0}×)</p>`;
    tt.innerHTML = `<tr><th>tier</th><th>reason</th><th>calls</th><th>output</th><th>avg out</th></tr>`
      + (dec.rows.map((x) => `<tr><td>${esc(x.tier)}</td><td>${esc(x.reason)}</td><td>${x.calls}</td><td>${fmt(x.output)}</td><td>${x.avgOutput}</td></tr>`).join('') || '<tr><td colspan="5" class="dim">no decisions in this window</td></tr>');
  }
  const r = data.reflections ?? {};
  const total = (r.template ?? 0) + (r.light ?? 0) + (r.full ?? 0);
  root.querySelector('#u-refl').innerHTML = total
    ? ['template', 'light', 'full'].map((k) => `<div class="refl-row"><span>${k}</span><div class="refl-bar"><div style="width:${((r[k] ?? 0) / total) * 100}%"></div></div><b>${r[k] ?? 0}</b></div>`).join('')
    : '<p class="muted">No reflections in this window.</p>';
}

function fmt(n) {
  n = Math.round(n);
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}
