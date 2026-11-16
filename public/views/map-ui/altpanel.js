// Step 10 §7: fights on the map. While an altercation is active a compact panel opens next to the fighters (placed like
// the conversation panel, never over them): participants by side with status icons (bleeding, dazed, on the floor,
// held, tied, senseless), the last exchanges as compact lines (actor → action → result) and, in god view, each one's
// intent. It shows the selected citizen's fight, or every fight when nobody is selected; an ended fight says why for a
// few seconds.
import { subscribe } from '../../store.js';
import { esc } from '../../util.js';
import { panelPlacement } from './convpanel.js';

const ENDED_MS = 5000;
const ICON = { bleeding: '🩸', dazed: '💫', winded: '😮‍💨', 'on the floor': '⤵', senseless: '💤', 'not moving': '✝', 'tied up': '🪢', choking: '✋', 'has given up': '🏳' };
const VERB = { shove: 'shoves', grab: 'grabs', slap: 'slaps', punch: 'punches', kick: 'kicks', strike: 'strikes', throw_at: 'throws at', snatch: 'snatches from', pin_down: 'pins', choke: 'chokes', tie_up: 'ties up', drag: 'drags', dodge: 'dodges', block: 'blocks', break_free: 'breaks free of', yield: 'yields to', plead: 'pleads with', pull_away: 'pulls away from', embrace: 'holds', hold_hand: 'holds hands with', comfort: 'comforts', help_up: 'helps up', support: 'supports', hold_back: 'holds back', free: 'unties' };
const INTENT = { scare: 'to scare', subdue: 'to subdue', hurt: 'to hurt', kill: 'to kill', defend: 'defending', care: 'caring' };

const CSS = `
.ap-panel { position: absolute; width: 290px; max-height: 300px; overflow: auto; background: #1d1214f2; border: 1px solid #a33; border-radius: 8px; padding: 6px 8px 8px; font-size: 12px; box-shadow: 0 4px 18px #0008; }
.ap-panel.ended { border-color: var(--line); opacity: .85; }
.ap-title { font-weight: 600; color: #f08a8a; display: flex; gap: 6px; align-items: center; }
.ap-title .ap-x { margin-left: auto; padding: 0 6px; font-size: 11px; line-height: 18px; }
.ap-sides { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 4px 0; }
.ap-side { background: #ffffff08; border-radius: 6px; padding: 3px 5px; }
.ap-who { display: block; }
.ap-state { color: var(--muted); font-size: 11px; }
.ap-intent { color: #d8b47a; font-size: 11px; font-style: italic; }
.ap-line { padding: 2px 0; border-top: 1px solid #ffffff10; }
.ap-line .miss { color: var(--muted); }
.ap-line .fx { color: #f0a0a0; }
.ap-ended { color: var(--muted); font-style: italic; padding-top: 3px; }
`;
const injectCss = () => { if (typeof document === 'undefined' || document.getElementById('css-altpanel')) return; const s = document.createElement('style'); s.id = 'css-altpanel'; s.textContent = CSS; document.head.append(s); };

/** Compact lines for the last exchanges ("Tomas punches Kael — dazed, bleeding" / "— misses"). */
export function exchangeLines(alt, name, n = 6) {
  return (alt?.exchanges ?? []).slice(-n).map((e) => {
    const res = e.hit === false ? 'misses' : (e.effects ?? []).filter((f) => f !== 'woken').join(', ');
    return { actor: e.actor, target: e.target, text: `${name(e.actor)} ${VERB[e.action] ?? e.action} ${name(e.target)}`, result: res, miss: e.hit === false, words: e.words ?? null };
  });
}

export function mount(container, api) {
  injectCss();
  const store = api.store;
  const panels = new Map(); // altId -> { el, endedAt, closed }
  const name = (id) => store.citizens.get(id)?.name ?? id;
  let lastFrame = null;

  function fill(p, alt) {
    const god = api.isGod();
    const side = (s) => alt.participants.filter((x) => x.side === s).map((x) => `<span class="ap-who" style="color:${api.colorOf(x.id)}">${esc(x.name ?? name(x.id))} ${(x.state ?? []).map((w) => ICON[w] ? `<span title="${esc(w)}">${ICON[w]}</span>` : '').join('')}${(x.state ?? []).length ? `<br><span class="ap-state">${esc((x.state ?? []).join(', '))}</span>` : ''}${god && x.intent ? `<br><span class="ap-intent">${esc(INTENT[x.intent] ?? x.intent)}${x.role === 'holder' ? ' (holding back)' : ''}</span>` : ''}</span>`).join('');
    const lines = exchangeLines(alt, name).map((l) => `<div class="ap-line">${esc(l.text)} ${l.miss ? '<span class="miss">— misses</span>' : l.result ? `<span class="fx">— ${esc(l.result)}</span>` : ''}${l.words ? `<br><i>"${esc(l.words)}"</i>` : ''}</div>`).join('');
    const ended = alt.status !== 'active';
    p.el.classList.toggle('ended', ended);
    p.el.innerHTML = `<div class="ap-title">⚔ Fight in ${esc(store.rooms.get(alt.roomId)?.name ?? alt.roomId)}<button class="ap-x" data-a="close">×</button></div>
      <div class="ap-sides"><div class="ap-side">${side('a')}</div><div class="ap-side">${side('b')}</div></div>${lines}${ended ? `<div class="ap-ended">Over: ${esc(alt.endReason ?? '')}</div>` : ''}`;
  }

  function render(frame) {
    lastFrame = frame ?? lastFrame;
    const sel = store.selectedId;
    const list = store.altercations ?? [];
    const want = new Map();
    for (const alt of list) {
      const mine = !sel || alt.participants.some((p) => p.id === sel) || store.citizens.get(sel)?.location === alt.roomId;
      if (!mine) continue;
      if (alt.status === 'active') want.set(alt.id, alt);
      else {
        const p = panels.get(alt.id);
        if (p) { p.endedAt ||= Date.now(); if (Date.now() - p.endedAt < ENDED_MS) want.set(alt.id, alt); }
      }
    }
    for (const [id, p] of panels) if (!want.has(id) || p.closed) { if (!want.has(id)) { p.el.remove(); panels.delete(id); } }
    const stage = api.stageSize();
    for (const [id, alt] of want) {
      let p = panels.get(id);
      if (!p) {
        const el = document.createElement('div');
        el.className = 'ap-panel';
        el.addEventListener('click', (e) => { if (e.target.closest('[data-a="close"]')) { panels.get(id).closed = true; panels.get(id).el.style.display = 'none'; } });
        container.append(el);
        p = { el, endedAt: 0, closed: false, key: '' };
        panels.set(id, p);
      }
      if (p.closed) continue;
      const key = `${alt.exchanges?.length}|${alt.status}|${api.isGod()}|${alt.participants.map((x) => `${x.id}:${(x.state ?? []).join('+')}`).join()}`;
      if (p.key !== key) { p.key = key; fill(p, alt); }
      const size = { w: p.el.offsetWidth || 290, h: p.el.offsetHeight || 150 };
      let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
      for (const part of alt.participants) {
        const person = lastFrame?.people?.get(part.id);
        if (!person) continue;
        const s = api.worldToScreen(person.x, person.y);
        x0 = Math.min(x0, s.x - 18); x1 = Math.max(x1, s.x + 18); y0 = Math.min(y0, s.y - 50); y1 = Math.max(y1, s.y + 4);
      }
      const at = x0 === Infinity ? { x: 10, y: 60 } : panelPlacement({ x0, y0, x1, y1 }, size, stage);
      p.el.style.left = `${at.x}px`; p.el.style.top = `${at.y}px`;
    }
  }

  const offs = [subscribe('altercation', () => render(null)), subscribe('selection', () => render(null))];
  return {
    update(_S, frame) { render(frame); },
    unmount() { offs.forEach((o) => o()); container.innerHTML = ''; },
  };
}
