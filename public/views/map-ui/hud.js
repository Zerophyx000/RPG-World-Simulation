// Step 9: the selected-citizen HUD: a compact card at the top-left of the map with who they are, what they are doing
// (and with what), where they stand, small bars for hunger, tiredness, vitality and blood, the feeling that shows,
// status chips (a red critical countdown), the latest inner thought in god view, and buttons: follow, through their
// eyes (subjective camera), inspector. Cheap: the card is only rewritten when its content changed.
import { esc, activityLabel } from '../../util.js';

/** Plain data for the card (also used by the checks). */
export function hudModel(c, store, { god = true } = {}) {
  if (!c) return null;
  const a = c.activity ?? {};
  const target = a.detail?.targetId ? store.objects?.get(a.detail.targetId) : null;
  const room = store.rooms?.get(c.location);
  const n = c.needs ?? {};
  const b = c.body ?? {};
  const pct = (v, max = 100) => Math.max(0, Math.min(1, (Number(v) || 0) / max));
  const dom = c.emotion?.dominant;
  return {
    id: c.id, name: c.name,
    activity: safeLabel(c), target: target ? (target.label ?? target.typeName ?? null) : null,
    where: `${c.spot ? `${c.spot} · ` : ''}${room?.name ?? c.location ?? 'on the road'}`,
    bars: { hunger: pct(n.hunger), fatigue: pct(n.fatigue), vitality: pct(b.vitality ?? n.hp ?? 100), blood: pct(b.blood ?? 100) },
    emotion: dom && dom.intensity >= 1 ? { type: dom.type, intensity: Math.round(dom.intensity) } : null,
    status: [...(b.status ?? [])],
    critical: b.critical != null ? Math.max(0, Math.round(b.critical)) : null,
    thought: god && c.lastInnerThought ? String(c.lastInnerThought).slice(0, 140) + (String(c.lastInnerThought).length > 140 ? '…' : '') : null,
    dead: c.alive === false,
  };
}
function safeLabel(c) { try { return activityLabel(c); } catch { return c.activity?.type ?? ''; } }

const CSS = `
.hud-card { position: absolute; left: 10px; top: 10px; width: 280px; background: #14171df2; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 12px; box-shadow: 0 4px 18px #0008; }
.hud-card .hud-name { font-weight: 700; font-size: 14px; }
.hud-card .hud-dim { color: var(--muted); }
.hud-bars { display: grid; grid-template-columns: auto 1fr; gap: 2px 6px; align-items: center; margin: 5px 0; font-size: 11px; color: var(--muted); }
.hud-bar { height: 5px; background: #262a32; border-radius: 3px; overflow: hidden; }
.hud-bar i { display: block; height: 100%; }
.hud-chips span { display: inline-block; padding: 0 6px; margin: 2px 3px 0 0; border-radius: 8px; background: #262a32; font-size: 11px; }
.hud-chips .crit { background: #5a1d1d; color: #ffb4a8; }
.hud-thought { color: #9fb0d8; font-style: italic; margin-top: 4px; }
.hud-btns { display: flex; gap: 4px; margin-top: 6px; }
.hud-btns button { font-size: 11px; padding: 2px 8px; }
.hud-btns button.on { border-color: var(--accent); color: var(--accent); }
`;
const injectCss = () => { if (typeof document === 'undefined' || document.getElementById('css-hud')) return; const s = document.createElement('style'); s.id = 'css-hud'; s.textContent = CSS; document.head.append(s); };

export function mount(container, api) {
  injectCss();
  const card = document.createElement('div');
  card.className = 'hud-card';
  card.style.display = 'none';
  container.append(card);
  let key = '';
  card.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const id = api.store.selectedId; if (!id) return;
    if (b.dataset.a === 'follow') api.follow(api.isFollowing() ? null : id);
    else if (b.dataset.a === 'eyes') api.setSubjective(!api.isSubjective());
    else if (b.dataset.a === 'inspect') { api.select(null); api.select(id); }
    key = '';
  });
  const bar = (label, v, color) => `<span>${label}</span><span class="hud-bar"><i style="width:${Math.round(v * 100)}%;background:${color}"></i></span>`;
  return {
    update() {
      const c = api.store.selectedId ? api.store.citizens.get(api.store.selectedId) : null;
      const m = hudModel(c, api.store, { god: api.isGod() });
      const k = m ? JSON.stringify([m, api.isFollowing(), api.isSubjective()]) : '';
      if (k === key) return;
      key = k;
      if (!m) { card.style.display = 'none'; return; }
      card.style.display = '';
      card.innerHTML = `<div class="hud-name" style="color:${api.colorOf(m.id)}">${esc(m.name)}${m.dead ? ' <span class="hud-dim">(dead)</span>' : ''}</div>
        <div>${esc(m.activity)}${m.target ? ` <span class="hud-dim">· ${esc(m.target)}</span>` : ''}</div>
        <div class="hud-dim">${esc(m.where)}</div>
        <div class="hud-bars">${bar('hunger', m.bars.hunger, '#d9a441')}${bar('tired', m.bars.fatigue, '#8a8fd0')}${bar('vitality', m.bars.vitality, '#5fb37b')}${bar('blood', m.bars.blood, '#c0392b')}</div>
        <div class="hud-chips">${m.emotion ? `<span>${esc(m.emotion.type)} ${m.emotion.intensity}</span>` : ''}${m.status.map((s) => `<span>${esc(s)}</span>`).join('')}${m.critical != null ? `<span class="crit">critical: ${m.critical} min</span>` : ''}</div>
        ${m.thought ? `<div class="hud-thought">${esc(m.thought)}</div>` : ''}
        <div class="hud-btns"><button data-a="follow" class="${api.isFollowing() ? 'on' : ''}" title="F">follow</button><button data-a="eyes" class="${api.isSubjective() ? 'on' : ''}" title="S">their eyes</button><button data-a="inspect">inspector</button></div>`;
    },
    unmount() { card.remove(); },
  };
}
