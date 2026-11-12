// Objects (step 5) for the UI: pills for room cards, the object card (both texts, placement, who knows
// what, the history with actors and witnesses), and a small editor that PATCHes through objects.change().
import { store, emit } from '../store.js';
import { api, esc, gameTime, citizenName, roomName, who, showModal, closeModal } from '../util.js';

export const VIS_ICON = { obvious: '', noticeable: '◌', hidden: '◍' };

let types = null;
export async function objectTypes() {
  if (!types) types = await api.get('/api/object-types').catch(() => []);
  return types;
}

export function objectsIn(roomId) {
  return [...store.objects.values()].filter((o) => o.roomId === roomId);
}

export function carriedBy(citizenId) {
  return [...store.objects.values()].filter((o) => o.holderId === citizenId);
}

/** A small pill. tier: the visibility to draw (true view: effective visibility; surface: what this citizen gets). */
export function pillHtml(o, { tier = o.effectiveVisibility, title = null, count = 1, ids = null } = {}) {
  const hidden = tier === 'hidden';
  const t = title ?? `${o.label}${o.placementText ? ` — ${o.placementText}` : ''} · ${o.state} · ${o.visibility}${o.effectiveVisibility !== o.visibility ? ` (${o.effectiveVisibility} here)` : ''}${o.ownerId ? ` · ${citizenName(o.ownerId)}'s` : ''}`;
  const where = hidden && o.placement?.of ? ` <span class="ob-where">${esc(o.placement.relation)}: ${esc(store.objects.get(o.placement.of)?.typeName ?? o.placement.of)}</span>` : '';
  const broken = /broken|smashed|torn|wrecked|shattered/.test(o.state) ? ' broken' : '';
  return `<span class="ob-pill t-${esc(tier)}${broken}" data-object="${esc(ids?.[0] ?? o.id)}" title="${esc(t)}">${esc(o.typeName)}${count > 1 ? ` ×${count}` : ''}${where}</span>`;
}

/** Group identical pills (same type, state, tier, placement) to keep room cards small. */
export function pillsHtml(list, tierOf = (o) => o.effectiveVisibility) {
  const groups = new Map();
  for (const o of list) {
    const tier = tierOf(o);
    const key = `${o.typeId}|${o.state}|${tier}|${o.placement?.relation}:${o.placement?.of}|${o.ownerId}`;
    if (!groups.has(key)) groups.set(key, { o, tier, ids: [] });
    groups.get(key).ids.push(o.id);
  }
  return [...groups.values()].map((g) => pillHtml(g.o, { tier: g.tier, count: g.ids.length, ids: g.ids })).join('');
}

// ---------- the object card ----------
export async function openObject(id) {
  let o;
  try {
    o = await api.get(`/api/objects/${encodeURIComponent(id)}`);
  } catch (err) {
    showModal(`<div class="bad">${esc(err.message)}</div>`);
    return;
  }
  const t = (await objectTypes()).find((x) => x.id === o.typeId);
  const where = o.holderId ? `carried by ${who(o.holderId)}` : `${esc(roomName(o.roomId))}${o.placementText ? `, ${esc(o.placementText)}` : ''}`;
  const sig = (b) => (b?.holder ? `held by ${citizenName(b.holder)}` : b?.room ? `${roomName(b.room)}${b.placement?.of ? ` (${b.placement.relation} ${store.objects.get(b.placement.of)?.typeName ?? b.placement.of})` : ''}` : '—');
  const diff = (h) => {
    const b = h.before ?? {};
    const a = h.after ?? {};
    const out = [];
    if (h.action === 'seed' || h.action === 'create') return `<span class="dim">${esc(sig(a))} · ${esc(a.state)} · ${esc(a.visibility)}</span>`;
    if (sig(b) !== sig(a)) out.push(`${esc(sig(b))} → <b>${esc(sig(a))}</b>`);
    if (b.state !== a.state) out.push(`${esc(b.state)} → <b>${esc(a.state)}</b>`);
    if (b.visibility !== a.visibility) out.push(`${esc(b.visibility)} → <b>${esc(a.visibility)}</b>`);
    return out.join(' · ') || '<span class="dim">(texts / data)</span>';
  };
  const history = o.history.map((h) => `<tr>
      <td class="dim">${esc(gameTime(h.game_time))}</td>
      <td>${h.actor_id && store.citizens.has(h.actor_id) ? who(h.actor_id) : `<span class="dim">${esc(h.actor_id ?? '')}</span>`}</td>
      <td><span class="ob-act">${esc(h.action)}</span></td>
      <td>${diff(h)}</td>
      <td>${['seed', 'create', 'edit'].includes(h.action) ? '' : h.witnesses.length ? h.witnesses.map((w) => who(w)).join(', ') : '<span class="bad">unseen</span>'}</td>
    </tr>`).join('');
  const knownBy = o.knownBy.map((k) => {
    const b = k.believed;
    const wrong = (b.holderId ?? null) !== (o.holderId ?? null) || (b.roomId ?? null) !== (o.roomId ?? null) || b.state !== o.state;
    const thinks = b.holderId ? `held by ${citizenName(b.holderId)}` : `${roomName(b.roomId)}${b.placementSig && b.placementSig !== 'floor' ? ` (${b.placementSig.replace(':', ' ')})` : ''}`;
    return `<div class="${wrong ? 'mismatch' : ''}">${who(k.id)} <span class="dim">thinks:</span> ${esc(thinks)}, ${esc(b.state)} <span class="dim">(seen ${esc(gameTime(b.lastSeenAt))})</span>${wrong ? ' <span class="bad">≠ reality</span>' : ''}</div>`;
  }).join('') || '<span class="dim">nobody</span>';

  showModal(`
    <div class="modal-head"><span class="t">${esc(o.label)}</span> <span class="type">${esc(o.id)} · ${esc(o.typeName)} · ${esc(o.alias)}</span></div>
    <div class="ob-grid">
      <div><span class="dim">where</span> ${where}</div>
      <div><span class="dim">state</span> <b>${esc(o.state)}</b></div>
      <div><span class="dim">visibility</span> ${esc(o.visibility)}${o.effectiveVisibility !== o.visibility ? ` <span class="dim">(effectively ${esc(o.effectiveVisibility)})</span>` : ''}${o.visibility === 'hidden' || o.effectiveVisibility === 'hidden' ? ` · difficulty ${esc(o.searchDifficulty)}` : ''}</div>
      <div><span class="dim">owner</span> ${o.ownerId ? who(o.ownerId) : '—'} · <span class="dim">origin</span> ${esc(o.origin)}</div>
      <div class="wide"><span class="dim">surface</span> “${esc(o.surface)}”</div>
      <div class="wide"><span class="dim">true</span> ${o.trueText ? `“${esc(o.trueText)}”` : '<span class="dim">(none: examine shows the surface + state)</span>'}</div>
    </div>
    <h4>Who thinks it is where</h4><div class="ob-known">${knownBy}</div>
    <h4>History</h4>
    <table class="ob-hist"><tr><th>when</th><th>who</th><th>what</th><th>change</th><th>witnesses</th></tr>${history}</table>
    <details class="ob-edit"><summary>Edit (director)</summary>${editorHtml(o, t)}</details>`);
  const form = document.querySelector('.modal #ob-edit-form');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveEdit(o, form);
  });
  document.querySelector('.modal #ob-reset')?.addEventListener('click', async () => {
    try {
      await api.post('/api/director/objects/reset', { objectId: o.id });
      openObject(o.id);
    } catch (err) {
      form.querySelector('.result').textContent = err.message;
    }
  });
}

function editorHtml(o, t) {
  const rooms = [...store.rooms.values()];
  const people = [...store.citizens.values()];
  const anchors = (roomId) => objectsIn(roomId).filter((x) => x.id !== o.id);
  const opt = (v, label, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;
  return `<form id="ob-edit-form" class="ob-form">
    <label>State <select name="state">${(t?.states ?? [o.state]).map((s) => opt(s, s, s === o.state)).join('')}</select></label>
    <label>Visibility <select name="visibility">${['obvious', 'noticeable', 'hidden'].map((v) => opt(v, v, v === o.visibility)).join('')}</select></label>
    <label>Difficulty <input name="searchDifficulty" type="number" min="0" max="10" value="${esc(o.searchDifficulty)}"></label>
    <label>Owner <select name="ownerId">${opt('', '— nobody —', !o.ownerId)}${people.map((c) => opt(c.id, c.name, c.id === o.ownerId)).join('')}</select></label>
    <label>Where <select name="where">${rooms.map((r) => opt(`room:${r.id}`, r.name, r.id === o.roomId)).join('')}${people.map((c) => opt(`holder:${c.id}`, `held by ${c.name}`, c.id === o.holderId)).join('')}</select></label>
    <label>Placement <select name="relation">${['floor', 'on', 'in', 'behind', 'under', 'beside'].map((r) => opt(r, r, r === (o.placement?.relation ?? 'floor'))).join('')}</select>
      <select name="of">${opt('', '—', !o.placement?.of)}${anchors(o.roomId).map((a) => opt(a.id, `${a.typeName} (${a.id})`, a.id === o.placement?.of)).join('')}</select></label>
    <label class="wide">Surface text <input name="surfaceText" value="${esc(o.surfaceText ?? '')}" placeholder="(type template)"></label>
    <label class="wide">True text <input name="trueText" value="${esc(o.trueText ?? '')}"></label>
    <label class="wide">Tell witnesses <input name="notify" placeholder="optional: what people in the room perceive"></label>
    <div class="row wide"><button type="button" id="ob-reset">Reset to content</button><button type="submit">Save</button></div>
    <div class="result wide"></div>
  </form>`;
}

async function saveEdit(o, form) {
  const f = Object.fromEntries(new FormData(form).entries());
  const body = {};
  if (f.state !== o.state) body.state = f.state;
  if (f.visibility !== o.visibility) body.visibility = f.visibility;
  if (Number(f.searchDifficulty) !== o.searchDifficulty) body.searchDifficulty = Number(f.searchDifficulty);
  if ((f.ownerId || null) !== (o.ownerId ?? null)) body.ownerId = f.ownerId || null;
  if ((f.surfaceText || null) !== (o.surfaceText ?? null)) body.surfaceText = f.surfaceText || null;
  if ((f.trueText || null) !== (o.trueText ?? null)) body.trueText = f.trueText || null;
  const [kind, id] = f.where.split(':');
  const placement = { relation: f.relation, of: f.of || null };
  if (kind === 'holder' && id !== o.holderId) body.holderId = id;
  else if (kind === 'room' && (id !== o.roomId || placement.relation !== (o.placement?.relation ?? 'floor') || placement.of !== (o.placement?.of ?? null))) {
    body.roomId = id;
    body.placement = id === o.roomId ? placement : { relation: 'floor' };
  }
  if (f.notify) body.notify = f.notify;
  const res = form.querySelector('.result');
  if (!Object.keys(body).length) {
    res.textContent = 'Nothing changed.';
    return;
  }
  try {
    await api.patch(`/api/director/objects/${encodeURIComponent(o.id)}`, body);
    openObject(o.id);
  } catch (err) {
    res.className = 'result bad wide';
    res.textContent = err.message;
  }
}

/** Live updates: keep store.objects in sync from SSE 'object' messages. */
export function onObjectMessage(o) {
  store.objects.set(o.id, o);
  emit('objects');
}

export { closeModal };
