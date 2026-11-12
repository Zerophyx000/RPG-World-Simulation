// Step 5.5 UI pieces shared by the inspector, the graph and the groups tab: reason timelines,
// wariness breakdowns, group chips.
import { store } from '../store.js';
import { api, esc, gameTime, who, citizenName, showModal } from '../util.js';

export const SOURCE_ICON = {
  reflection: '💬', witness: '👁', signal: '⚠', first_impression: '👋', group: '👥', director: '✨', seed: '🌱', consolidation: '🌙', emotion: '❤',
};
const KIND_ICON = { family: '👪', household: '🏠', village: '🏘', guild: '⚒', faction: '🚩', party: '🧭', gang: '🗡' };

const chip = (label, v) => (v ? `<span class="dchip ${v > 0 ? 'pos' : 'neg'}">${label} ${v > 0 ? '+' : ''}${Math.round(v * 100) / 100}</span>` : '');

/** One pair's reasons, newest first. Weak reasons are faint; evidence links open the conversation / event / object. */
export function reasonTimelineHtml(events) {
  if (!events?.length) return '<p class="muted">No reasons on record.</p>';
  return `<ul class="reasons">${events.map((e) => {
    const ev = e.evidence ?? {};
    const links = [
      ev.conversationId ? `<a class="link" data-open-conv="${esc(ev.conversationId)}">conversation</a>` : '',
      ...(ev.eventIds ?? []).map((id) => `<a class="link" data-show-event="${esc(id)}">event #${esc(id)}</a>`),
      ...(ev.objectIds ?? []).map((id) => `<span class="ob-name" data-object="${esc(id)}">${esc(store.objects.get(id)?.label ?? id)}</span>`),
      ev.groupId ? `<span class="dim">group ${esc(ev.groupId)}</span>` : '',
      ev.sign ? `<span class="dim">sign: ${esc(ev.sign)}</span>` : '',
    ].filter(Boolean).join(' · ');
    return `<li style="opacity:${Math.max(0.3, Math.min(1, 0.25 + e.strength))}" title="strength ${e.strength.toFixed(2)}${e.strength < 0.3 ? ' (faded: no longer cited)' : ''}">
      <span class="src" title="${esc(e.source)}">${SOURCE_ICON[e.source] ?? '·'}</span>
      <span class="dim">${esc(gameTime(e.gameTime))}</span>
      ${chip('trust', e.dTrust)}${chip('liking', e.dAffinity)}${chip('knows', e.dFamiliarity)}
      <div class="rtext">${esc(e.reason)}${e.strength < 0.3 ? ' <span class="dim">(faded)</span>' : ''}</div>
      ${links ? `<div class="rlinks">${links}</div>` : ''}</li>`;
  }).join('')}</ul>`;
}

export async function openReasons(citizenId, otherId) {
  let d;
  try {
    d = await api.get(`/api/citizens/${encodeURIComponent(citizenId)}/relationships/${encodeURIComponent(otherId)}/events`);
  } catch (err) {
    showModal(`<div class="bad">${esc(err.message)}</div>`);
    return;
  }
  const r = d.row;
  showModal(`
    <div class="modal-head"><span class="t">${who(citizenId)} → ${who(otherId)}</span> <span class="type">why they feel this way</span></div>
    ${r ? `<div class="dim">liking ${r.affinity.toFixed(1)} · trust ${r.trust.toFixed(1)} · familiarity ${r.familiarity.toFixed(1)}</div>` : ''}
    ${d.inPrompt ? `<div class="prompt-line"><span class="dim">in ${esc(citizenName(citizenId))}'s prompt:</span> ${esc(citizenName(otherId))}${esc(d.inPrompt.tags)}. ${esc(d.inPrompt.text)}</div>` : ''}
    <h4>Reasons</h4>${reasonTimelineHtml(d.events)}`);
}

/** Wariness contributions as a small signed bar list. */
export function warinessHtml(w) {
  const max = Math.max(1, ...w.parts.map((p) => Math.abs(p.weight)));
  return `<div class="wary"><div><b>${esc(w.name ?? '')}</b> <span class="dim">wariness</span> <b>${w.value}</b> <span class="dim">“${esc(w.phrase)}”</span></div>
    ${w.parts.filter((p) => Math.abs(p.weight) >= 0.05).map((p) => `<div class="wrow"><span class="wk">${esc(p.key.replace(/^(tag|obj|own|group):/, ''))}</span>
      <span class="wbar"><i class="${p.weight >= 0 ? 'pos' : 'neg'}" style="width:${Math.abs(p.weight) / max * 50}%;${p.weight >= 0 ? 'left:50%' : `right:50%`}"></i></span>
      <span class="wv">${p.weight > 0 ? '+' : ''}${p.weight}</span></div>`).join('')}</div>`;
}

export function groupChip(g) {
  return `<span class="gchip ${g.public === false ? 'secret' : ''}" title="${esc(g.kind)}${g.purpose ? `: ${g.purpose}` : ''}">${KIND_ICON[g.kind] ?? '👥'} ${esc(g.name)}${g.public === false || g.secret ? ' 🔒' : ''}${g.role && g.role !== 'member' ? ` <span class="dim">${esc(g.role)}</span>` : ''}</span>`;
}

export { KIND_ICON };
