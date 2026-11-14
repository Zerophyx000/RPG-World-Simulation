// Step 9: the replay bar (R). Pick a stretch of game time (the last 15 minutes, hour or 6 hours, or a custom range),
// play it back on the map at 1x-60x with pause and a scrub slider, then return to live. While a replay runs a REPLAY
// banner shows; the live world keeps running in the background.
import { esc } from '../../util.js';

const fmt = (t) => { const d = Math.floor(t / 1440) + 1; const m = ((t % 1440) + 1440) % 1440; return `Day ${d} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`; };
/** "3 14:05" or "14:05" (today) -> game minutes. */
function parseTime(s, now) {
  const m = /^(?:(\d+)\s+)?(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const day = m[1] ? Number(m[1]) : Math.floor(now / 1440) + 1;
  return (day - 1) * 1440 + Number(m[2]) * 60 + Number(m[3]);
}

const CSS = `
.rbar { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); background: #14171df4; border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; font-size: 12px; display: flex; gap: 6px; align-items: center; box-shadow: 0 4px 18px #0008; }
.rbar.active { border-color: #e06666; }
.rbar .r-banner { color: #ff8a80; font-weight: 700; letter-spacing: 1px; }
.rbar input[type=range] { width: 220px; }
.rbar input.r-t { width: 70px; padding: 1px 4px; }
.rbar button, .rbar select { padding: 1px 7px; font-size: 12px; }
.rbar .r-time { min-width: 92px; color: var(--accent); }
`;
const injectCss = () => { if (typeof document === 'undefined' || document.getElementById('css-rbar')) return; const s = document.createElement('style'); s.id = 'css-rbar'; s.textContent = CSS; document.head.append(s); };

export function mount(container, api) {
  injectCss();
  const bar = document.createElement('div'); bar.className = 'rbar'; bar.style.display = 'none';
  container.append(bar);
  const rp = api.replay;
  let key = ''; let scrubbing = false;
  const now = () => api.store.clock?.gameMinutes ?? 0;

  function draw() {
    const active = rp.active;
    bar.classList.toggle('active', active);
    if (!active) {
      bar.innerHTML = `<b>Replay</b>
        <select data-range><option value="15">last 15 min</option><option value="60" selected>last hour</option><option value="360">last 6 h</option><option value="custom">custom…</option></select>
        <input class="r-t hidden" data-from placeholder="from hh:mm"><input class="r-t hidden" data-to placeholder="to hh:mm">
        <button data-a="load">${rp.loading ? 'loading…' : 'Load & play'}</button>${rp.error ? `<span style="color:#e06666">${esc(rp.error)}</span>` : ''}<button data-a="close">×</button>`;
    } else {
      bar.innerHTML = `<span class="r-banner">REPLAY</span>
        <button data-a="toggle">${rp.playing ? '❚❚' : '▶'}</button>
        <select data-speed>${[1, 5, 15, 30, 60].map((s) => `<option value="${s}" ${s === rp.speed ? 'selected' : ''}>${s}×</option>`).join('')}</select>
        <input type="range" data-scrub min="${rp.from}" max="${rp.to}" step="0.1" value="${rp.t}">
        <span class="r-time">${fmt(rp.t)}</span>
        <button data-a="live">Back to live</button>`;
    }
  }
  bar.addEventListener('change', (e) => {
    if (e.target.dataset.range != null) { const custom = e.target.value === 'custom'; bar.querySelectorAll('.r-t').forEach((x) => x.classList.toggle('hidden', !custom)); }
    if (e.target.dataset.speed != null) rp.setSpeed(Number(e.target.value));
  });
  bar.addEventListener('input', (e) => { if (e.target.dataset.scrub != null) { scrubbing = true; rp.seek(Number(e.target.value)); bar.querySelector('.r-time').textContent = fmt(rp.t); } });
  bar.addEventListener('pointerup', () => { scrubbing = false; });
  bar.addEventListener('click', async (e) => {
    const a = e.target.closest('button')?.dataset.a; if (!a) return;
    if (a === 'load') {
      const sel = bar.querySelector('[data-range]').value; const t = now();
      let from = t - Number(sel); let to = t;
      if (sel === 'custom') { from = parseTime(bar.querySelector('[data-from]').value, t) ?? t - 60; to = parseTime(bar.querySelector('[data-to]').value, t) ?? t; }
      key = ''; draw();
      await rp.load(from, to);
      key = '';
    } else if (a === 'toggle') { if (rp.playing) rp.pause(); else rp.play(); }
    else if (a === 'live') { rp.stop(); if (api.isReplayBarOpen()) api.toggleReplayBar(); }
    else if (a === 'close') { if (api.isReplayBarOpen()) api.toggleReplayBar(); }
    key = '';
  });
  return {
    update() {
      const show = rp.active || api.isReplayBarOpen();
      bar.style.display = show ? '' : 'none';
      if (!show) return;
      const k = `${rp.active}|${rp.playing}|${rp.loading}|${rp.error}|${rp.from}|${rp.to}|${rp.speed}`;
      if (k !== key) { key = k; draw(); }
      if (rp.active && !scrubbing) { const s = bar.querySelector('[data-scrub]'); if (s) s.value = rp.t; const tt = bar.querySelector('.r-time'); if (tt) tt.textContent = fmt(rp.t); }
    },
    unmount() { bar.remove(); },
  };
}
