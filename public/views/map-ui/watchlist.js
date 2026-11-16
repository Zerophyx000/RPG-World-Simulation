// Step 9: the watch list. Up to 6 citizens pinned in a row of small portraits at the top-right of the map (drawn
// from their character sprites), with status chips (asleep, bleeding, the critical countdown) and their feeling as
// the frame colour. Click one to centre and select them; a red pulse means something important just happened to
// them, even off-screen.
import { subscribe } from '../../store.js';
import { esc } from '../../util.js';
import * as character from '../../art/character.js';
import { CanvasTarget } from '../../art/target.js';

const MAX = 6;
const IMPORTANT = new Set(['death', 'injury', 'critical_window', 'director_effect', 'signal']);
const FEELING = { anger: '#e05555', fear: '#a98be6', sadness: '#5fa0d9', joy: '#e0c040', affection: '#e58ad6', shame: '#c08060', guilt: '#a07090', jealousy: '#7bc55e', envy: '#6cc28a', disgust: '#8aa040', pride: '#e0a43a', gratitude: '#e0d070' };

/** Add a citizen to the list: no duplicates, at most 6 (the oldest drops out). */
export function watchAdd(list, id) {
  if (!id || list.includes(id)) return list.slice();
  return [...list, id].slice(-MAX);
}

const CSS = `
.watch { position: absolute; right: 10px; top: 10px; display: flex; gap: 6px; align-items: flex-start; }
.watch .w-item { position: relative; width: 52px; text-align: center; cursor: pointer; font-size: 10px; }
.watch canvas { width: 52px; height: 40px; image-rendering: pixelated; border: 2px solid #444; border-radius: 6px; background: #1d2230; display: block; }
.watch .w-name { color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.watch .w-chips { position: absolute; left: 2px; top: 2px; font-size: 10px; text-shadow: 0 0 2px #000; }
.watch .w-crit { color: #ff8a80; font-weight: 700; }
.watch .w-x { position: absolute; right: -4px; top: -6px; display: none; font-size: 10px; padding: 0 4px; line-height: 14px; }
.watch .w-item:hover .w-x { display: block; }
.watch .pulse canvas { animation: wpulse 0.8s ease-in-out 8; border-color: #e05555; }
@keyframes wpulse { 50% { box-shadow: 0 0 0 4px #e0555588; } }
.watch .w-add { font-size: 12px; padding: 2px 7px; }
`;
const injectCss = () => { if (typeof document === 'undefined' || document.getElementById('css-watch')) return; const s = document.createElement('style'); s.id = 'css-watch'; s.textContent = CSS; document.head.append(s); };

export function mount(container, api) {
  injectCss();
  const row = document.createElement('div'); row.className = 'watch';
  container.append(row);
  const items = new Map(); // id -> { el, canvas, key, pulseUntil }
  let list = api.prefs.get('watchList', []);
  let addBtn = null;
  const save = () => api.prefs.set('watchList', list);

  function build() {
    for (const [id, it] of items) if (!list.includes(id)) { it.el.remove(); items.delete(id); }
    for (const id of list) {
      if (items.has(id)) continue;
      const el = document.createElement('div'); el.className = 'w-item'; el.dataset.id = id;
      el.innerHTML = '<canvas width="64" height="48"></canvas><div class="w-chips"></div><div class="w-name"></div><button class="w-x" title="remove">×</button>';
      el.addEventListener('click', (e) => {
        if (e.target.closest('.w-x')) { list = list.filter((x) => x !== id); save(); build(); return; }
        api.select(id); api.jumpTo(id);
      });
      items.set(id, { el, canvas: el.querySelector('canvas'), key: '', pulseUntil: 0 });
      row.insertBefore(el, addBtn);
    }
  }
  addBtn = document.createElement('button'); addBtn.className = 'w-add'; addBtn.textContent = '+'; addBtn.title = 'watch the selected citizen';
  addBtn.addEventListener('click', () => { const id = api.store.selectedId; if (id) { list = watchAdd(list, id); save(); build(); } });
  row.append(addBtn);
  build();

  function draw(id, it) {
    const c = api.store.citizens.get(id);
    if (!c) return;
    const expr = c.look?.expression ?? 'neutral';
    const key = `${JSON.stringify(c.look ?? null)}|${expr}|${c.alive}`;
    if (key !== it.key && api.pal && c.look) {
      it.key = key;
      let img;
      try {
        img = character.portrait ? character.portrait(api.pal, c.look, expr, 2) : character.characterSprite(api.pal, c.look).frame('down', 'idle', 0, expr).img.crop(0, 0, 34, 24).scale(2);
      } catch { img = null; }
      if (img) {
        const g = it.canvas.getContext('2d'); g.imageSmoothingEnabled = false;
        g.clearRect(0, 0, it.canvas.width, it.canvas.height);
        g.drawImage(CanvasTarget.canvasOf(img), Math.round((it.canvas.width - img.w) / 2), 0);
      }
    }
    const b = c.body ?? {};
    const chips = `${c.activity?.type === 'sleeping' ? 'z' : ''}${(b.bleeding ?? 0) > 0.5 ? '🩸' : ''}${b.critical != null ? `<span class="w-crit">${Math.round(b.critical)}m</span>` : ''}${c.alive === false ? '✝' : ''}`;
    const dom = c.emotion?.dominant;
    const border = dom && dom.intensity >= 3 ? FEELING[dom.type] ?? '#444' : '#444';
    const meta = `${chips}|${border}|${c.name}`;
    if (it.meta !== meta) { it.meta = meta; it.el.querySelector('.w-chips').innerHTML = chips; it.el.querySelector('.w-name').textContent = c.name; it.canvas.style.borderColor = border; it.el.title = `${esc(c.name)}`; }
    it.el.classList.toggle('pulse', Date.now() < it.pulseUntil);
  }

  const offs = [subscribe('event', (e) => {
    if (!e?.actorId || !items.has(e.actorId)) return;
    if (IMPORTANT.has(e.type) || (e.type === 'action' && e.data?.volume === 'shout')) items.get(e.actorId).pulseUntil = Date.now() + 6000;
  })];
  return {
    update() { for (const [id, it] of items) draw(id, it); },
    unmount() { offs.forEach((o) => o()); row.remove(); },
  };
}
