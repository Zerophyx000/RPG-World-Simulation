// "Act on a citizen": quick director actions used by the inspector (and the Director tab).
// Everything goes through POST /api/director/apply (effects) or /api/director/needs.
import { store } from '../store.js';
import { api, esc, roomName } from '../util.js';

const QUICK = [
  { label: '−10 hp', effects: (id) => [{ type: 'damage', target: id, amount: 10 }] },
  { label: '−30 hp', effects: (id) => [{ type: 'damage', target: id, amount: 30 }] },
  { label: '+30 hp', effects: (id) => [{ type: 'heal', target: id, amount: 30 }] },
  { label: 'Fed', effects: (id) => [{ type: 'needs', target: id, mode: 'add', hunger: -50, notify: false }] },
  { label: 'Starving', effects: (id) => [{ type: 'needs', target: id, mode: 'set', hunger: 80, notify: false }] },
  { label: 'Rested', effects: (id) => [{ type: 'needs', target: id, mode: 'set', fatigue: 0, notify: false }] },
  { label: 'Exhausted', effects: (id) => [{ type: 'needs', target: id, mode: 'set', fatigue: 90, notify: false }] },
  { label: '💤 Sleep', effects: (id) => [{ type: 'sleep', target: id }], when: (c) => !['sleeping', 'collapsed'].includes(c.activity?.type) },
  { label: '☀ Wake', effects: (id) => [{ type: 'wake', target: id }], when: (c) => c.activity?.type === 'sleeping' },
  { label: '⛔ Knock out', effects: (id) => [{ type: 'collapse', target: id }], when: (c) => c.activity?.type !== 'collapsed' },
  { label: '✚ Revive', effects: (id) => [{ type: 'revive', target: id }], when: (c) => c.activity?.type === 'collapsed' },
];

/** Panel HTML for one citizen (detail = GET /api/citizens/:id). */
export function actPanelHtml(c) {
  const rooms = [...store.rooms.values()];
  const roomOpts = rooms.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  const n = c.needsView ?? {};
  const slider = (k, max) => `<label class="slider">${k}
      <input type="range" min="0" max="${max}" step="1" value="${Math.round(n[k]?.value ?? 0)}" data-need="${k}">
      <output>${Math.round(n[k]?.value ?? 0)}</output></label>`;
  return `<div class="act" data-act="${esc(c.id)}">
    <div class="act-row">${QUICK.filter((q) => !q.when || q.when(c)).map((q, i) => `<button data-quick="${QUICK.indexOf(q)}">${esc(q.label)}</button>`).join('')}</div>
    <div class="act-sliders">${slider('hunger', 100)}${slider('fatigue', 100)}${slider('hp', n.hp?.max ?? 100)}
      <button data-set-needs>Set needs</button></div>
    <div class="act-row"><select data-f="move">${roomOpts}</select><button data-do="move">Move there</button>
      <select data-f="place">${roomOpts}</select><button data-do="knowPlace">Teach place</button><button data-do="forgetPlace">Forget</button></div>
    <div class="act-row"><input data-f="mark" placeholder="looks… e.g. covered in soot"><input data-f="markMin" type="number" min="1" placeholder="min"><button data-do="mark">Mark</button><button data-do="unmark">Clear marks</button></div>
    <div class="act-row"><input data-f="goal" placeholder="a new goal"><button data-do="goal">Add goal</button></div>
    <div class="act-row"><input data-f="whisper" placeholder="they suddenly hear / remember…"><input data-f="whisperImp" type="number" min="1" max="10" value="7"><button data-do="whisper">Whisper</button></div>
    <div class="act-result dim"></div>
  </div>`;
}

/** Wire up a container that holds act panels (call once per container). */
export function bindActPanels(container, onDone) {
  container.addEventListener('input', (e) => {
    const r = e.target.closest('input[type=range]');
    if (r) r.nextElementSibling.textContent = r.value;
  });
  container.addEventListener('click', async (e) => {
    const panel = e.target.closest('[data-act]');
    if (!panel) return;
    const id = panel.dataset.act;
    const f = (name) => panel.querySelector(`[data-f="${name}"]`)?.value?.trim();
    const out = panel.querySelector('.act-result');
    let effects = null;
    try {
      if (e.target.closest('[data-quick]')) effects = QUICK[Number(e.target.closest('[data-quick]').dataset.quick)].effects(id);
      else if (e.target.closest('[data-set-needs]')) {
        const v = Object.fromEntries([...panel.querySelectorAll('[data-need]')].map((i) => [i.dataset.need, Number(i.value)]));
        await api.post('/api/director/needs', { citizenId: id, ...v });
        out.textContent = 'needs set (levels update on the next tick)';
        return onDone?.();
      } else {
        const what = e.target.closest('[data-do]')?.dataset.do;
        if (!what) return;
        effects = {
          move: () => [{ type: 'move', target: id, to: f('move') }],
          knowPlace: () => [{ type: 'knowPlace', target: id, place: f('place') }],
          forgetPlace: () => [{ type: 'forgetPlace', target: id, place: f('place') }],
          mark: () => [{ type: 'mark', target: id, text: f('mark'), minutes: Number(f('markMin')) || undefined }],
          unmark: () => [{ type: 'unmark', target: id }],
          goal: () => [{ type: 'goal', target: id, text: f('goal') }],
          whisper: () => [{ type: 'whisper', target: id, text: f('whisper'), importance: Number(f('whisperImp')) || 7 }],
        }[what]();
      }
      const r = await api.post('/api/director/apply', { effects });
      out.textContent = `done: ${r.effects.map((x) => x.type).join(', ')}`;
      out.className = 'act-result ok';
      onDone?.();
    } catch (err) {
      out.textContent = err.message;
      out.className = 'act-result bad';
    }
  });
}

export function roomOptions(selected) {
  return [...store.rooms.values()].map((r) => `<option value="${esc(r.id)}" ${r.id === selected ? 'selected' : ''}>${esc(roomName(r.id))}</option>`).join('');
}
