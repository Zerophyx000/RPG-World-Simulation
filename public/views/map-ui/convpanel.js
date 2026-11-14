// Step 9: conversations on the map. When the selected (or followed) citizen is in a conversation, a compact panel
// opens next to the speakers (never covering them, always inside the stage): participant chips with their feeling,
// the last 6 lines (→ addressee), whispers marked (their words hidden in plain view unless the selected citizen
// takes part), the inner thought under each line in god view (toggle), "typing…" while a line waits for the
// reading floor. Pin keeps a panel (pinned panels stack at the right edge), expand opens the Conversations view,
// an ended conversation says why for a few seconds. The lines are drawn by `lineRenderer`, so a later dialogue box
// (portraits, typewriter text) can replace it.
import { subscribe } from '../../store.js';
import { esc } from '../../util.js';

const ENDED_MS = 4000;
const MAX_PINNED = 4;

/** Where to put a panel of `size` next to a group's screen box, inside the stage, never over the group. */
export function panelPlacement(group, size, stage, margin = 10) {
  const g = { x0: group.x0, y0: group.y0 - 60, x1: group.x1, y1: group.y1 }; // heads and names above the feet
  const fits = (x, y) => x >= 4 && y >= 4 && x + size.w <= stage.w - 4 && y + size.h <= stage.h - 4;
  const overlaps = (x, y) => x < g.x1 && x + size.w > g.x0 && y < g.y1 && y + size.h > g.y0;
  const midY = (g.y0 + g.y1) / 2 - size.h / 2; const midX = (g.x0 + g.x1) / 2 - size.w / 2;
  const tries = [[g.x1 + margin, midY], [g.x0 - margin - size.w, midY], [midX, g.y0 - margin - size.h], [midX, g.y1 + margin]];
  for (const [x, y] of tries) {
    const cx = Math.max(4, Math.min(stage.w - size.w - 4, x)); const cy = Math.max(4, Math.min(stage.h - size.h - 4, y));
    if (fits(cx, cy) && !overlaps(cx, cy)) return { x: Math.round(cx), y: Math.round(cy) };
  }
  // no room: the corner farthest from the group
  const right = (g.x0 + g.x1) / 2 < stage.w / 2;
  return { x: right ? Math.max(4, stage.w - size.w - 4) : 4, y: 4 };
}

/** The lines to show: the last 6, whispered words masked in plain view unless the viewer takes part, thoughts in god view. */
export function visibleLines(conv, { god = true, selectedId = null, thoughts = true } = {}) {
  return (conv?.lines ?? []).slice(-6).map((l) => {
    const party = selectedId && (l.speakerId === selectedId || l.toId === selectedId);
    const whisper = l.volume === 'whisper';
    return {
      speakerId: l.speakerId, toId: l.toId ?? null, whisper, shout: l.volume === 'shout',
      text: whisper && !god && !party ? '…' : l.text,
      thought: god && thoughts ? (l.thought ?? null) : null,
    };
  });
}

/** Draws conversation lines into a container (replaceable: a dialogue box can take its place later). */
export const lineRenderer = {
  render(container, lines, { name, color }) {
    container.innerHTML = lines.map((l) => `<div class="cp-line${l.shout ? ' shout' : ''}">
      <b style="color:${color(l.speakerId)}">${esc(name(l.speakerId))}</b>${l.toId ? `<span class="cp-to"> → ${esc(name(l.toId))}</span>` : ''}${l.whisper ? ' <span class="cp-tag">(whispered)</span>' : ''}
      <span class="cp-text">${esc(l.text)}</span>${l.thought ? `<div class="cp-thought">${esc(l.thought)}</div>` : ''}</div>`).join('');
  },
};

const CSS = `
.cp-panel { position: absolute; width: 300px; max-height: 330px; overflow: auto; background: #14171df2; border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px 8px; font-size: 12px; box-shadow: 0 4px 18px #0008; }
.cp-panel.pinned { border-color: var(--accent); }
.cp-head { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-bottom: 4px; }
.cp-chip { padding: 1px 6px; border-radius: 9px; background: #262a32; font-size: 11px; }
.cp-chip i { color: var(--muted); font-style: normal; }
.cp-btns { margin-left: auto; display: flex; gap: 2px; }
.cp-btns button { padding: 0 6px; font-size: 11px; line-height: 18px; }
.cp-btns button.on { border-color: var(--accent); color: var(--accent); }
.cp-line { padding: 2px 0; border-top: 1px solid #ffffff10; }
.cp-line.shout .cp-text { font-weight: 600; }
.cp-to, .cp-tag { color: var(--muted); font-size: 11px; }
.cp-text { display: block; }
.cp-thought { color: #9fb0d8; font-style: italic; font-size: 11px; }
.cp-typing, .cp-ended { color: var(--muted); font-style: italic; padding-top: 3px; }
`;
const injectCss = () => { if (typeof document === 'undefined' || document.getElementById('css-convpanel')) return; const s = document.createElement('style'); s.id = 'css-convpanel'; s.textContent = CSS; document.head.append(s); };

export function mount(container, api) {
  injectCss();
  const store = api.store;
  const panels = new Map(); // convId -> { el, pinned, closedAt, endedAt, reason, lastLen, key }
  let selKey = '';
  const name = (id) => store.citizens.get(id)?.name ?? id;
  const color = (id) => api.colorOf(id);

  function panelFor(id) {
    let p = panels.get(id);
    if (p) return p;
    const el = document.createElement('div');
    el.className = 'cp-panel';
    el.innerHTML = '<div class="cp-head"></div><div class="cp-lines"></div><div class="cp-foot"></div>';
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const panel = panels.get(id);
      if (b.dataset.a === 'pin') { panel.pinned = !panel.pinned; if (panel.pinned && [...panels.values()].filter((x) => x.pinned).length > MAX_PINNED) panel.pinned = false; }
      else if (b.dataset.a === 'close') { panel.closedAt = Date.now(); panel.pinned = false; panel.closedLen = panel.lastLen; }
      else if (b.dataset.a === 'expand') api.openConversation(id);
      else if (b.dataset.a === 'thoughts') api.prefs.set('convThoughts', !api.prefs.get('convThoughts', true));
      panel.key = ''; render(api.store, lastFrame);
    });
    container.append(el);
    p = { el, pinned: false, closedAt: 0, closedLen: -1, endedAt: 0, reason: null, lastLen: 0, key: '' };
    panels.set(id, p);
    return p;
  }

  function fill(id, p, conv) {
    const god = api.isGod();
    const thoughts = api.prefs.get('convThoughts', true);
    const ended = !conv;
    const key = `${conv?.lines?.length ?? 'x'}|${conv?.held?.length ?? 0}|${god}|${thoughts}|${p.pinned}|${ended}|${(conv?.participants ?? []).join()}`;
    if (p.key === key) return;
    p.key = key;
    p.el.classList.toggle('pinned', p.pinned);
    const parts = conv?.participants ?? p.participants ?? [];
    p.participants = parts;
    const chips = parts.map((pid) => { const e = store.citizens.get(pid)?.emotion?.dominant; return `<span class="cp-chip" style="color:${color(pid)}">${esc(name(pid))}${e && e.intensity >= 3 ? ` <i>${esc(e.type)}</i>` : ''}</span>`; }).join('');
    p.el.querySelector('.cp-head').innerHTML = `${chips}<span class="cp-btns">${god ? `<button data-a="thoughts" class="${thoughts ? 'on' : ''}" title="inner thoughts">💭</button>` : ''}<button data-a="expand" title="open in Conversations">⤢</button><button data-a="pin" class="${p.pinned ? 'on' : ''}" title="pin">📌</button><button data-a="close" title="close">×</button></span>`;
    if (conv) { lineRenderer.render(p.el.querySelector('.cp-lines'), visibleLines(conv, { god, selectedId: store.selectedId, thoughts }), { name, color }); p.conv = conv; }
    const foot = p.el.querySelector('.cp-foot');
    if (ended) foot.innerHTML = `<div class="cp-ended">Conversation ended${p.reason ? ` (${esc(p.reason)})` : ''}</div>`;
    else foot.innerHTML = conv.held?.length ? `<div class="cp-typing">${esc(name(conv.held[0].citizenId))} is typing…</div>` : '';
  }

  let lastFrame = null;
  function render(_S, frame) {
    lastFrame = frame ?? lastFrame;
    const sel = store.selectedId;
    const followed = api.isFollowing() ? sel : null;
    const focusConv = sel ? store.citizens.get(sel)?.conversationId ?? null : null;
    if (`${sel}|${focusConv}` !== selKey) { selKey = `${sel}|${focusConv}`; for (const p of panels.values()) p.closedAt = 0; }
    const want = new Set();
    if (focusConv) want.add(focusConv);
    for (const [id, p] of panels) if (p.pinned) want.add(id);
    void followed;
    // ended conversations stay a moment
    for (const [id, p] of panels) {
      if (!store.conversations.has(id)) {
        const end = store.endedConversations?.get(id);
        if (!p.endedAt) { p.endedAt = Date.now(); p.reason = end?.reason ?? null; }
        if (p.pinned || Date.now() - p.endedAt < ENDED_MS) want.add(id);
      }
    }
    for (const [id, p] of panels) if (!want.has(id)) { p.el.remove(); panels.delete(id); }
    const stage = api.stageSize();
    let pinY = 54;
    for (const id of want) {
      const conv = store.conversations.get(id);
      const p = panelFor(id);
      if (conv) p.lastLen = conv.lines?.length ?? 0;
      if (p.closedAt && !p.pinned) { if (p.lastLen > p.closedLen) p.closedAt = 0; else { p.el.style.display = 'none'; continue; } }
      p.el.style.display = '';
      fill(id, p, conv);
      const size = { w: p.el.offsetWidth || 300, h: p.el.offsetHeight || 160 };
      if (p.pinned && id !== focusConv) { p.el.style.left = `${stage.w - size.w - 10}px`; p.el.style.top = `${pinY}px`; pinY += size.h + 8; continue; }
      // anchor next to the speakers
      const ids = conv?.participants ?? p.participants ?? [];
      let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
      for (const pid of ids) {
        const person = lastFrame?.people?.get(pid);
        if (!person) continue;
        const s = api.worldToScreen(person.x, person.y);
        x0 = Math.min(x0, s.x - 18); x1 = Math.max(x1, s.x + 18); y0 = Math.min(y0, s.y - 50); y1 = Math.max(y1, s.y + 4);
      }
      const at = x0 === Infinity ? { x: 10, y: stage.h - size.h - 10 } : panelPlacement({ x0, y0, x1, y1 }, size, stage);
      p.el.style.left = `${at.x}px`; p.el.style.top = `${at.y}px`;
    }
  }

  const offs = [subscribe('conversation', () => render(null, lastFrame)), subscribe('conversationEnded', () => render(null, lastFrame)), subscribe('selection', () => render(null, lastFrame))];
  return {
    update(S, frame) { render(S, frame); },
    unmount() { offs.forEach((o) => o()); container.innerHTML = ''; },
  };
}
