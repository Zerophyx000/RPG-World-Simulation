// Step 11: the inspector's Ambitions, Schemes and Stories sections (director view: secrets and truths included).
import { esc, gameTime } from '../util.js';
import { store } from '../store.js';

const name = (id) => store.citizens.get(id)?.name ?? id;

export function schemingSummary(s) {
  if (!s) return '';
  const bits = [`honesty ${s.traits.honesty} · cunning ${s.traits.cunning}`];
  const act = s.ambitions.filter((a) => a.status === 'active');
  if (act.length) bits.push(`${act.length} ambition${act.length === 1 ? '' : 's'}`);
  const live = s.schemes.filter((x) => ['planning', 'active', 'paused'].includes(x.status));
  if (live.length) bits.push(`${live.length} scheme${live.length === 1 ? '' : 's'}`);
  const standing = s.stories.filter((l) => l.status === 'standing');
  if (standing.length) bits.push(`${standing.length} standing lie${standing.length === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

export function schemingHtml(s) {
  if (!s) return '<p class="muted">Nothing yet.</p>';
  const parts = [];
  parts.push(`<div class="dim">honesty ${s.traits.honesty}/10 · cunning ${s.traits.cunning}/10${s.traits.reason ? ` — ${esc(s.traits.reason)}` : ''}</div>`);
  parts.push('<h4>Ambitions</h4>');
  parts.push(s.ambitions.length ? `<ul class="life-list">${s.ambitions.map((a) => `<li title="${esc((a.data.history ?? []).map((h) => `${gameTime(h.at)} ${h.op}${h.why ? `: ${h.why}` : ''}`).join('\n'))}">${esc(a.text)} <span class="dim">(${esc(a.kind)}, ${a.intensity}/10, ${esc(a.secrecy)}${a.status !== 'active' ? `, ${esc(a.status)}` : ''})</span></li>`).join('')}</ul>` : '<p class="muted">None yet.</p>');
  parts.push('<h4>Schemes</h4>');
  parts.push(s.schemes.length ? `<ul class="life-list">${s.schemes.map((x) => {
    const mine = x.ownerId === s.id || x.ownerName === store.citizens.get(store.selectedId)?.name;
    const due = x.steps.find((st) => st.status === 'pending' && st.dueSince != null);
    return `<li>${mine ? '' : `<span class="dim">in on ${esc(name(x.ownerId))}'s:</span> `}${esc(x.goal)} <span class="dim">(${esc(x.status)}, ${x.steps.filter((st) => st.status === 'done').length}/${x.steps.length} steps${due ? `, due: ${esc(due.text)}` : ''}${x.exposedTo.length ? `, known to ${esc(x.exposedNames.join(', '))}` : ''})</span></li>`;
  }).join('')}</ul>` : '<p class="muted">None.</p>');
  if ((s.proposals ?? []).length) parts.push(`<div class="dim">Asked to join: ${s.proposals.map((p) => `${esc(name(p.from))}'s plan (${esc(p.ask)})`).join('; ')}</div>`);
  parts.push('<h4>Stories (lies they told)</h4>');
  parts.push(s.stories.length ? `<ul class="life-list">${s.stories.map((l) => `<li>“${esc(l.said)}” <span class="dim">— truth: ${esc(l.truth)} · ${esc(l.kind)} · ${esc(l.status)} · told ${esc(l.heardBy.map((h) => `${h.name} (${h.verdict})`).join(', ') || 'nobody')}</span></li>`).join('')}</ul>` : '<p class="muted">None.</p>');
  const heard = (s.heard ?? []).filter((l) => l.liarId !== s.id);
  if (heard.length) parts.push(`<h4>Lies they've been told</h4><ul class="life-list">${heard.map((l) => { const h = l.heardBy.find((x) => x.citizen_id === store.selectedId); return `<li>${esc(l.liarName)}: “${esc(l.said)}” <span class="dim">(${esc(h?.how ?? '')}, ${esc(h?.verdict ?? '')})</span></li>`; }).join('')}</ul>`);
  return parts.join('\n');
}
