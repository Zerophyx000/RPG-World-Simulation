// Step 10: the inspector's "Physical" panel — WHAT YOU'VE DONE (their deeds, as their prompt words them), the intent
// they hold toward each person, being held / pinned / tied / choking, the fight they're in, carried weapons with their
// profiles, and the combat profile itself (the numbers the contests use; later steps fill them from stats and gear).
import { esc, gameTime } from '../util.js';
import { store } from '../store.js';

const name = (id) => store.citizens.get(id)?.name ?? id;
const INTENT = { scare: 'to scare', subdue: 'to subdue', hurt: 'to hurt', kill: 'to kill', defend: 'defending', care: 'caring' };

export function physicalSummary(p) {
  if (!p) return '';
  const bits = [];
  if ((p.deeds ?? []).length) bits.push(`${p.deeds.length} deed${p.deeds.length === 1 ? '' : 's'}`);
  if (p.phys?.restraint) bits.push(p.phys.restraint.kind);
  if (p.phys?.prone) bits.push('on the floor');
  if ((p.weapons ?? []).some((w) => !w.profile.improvised)) bits.push('armed');
  if (p.dark) bits.push('in the dark');
  return bits.join(' · ');
}

export function physicalHtml(p) {
  if (!p) return '<p class="muted">No physical data.</p>';
  const parts = [];
  const ph = p.phys ?? {};
  const now = store.clock?.gameMinutes ?? 0;
  const state = [];
  if (ph.restraint) state.push(`${ph.restraint.kind}${ph.restraint.by ? ` by ${name(ph.restraint.by)}` : ''}`);
  if (ph.prone) state.push('on the floor');
  if ((ph.asphyxia ?? 0) > 0) state.push(`choking ${ph.asphyxia}${ph.chokedBy ? ` (${name(ph.chokedBy)})` : ''}`);
  if ((ph.smoke ?? 0) > 0) state.push(`smoke ${ph.smoke}`);
  if ((ph.dazedUntil ?? 0) > now) state.push('dazed');
  if ((ph.windedUntil ?? 0) > now) state.push('winded');
  if (ph.holding) state.push(`holding ${name(ph.holding)}`);
  if (state.length) parts.push(`<div class="phys-state">${esc(state.join(' · '))}</div>`);
  parts.push('<h4>What they have done</h4>');
  parts.push((p.deeds ?? []).length ? `<ul class="life-list">${p.deeds.map((d) => `<li title="${esc(`until ${gameTime(d.until)}${d.crimes?.length ? ` · crimes: ${d.crimes.join(', ')}` : ''}`)}">${esc(d.text.replace(/^- /, ''))}${d.serious ? ' <span class="pill">serious</span>' : ''}</li>`).join('')}</ul>` : '<p class="muted">Nothing.</p>');
  const intents = Object.entries(p.intents ?? {});
  if (intents.length) parts.push(`<h4>Intent toward</h4><ul class="life-list">${intents.map(([id, i]) => `<li>${esc(name(id))}: ${esc(INTENT[i.intent] ?? i.intent)}${i.inferred ? ' <span class="dim">(inferred)</span>' : ''} <span class="dim">since ${esc(gameTime(i.at))}${i.endedAt ? ', fight over' : ''}</span></li>`).join('')}</ul>`);
  const wary = Object.entries(p.wary ?? {});
  if (wary.length) parts.push(`<div class="dim">Wary of: ${wary.map(([id, w]) => `${esc(name(id))} (${esc(w.why)})`).join('; ')}</div>`);
  if (p.discovery) parts.push(`<div class="life-mortal">fears being found out (${esc(name(p.discovery.deadId))})</div>`);
  parts.push('<h4>Carried</h4>');
  parts.push((p.weapons ?? []).length ? `<ul class="life-list">${p.weapons.map((w) => `<li>${esc(w.name)} <span class="dim">${esc(w.profile.damage.map((d) => `${d.type} ${d.base}`).join(', '))} · reach ${esc(w.profile.reach)} · quality ${w.profile.quality}${w.props.durability != null ? ` · durability ${w.props.durability}/${w.props.maxDurability}` : ''}${w.profile.improvised ? ' · improvised' : ''}</span></li>`).join('')}</ul>` : '<p class="muted">Empty hands.</p>');
  const pr = p.profile ?? {};
  parts.push(`<h4>Combat profile <span class="dim">(provisional: body, build, practice, feelings)</span></h4><div class="mono">${['force', 'precision', 'evasion', 'toughness', 'grip', 'speed', 'composure'].map((k) => `${k} ${pr[k]}`).join(' · ')} · reach ${esc(pr.reach ?? 'same')}${p.dark ? ' · dark here' : ''}</div>`);
  return parts.join('\n');
}
