// Step 9: search. A small box at the top centre of the map (the magnifier, or the "/" key): find a citizen, an object
// or a room by name and jump there (citizens are selected too).
import { esc } from '../../util.js';

/** A flat list of searchable things from the store. */
export function searchIndex(store) {
  const out = [];
  for (const c of store.citizens?.values() ?? []) out.push({ kind: 'citizen', id: c.id, name: c.name ?? c.id });
  for (const r of store.rooms?.values() ?? []) out.push({ kind: 'room', id: r.id, name: r.name ?? r.id });
  for (const o of store.objects?.values() ?? []) if (o.roomId || o.holderId) out.push({ kind: 'object', id: o.id, name: o.label ?? o.typeName ?? o.id, sub: o.typeName });
  return out;
}

/** Best matches first: prefix of the name, then a word prefix, then a substring, then letters in order. */
export function searchFind(index, query, limit = 8) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  const kindRank = { citizen: 0, room: 1, object: 2 };
  const score = (it) => {
    const n = it.name.toLowerCase(); const sub = (it.sub ?? '').toLowerCase();
    if (n.startsWith(q)) return 0;
    if (n.split(/[\s'-]+/).some((w) => w.startsWith(q)) || sub.startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    let i = 0; for (const ch of n) if (ch === q[i]) i++;
    return i === q.length ? 3 : null;
  };
  return index.map((it) => ({ it, s: score(it) })).filter((x) => x.s != null)
    .sort((a, b) => a.s - b.s || kindRank[a.it.kind] - kindRank[b.it.kind] || a.it.name.localeCompare(b.it.name))
    .slice(0, limit).map((x) => x.it);
}

const CSS = `
.msearch { position: absolute; left: 50%; top: 10px; transform: translateX(-50%); font-size: 12px; }
.msearch input { width: 220px; padding: 3px 8px; background: #14171df2; }
.msearch .ms-res { background: #14171df8; border: 1px solid var(--line); border-radius: 6px; margin-top: 2px; }
.msearch .ms-res div { padding: 3px 8px; cursor: pointer; }
.msearch .ms-res div.on, .msearch .ms-res div:hover { background: #2a2f38; }
.msearch .ms-kind { color: var(--muted); font-size: 10px; margin-left: 6px; }
.msearch .ms-btn { padding: 2px 8px; }
`;
const injectCss = () => { if (typeof document === 'undefined' || document.getElementById('css-msearch')) return; const s = document.createElement('style'); s.id = 'css-msearch'; s.textContent = CSS; document.head.append(s); };

export function mount(container, api) {
  injectCss();
  const box = document.createElement('div'); box.className = 'msearch';
  box.innerHTML = '<button class="ms-btn" title="search (/)">🔍</button><input class="hidden" placeholder="find a person, thing or place…"><div class="ms-res hidden"></div>';
  container.append(box);
  const btn = box.querySelector('button'); const input = box.querySelector('input'); const res = box.querySelector('.ms-res');
  let results = []; let cur = 0;
  const open = () => { btn.classList.add('hidden'); input.classList.remove('hidden'); input.focus(); input.select(); };
  const close = () => { input.classList.add('hidden'); res.classList.add('hidden'); btn.classList.remove('hidden'); input.blur(); };
  const go = (it) => { if (!it) return; if (it.kind === 'citizen') api.select(it.id); api.jumpTo(it.id); close(); };
  const draw = () => {
    res.classList.toggle('hidden', !results.length);
    res.innerHTML = results.map((it, i) => `<div data-i="${i}" class="${i === cur ? 'on' : ''}">${esc(it.name)}<span class="ms-kind">${it.kind}</span></div>`).join('');
  };
  btn.addEventListener('click', open);
  input.addEventListener('input', () => { results = searchFind(searchIndex(api.store), input.value); cur = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') go(results[cur]);
    else if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') { cur = Math.min(results.length - 1, cur + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { cur = Math.max(0, cur - 1); draw(); e.preventDefault(); }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) close(); }, 150));
  res.addEventListener('mousedown', (e) => { const d = e.target.closest('[data-i]'); if (d) { e.preventDefault(); go(results[Number(d.dataset.i)]); } });
  const onKey = (e) => {
    if (e.key !== '/' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    e.preventDefault(); e.stopImmediatePropagation(); open();
  };
  window.addEventListener('keydown', onKey, true);
  return { update() {}, unmount() { window.removeEventListener('keydown', onKey, true); box.remove(); } };
}
