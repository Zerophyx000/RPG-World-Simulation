// Memory views for the inspector: constellation (SVG), core memory with history diff, relationships,
// and nights (consolidations). (Step 9.5: plans are gone; intentions and habits live in life-ui.js.)
import { store } from '../store.js';
import { esc, citizenName, roomName, gameTime } from '../util.js';
import { SOURCE_ICON } from './social-ui.js';
import { colorOf } from '../colors.js';

export const memState = { showForgotten: false, todayOnly: false, person: null, pinned: null, coreHistory: false };

// ---------- time labels (same bands as the citizens get) ----------
export function timeLabel(now, t) {
  const age = now - t;
  const dayNow = Math.floor(now / 1440);
  const dayThen = Math.floor(t / 1440);
  if (age < 120) return age < 20 ? 'just now' : 'earlier today';
  if (dayNow === dayThen) {
    const h = (((t % 1440) + 1440) % 1440) / 60;
    return h < 12 ? 'this morning' : h < 18 ? 'this afternoon' : 'this evening';
  }
  const days = dayNow - dayThen;
  if (days === 1) return 'yesterday';
  if (days <= 6) return 'a few days ago';
  if (days <= 21) return 'a week or two ago';
  return 'a long time ago';
}

// ---------- constellation ----------
const W = 400;
const H = 230;

function star(cx, cy, r) {
  const p = [];
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i - Math.PI / 2;
    const rr = i % 2 === 0 ? r * 1.6 : r * 0.55;
    p.push(`${(cx + Math.cos(a) * rr).toFixed(1)},${(cy + Math.sin(a) * rr).toFixed(1)}`);
  }
  return `M${p.join('L')}Z`;
}

/** Memories as dots along a time arc: oldest left, now right; size = importance, opacity = strength. */
export function constellationHtml(mem) {
  if (!mem) return '<p class="muted">Loading memories…</p>';
  const now = mem.now;
  const onMind = new Set((mem.onMyMind ?? []).map((m) => m.memoryId).filter(Boolean));
  let list = mem.memories.filter((m) => memState.showForgotten || m.status !== 'forgotten');
  if (memState.todayOnly) list = list.filter((m) => Math.floor(m.gameTime / 1440) === Math.floor(now / 1440));
  if (memState.person) list = list.filter((m) => m.about.includes(memState.person));
  const maxAge = Math.max(1440, ...list.map((m) => now - m.gameTime));
  const pos = new Map();
  for (const m of list) {
    const age = Math.max(0, now - m.gameTime);
    const t = 1 - Math.log1p(age) / Math.log1p(maxAge);            // 0 = oldest … 1 = now
    const x = 16 + t * (W - 32);
    const arc = H * 0.78 - Math.sin(Math.PI * t) * H * 0.28;        // gentle arc
    const jitter = ((m.id * 37) % 17) - 8;
    const y = Math.max(14, Math.min(H - 10, arc - m.importance * 9 + jitter));
    pos.set(m.id, { x, y });
  }
  const out = ['<defs><filter id="gist-blur"><feGaussianBlur stdDeviation="1.6"/></filter></defs>'];
  out.push(`<path d="M16,${H * 0.78} Q${W / 2},${H * 0.78 - H * 0.56} ${W - 16},${H * 0.78}" class="arc"/>`);
  out.push(`<text class="axis" x="16" y="${H - 2}">long ago</text><text class="axis" x="${W - 16}" y="${H - 2}" text-anchor="end">now</text>`);
  // merged → consolidated links
  for (const m of mem.memories) {
    if (m.status !== 'merged' || !m.mergedInto || !pos.has(m.id) || !pos.has(m.mergedInto)) continue;
    const a = pos.get(m.id);
    const b = pos.get(m.mergedInto);
    out.push(`<line class="merge-link" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`);
  }
  for (const m of list) {
    const { x, y } = pos.get(m.id);
    const r = 2 + m.importance * 0.85;
    const fill = m.about[0] && store.citizens.has(m.about[0]) ? colorOf(m.about[0]) : '#9aa3b0';
    const op = m.status === 'forgotten' ? 0.12 : 0.18 + 0.82 * m.strength;
    const cls = ['mdot', onMind.has(m.id) ? 'on-mind' : '', m.id === memState.pinned ? 'pinned' : '', m.status].join(' ');
    const dash = m.kind === 'secondhand' ? 'stroke-dasharray="2 2"' : '';
    const filt = m.isGist ? 'filter="url(#gist-blur)"' : '';
    const title = `<title>${esc(`(${timeLabel(now, m.gameTime)}) ${m.text}\n${m.kind}${m.isGist ? ' · gist' : ''}${m.status !== 'active' ? ` · ${m.status}` : ''} · importance ${m.importance} · strength ${m.strength.toFixed(2)}`)}</title>`;
    const shape = m.kind === 'consolidated'
      ? `<path d="${star(x, y, r)}" fill="${fill}" fill-opacity="${op}" stroke="${fill}" ${filt}/>`
      : `${m.valence ? `<circle cx="${x}" cy="${y}" r="${r + 3.5}" fill="none" stroke="${m.valence < 0 ? '#e0584a' : '#e8c547'}" stroke-width="${1 + Math.abs(m.valence) * 2.5}" stroke-opacity="${0.25 + Math.abs(m.valence) * 0.5}"><title>${esc(m.emotion ?? '')}</title></circle>` : ''}<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" fill-opacity="${op}" stroke="${fill}" stroke-opacity="${Math.min(1, op + 0.2)}" ${dash} ${filt}/>`;
    out.push(`<g class="${cls}" data-mem="${m.id}">${title}${shape}</g>`);
  }
  // legend: people (click to filter)
  const people = [...new Set(mem.memories.flatMap((m) => m.about))].filter((id) => store.citizens.has(id));
  const legend = people.map((id) => `<button class="leg ${memState.person === id ? 'on' : ''}" data-mem-person="${esc(id)}"><i style="background:${colorOf(id)}"></i>${esc(citizenName(id))}</button>`).join('');
  const pinned = memState.pinned ? mem.memories.find((m) => m.id === memState.pinned) : null;
  const card = pinned ? `<div class="mem-card">
      <div class="dim">${esc(timeLabel(now, pinned.gameTime))} · ${esc(gameTime(pinned.gameTime))} · ${esc(pinned.kind)}${pinned.isGist ? ' (gist)' : ''} · importance ${pinned.importance} · strength ${pinned.strength.toFixed(2)} · ${esc(pinned.status)}</div>
      <div class="mem-text">${esc(pinned.text)}</div>
      ${pinned.about.length ? `<div class="dim">about: ${pinned.about.map((id) => esc(citizenName(id))).join(', ')}${pinned.placeId ? ` · at ${esc(roomName(pinned.placeId))}` : ''}</div>` : ''}
      <div class="row">
        ${pinned.source?.conversationId ? `<button class="link" data-open-conv="${esc(pinned.source.conversationId)}">open the conversation</button>` : ''}
        ${pinned.source?.eventId ? `<button class="link" data-show-event="${pinned.source.eventId}">open the event</button>` : ''}
        ${pinned.source?.toldBy ? `<span class="dim">told by ${esc(citizenName(pinned.source.toldBy))}</span>` : ''}
      </div></div>` : '';
  const counts = { active: 0, merged: 0, forgotten: 0 };
  for (const m of mem.memories) counts[m.status] = (counts[m.status] ?? 0) + 1;
  return `<div class="mem-tools">
      <label class="check"><input type="checkbox" data-mem-toggle="todayOnly" ${memState.todayOnly ? 'checked' : ''}> today only</label>
      <label class="check"><input type="checkbox" data-mem-toggle="showForgotten" ${memState.showForgotten ? 'checked' : ''}> show forgotten</label>
      <span class="dim">${counts.active} active · ${counts.merged} merged · ${counts.forgotten} forgotten</span>
    </div>
    <svg class="constellation" viewBox="0 0 ${W} ${H}">${out.join('')}</svg>
    <div class="mem-legend">${legend}<span class="dim">★ consolidated · ◌ dashed = told by someone · blurred = gist · pulsing = on their mind</span></div>
    ${card}`;
}

// ---------- core memory + history ----------
export function coreMemoryHtml(mem, nights) {
  const core = mem?.coreMemory;
  const hist = (nights ?? []).filter((n) => n.newCore);
  let history = '';
  if (memState.coreHistory && hist.length) {
    history = hist.map((n) => `<div class="core-diff"><div class="dim">night of ${esc(gameTime(n.gameTime))}</div>${diffSentences(n.oldCore ?? '', n.newCore)}</div>`).join('');
  }
  return `<blockquote class="core">${core ? esc(core) : '<span class="dim">No core memory yet: it is written at the first night\'s consolidation (or by bootstrap).</span>'}</blockquote>
    ${hist.length ? `<button class="link" data-core-history>${memState.coreHistory ? 'hide' : 'show'} history (${hist.length})</button>${history}` : ''}`;
}

function sentences(s) {
  return String(s ?? '').split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
}

/** Sentence-level diff: removed sentences struck through in red, added ones in green. */
export function diffSentences(oldText, newText) {
  const a = sentences(oldText);
  const b = sentences(newText);
  const aset = new Set(a);
  const bset = new Set(b);
  const removed = a.filter((s) => !bset.has(s)).map((s) => `<del>${esc(s)}</del>`);
  const kept = b.map((s) => (aset.has(s) ? `<span>${esc(s)}</span>` : `<ins>${esc(s)}</ins>`));
  return `<p class="diff">${[...kept, ...removed].join(' ')}</p>`;
}

// ---------- nights ----------
export function nightsHtml(nights) {
  if (!nights?.length) return '<p class="muted">No nights yet.</p>';
  return nights.map((n) => `<div class="night">
    <div class="night-head"><b>Night of ${esc(gameTime(n.gameTime))}</b>
      <span class="dim">${n.lasting?.length ?? 0} lasting · ${n.merged?.length ?? 0} merged · ${n.faded?.length ?? 0} faded · ${n.gists?.length ?? 0} gists</span></div>
    ${(n.lasting ?? []).map((l) => `<div class="night-line">★ ${esc(l.text)}</div>`).join('')}
    ${(n.gists ?? []).map((g) => `<div class="night-line dim">≈ ${esc(g.text)} <del>${esc(g.old ?? '')}</del></div>`).join('')}
    ${(n.summaries ?? []).map((s) => `<div class="night-line">${esc(citizenName(s.person))}: <del>${esc(s.before ?? '')}</del> <ins>${esc(s.after)}</ins></div>`).join('')}
    ${n.newCore ? `<details><summary>core memory</summary>${diffSentences(n.oldCore ?? '', n.newCore)}</details>` : ''}
  </div>`).join('');
}

// ---------- relationships ----------
function bar(v, min, max, cls) {
  const pct = ((v - min) / (max - min)) * 100;
  const zero = ((0 - min) / (max - min)) * 100;
  const left = Math.min(pct, zero);
  const width = Math.abs(pct - zero) || 1;
  return `<span class="rbar ${cls}" title="${cls} ${Math.round(v * 10) / 10}"><i style="left:${min < 0 ? left : 0}%;width:${min < 0 ? width : pct}%"></i>${min < 0 ? `<b style="left:${zero}%"></b>` : ''}</span>`;
}

export function relationshipsHtml(c, now) {
  const list = (c.relationshipsView ?? []).slice().sort((a, b) => b.familiarity - a.familiarity);
  if (!list.length) return '<p class="muted">Knows nobody yet.</p>';
  return `<ul class="rels">${list.map((r) => {
    const forgot = !r.nameKnown || r.nameConfidence < 0.2;
    const label = forgot ? `? <span class="dim">${esc(String(r.appearance ?? '').split(/[,.]/)[0])}</span>${r.nameKnown ? ' <span class="dim">(forgot the name)</span>' : ''}` : esc(r.name);
    return `<li>
      <div class="rel-top"><span class="cdot" style="background:${colorOf(r.otherId)}"></span><b data-citizen="${esc(r.otherId)}">${label}</b>
        <span class="namecf" style="opacity:${0.25 + 0.75 * r.nameConfidence}" title="name confidence ${r.nameConfidence.toFixed(2)}">✎</span>
        <span class="dim">${r.lastSeenAt != null ? `seen ${esc(timeLabel(now, r.lastSeenAt))}${r.lastSeenPlaceName ? ` at ${esc(r.lastSeenPlaceName)}` : ''}` : ''}</span></div>
      <div class="rel-bars">${bar(r.affinity, -5, 5, 'affinity')}${bar(r.trust, -5, 5, 'trust')}${bar(r.familiarity, 0, 10, 'familiarity')}</div>
      ${r.summary ? `<div class="rel-sum">“${esc(r.summary)}”</div>` : ''}
      ${(r.tags ?? []).length ? `<div class="dim rel-tags">(${esc(r.tags.join('; '))})</div>` : ''}
      ${(r.reasons ?? []).map((x) => `<div class="rel-reason" style="opacity:${Math.max(0.45, Math.min(1, 0.3 + x.strength))}">${SOURCE_ICON[x.source] ?? '·'} ${esc(x.reason)}</div>`).join('')}
      <button class="link" data-reasons="${esc(r.otherId)}">all reasons…</button>
    </li>`;
  }).join('')}</ul>`;
}

