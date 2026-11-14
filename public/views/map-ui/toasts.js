// Step 9: event toasts. Important events (deaths, critical bleeding windows, director events, serious injuries,
// warning signs, new or changed storylines) appear at the bottom-left of the map with an icon, one line and a
// "jump to" button; up to 5 stacked, gone after 8 s, kept while the mouse is over them. A small gear sets the minimum
// importance and which kinds show (remembered per viewer).
import { subscribe } from '../../store.js';
import { esc } from '../../util.js';

const TYPES = {
  death: { icon: '✝', importance: 10, label: 'deaths' },
  critical_window: { icon: '⏳', importance: 10, label: 'critical bleeding' },
  director: { icon: '⚡', importance: 9, label: 'director events' },
  director_effect: { icon: '💥', importance: 9, label: 'director effects' },
  injury: { icon: '🩸', importance: 8, label: 'injuries' },
  signal: { icon: '⚠', importance: 7, label: 'warning signs' },
  storyline: { icon: '📖', importance: 7, label: 'storylines' },
  test_day: { icon: '🧪', importance: 6, label: 'test days' },
};
const DEFAULT_FILTER = { min: 7, off: [] };

const nameOf = (store, id) => store.citizens?.get(id)?.name ?? id;
const roomOf = (store, id) => store.rooms?.get(id)?.name ?? id;

/** A toast for an event, or null (routine events, filtered kinds, below the minimum importance). */
export function toastFor(e, store, filter = DEFAULT_FILTER) {
  if (!e?.type) return null;
  const d = e.data ?? {};
  let type = e.type;
  if (type === 'director' && d.action !== 'event') return null;
  if (type === 'injury' && (d.severity ?? 0) < 5) return null;
  const def = TYPES[type];
  const importance = def?.importance ?? (Number(d.importance) || 0);
  if (!def && !(d.importance >= (filter.min ?? 7))) return null;
  if (importance < (filter.min ?? 7) || (filter.off ?? []).includes(type)) return null;
  const who = e.actorId ? nameOf(store, e.actorId) : null;
  const where = e.location ? roomOf(store, e.location) : null;
  const text = d.text ?? d.summary ?? d.texts?.here ?? ({
    death: `${who ?? 'Someone'} died${d.cause ? ` (${d.cause})` : ''}`,
    critical_window: `${who ?? 'Someone'} is bleeding out${d.minutes ? `: ${Math.round(d.minutes)} min` : ''}`,
    director: `Something happens${where ? ` at ${where}` : ''}`,
    director_effect: `${d.effect ?? d.type ?? 'An effect'}${who ? ` on ${who}` : ''}`,
    injury: `${who ?? 'Someone'} is hurt${d.type ? ` (${d.type})` : ''}`,
    signal: `${who ?? 'Someone'}: ${d.kind ?? 'a warning sign'}`,
    test_day: `Test day: ${d.name ?? d.action ?? ''}`,
  }[type] ?? `${type}${who ? `: ${who}` : ''}`);
  return { id: e.id ?? `${type}${Date.now()}`, type, icon: def?.icon ?? '•', importance, text: String(text).slice(0, 120), jump: e.actorId ?? e.location ?? null };
}

const CSS = `
.toasts { position: absolute; left: 10px; bottom: 10px; display: flex; flex-direction: column-reverse; gap: 6px; width: 320px; }
.toast { background: #14171df2; border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 6px; padding: 6px 8px; font-size: 12px; display: flex; gap: 6px; align-items: flex-start; box-shadow: 0 4px 14px #0008; }
.toast.i10 { border-left-color: #e06666; }
.toast .t-icon { font-size: 14px; }
.toast .t-text { flex: 1; }
.toast button { font-size: 11px; padding: 0 6px; }
.toast-gear { position: absolute; left: 10px; bottom: 10px; transform: translateY(calc(100% + 4px)); }
.toast-cfg { position: absolute; left: 10px; bottom: 50px; background: #14171df8; border: 1px solid var(--line); border-radius: 6px; padding: 8px; font-size: 12px; width: 220px; }
.toast-cfg label { display: block; }
.toast-gear-btn { position: absolute; left: 336px; bottom: 10px; font-size: 11px; padding: 1px 6px; opacity: 0.7; }
`;
const injectCss = () => { if (typeof document === 'undefined' || document.getElementById('css-toasts')) return; const s = document.createElement('style'); s.id = 'css-toasts'; s.textContent = CSS; document.head.append(s); };

export function mount(container, api) {
  injectCss();
  const box = document.createElement('div'); box.className = 'toasts';
  const gear = document.createElement('button'); gear.className = 'toast-gear-btn'; gear.textContent = '🔔'; gear.title = 'which events pop up';
  const cfg = document.createElement('div'); cfg.className = 'toast-cfg'; cfg.style.display = 'none';
  container.append(box, gear, cfg);
  const filter = () => ({ ...DEFAULT_FILTER, ...api.prefs.get('toastFilter', {}) });
  const live = [];
  let lastThreads = null;

  function show(t) {
    if (!t) return;
    if (live.some((x) => x.t.id === t.id)) return;
    const el = document.createElement('div');
    el.className = `toast i${t.importance}`;
    el.innerHTML = `<span class="t-icon">${t.icon}</span><span class="t-text">${esc(t.text)}</span>${t.jump ? '<button>jump</button>' : ''}<button data-x>×</button>`;
    const item = { t, el, until: Date.now() + 8000, hover: false };
    el.addEventListener('mouseenter', () => { item.hover = true; });
    el.addEventListener('mouseleave', () => { item.hover = false; item.until = Date.now() + 3000; });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-x]')) { remove(item); return; }
      if (e.target.closest('button') && t.jump) api.jumpTo(t.jump);
    });
    live.push(item);
    box.append(el);
    while (live.length > 5) remove(live[0]);
  }
  function remove(item) { item.el.remove(); live.splice(live.indexOf(item), 1); }
  function drawCfg() {
    const f = filter();
    cfg.innerHTML = `<b>Pop up</b><label>minimum importance <select data-min>${[5, 7, 9].map((v) => `<option ${v === f.min ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      ${Object.entries(TYPES).map(([k, v]) => `<label><input type="checkbox" data-t="${k}" ${f.off.includes(k) ? '' : 'checked'}> ${v.icon} ${esc(v.label)}</label>`).join('')}`;
  }
  gear.addEventListener('click', () => { cfg.style.display = cfg.style.display === 'none' ? '' : 'none'; drawCfg(); });
  cfg.addEventListener('change', (e) => {
    const f = filter();
    if (e.target.dataset.min) f.min = Number(e.target.value);
    if (e.target.dataset.t) f.off = e.target.checked ? f.off.filter((x) => x !== e.target.dataset.t) : [...f.off, e.target.dataset.t];
    api.prefs.set('toastFilter', f);
  });
  const offs = [
    subscribe('event', (e) => show(toastFor(e, api.store, filter()))),
    subscribe('observer', () => {
      const threads = api.store.observer?.threads ?? [];
      if (lastThreads) {
        for (const t of threads) {
          const before = lastThreads.get(t.id);
          if (!before) show(toastFor({ id: `story-${t.id}`, type: 'storyline', data: { text: `New storyline: ${t.title ?? t.id}` } }, api.store, filter()));
          else if (before !== (t.status ?? '')) show(toastFor({ id: `story-${t.id}-${t.status}`, type: 'storyline', data: { text: `${t.title ?? t.id}: ${t.status}` } }, api.store, filter()));
        }
      }
      lastThreads = new Map(threads.map((t) => [t.id, t.status ?? '']));
    }),
  ];
  lastThreads = new Map((api.store.observer?.threads ?? []).map((t) => [t.id, t.status ?? '']));
  return {
    update() { const now = Date.now(); for (const it of [...live]) if (!it.hover && now > it.until) remove(it); },
    unmount() { offs.forEach((o) => o()); container.innerHTML = ''; },
  };
}
