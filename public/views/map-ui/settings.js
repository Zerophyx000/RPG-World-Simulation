// Step 9: graphics settings. A gear at the top-right (left of the watch list) opens a panel with the quality level
// (low / medium / high) and a switch per feature (public/render/quality.js FEATURES), plus the director camera and
// the replay bar. Everything here is visual only.
import { esc } from '../../util.js';
import { FEATURES } from '../../render/quality.js';

const CSS = `
.gfx-btn { position: absolute; right: 10px; top: 72px; font-size: 13px; padding: 2px 7px; }
.gfx-panel { position: absolute; right: 10px; top: 102px; width: 270px; background: #14171df8; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 12px; box-shadow: 0 4px 18px #0008; }
.gfx-panel h4 { margin: 0 0 6px; font-size: 13px; }
.gfx-panel .seg button { padding: 2px 10px; font-size: 12px; }
.gfx-panel .seg button.on { border-color: var(--accent); color: var(--accent); }
.gfx-panel label { display: flex; gap: 6px; align-items: center; margin: 3px 0; color: var(--text); }
.gfx-panel label span { color: var(--muted); font-size: 11px; }
.gfx-panel .gfx-row { display: flex; gap: 6px; margin-top: 8px; }
`;
const injectCss = () => { if (typeof document === 'undefined' || document.getElementById('css-gfx')) return; const s = document.createElement('style'); s.id = 'css-gfx'; s.textContent = CSS; document.head.append(s); };

export function mount(container, api) {
  injectCss();
  const btn = document.createElement('button'); btn.className = 'gfx-btn'; btn.textContent = '⚙'; btn.title = 'graphics';
  const panel = document.createElement('div'); panel.className = 'gfx-panel'; panel.style.display = 'none';
  container.append(btn, panel);
  const q = api.quality;
  function draw() {
    panel.innerHTML = `<h4>Graphics</h4>
      <div class="seg">${q.LEVELS.map((l) => `<button data-level="${l}" class="${q.level === l ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${Object.entries(FEATURES).map(([f, label]) => `<label><input type="checkbox" data-f="${f}" ${q.get(f) ? 'checked' : ''}> ${esc(f)} <span>${esc(label)}</span></label>`).join('')}
      <div class="gfx-row"><button data-a="director">director cam ${api.directorCam.active ? 'on' : 'off'} (D)</button><button data-a="replay">replay (R)</button></div>`;
  }
  btn.addEventListener('click', () => { panel.style.display = panel.style.display === 'none' ? '' : 'none'; draw(); });
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.level) q.setLevel(b.dataset.level);
    else if (b.dataset.a === 'director') api.toggleDirectorCam();
    else if (b.dataset.a === 'replay') api.toggleReplayBar();
    draw();
  });
  panel.addEventListener('change', (e) => { const f = e.target.dataset.f; if (f) q.toggle(f, e.target.checked); });
  const off = q.subscribe(() => { if (panel.style.display !== 'none') draw(); });
  return { update() {}, unmount() { off(); btn.remove(); panel.remove(); } };
}
