// Step 9.5: the inspector's "Life" panel — intentions (with fading weight), habits (window, place, strength, origin,
// change history), known deaths (how and when, certainty), grief (with its floor) and fear for one's own life.
// Director edits go through the API (intentions, habits, regenerate); everything else is read-only.
import { api, esc, gameTime, roomName } from '../util.js';
import { store } from '../store.js';

const SOURCE_ICON = { self: '•', promise: '🤝', need: '❗', habit_break: '↺', carried: '↪' };
const HOW = { witnessed: 'saw it happen', found: 'found the body', inferred: 'saw someone lying still' };
const name = (id) => store.citizens.get(id)?.name ?? id;

export function lifeHtml(c) {
  const now = store.clock?.gameMinutes ?? 0;
  const intents = (c.intentions ?? []).slice().sort((a, b) => b.weight - a.weight);
  const habits = (c.habits ?? []).slice().sort((a, b) => a.window[0].localeCompare(b.window[0]));
  const deaths = c.knownDeaths ?? [];
  const g = c.grief;
  const parts = [];
  if (c.mortal || c.mortality >= 3) {
    parts.push(`<div class="life-mortal ${esc(c.mortal?.state ?? '')}">☠ fears for ${c.persona?.sex === 'female' ? 'her' : c.persona?.sex === 'male' ? 'his' : 'their'} own life${c.mortal ? ` — body ${esc(c.mortal.state)}` : ''}${c.mortality ? ` · fear ${esc(c.mortality)}` : ''}</div>`);
  }
  if (g) {
    const floorLeft = g.data?.floorUntil ? Math.max(0, (g.data.floorUntil - now) / 1440) : 0;
    parts.push(`<div class="life-grief">🎗 grieving ${esc(name(g.target))} · ${Number(g.intensity).toFixed(1)}${floorLeft > 0 ? ` · can't fall below ${g.data.floor} for ${floorLeft.toFixed(1)} more days` : ''} · half-life ${Math.round((g.data?.halfLifeHours ?? 240) / 24)} days</div>`);
  }
  parts.push(`<h4>Intentions <span class="dim">(only the citizen acts on these)</span></h4>`);
  parts.push(intents.length ? `<ul class="life-list">${intents.map((i) => `<li title="${esc(i.source)} · since ${esc(gameTime(i.createdAt))}">
      <span class="src">${SOURCE_ICON[i.source] ?? '•'}</span> ${esc(i.text)}${i.aboutNames?.length ? ` <span class="dim">(${esc(i.aboutNames.join(', '))})</span>` : ''}${i.placeName ? ` <span class="dim">@ ${esc(i.placeName)}</span>` : ''}
      <span class="weight" title="weight ${i.weight}"><i style="width:${Math.round(i.weight * 100)}%"></i></span>
      <button class="link" data-intent-drop="${esc(i.id)}" title="director: drop">✕</button></li>`).join('')}</ul>` : '<p class="muted">Nothing they mean to do.</p>');
  parts.push(`<div class="row"><input class="intent-add" placeholder="director: add an intention…" style="flex:1"><button data-intent-add>add</button></div>`);
  parts.push(`<h4>Habits <button class="link" data-habits-regen>regenerate</button></h4>`);
  parts.push(habits.length ? `<ul class="life-list">${habits.map((h) => `<li title="${esc((h.history ?? []).map((x) => `${gameTime(x.at)} ${x.op}${x.why ? `: ${x.why}` : ''}`).join('\n'))}">
      <span class="mono">${esc(h.window.join('–'))}</span> ${esc(h.what)} <span class="dim">@ ${esc(placeWord(h.place))} · ${esc(h.action?.type)} · ${esc(h.origin)}</span>${h.due ? ' <span class="pill">due</span>' : ''}
      <span class="weight" title="strength ${h.strength}"><i style="width:${Math.round(h.strength * 100)}%"></i></span></li>`).join('')}</ul>` : '<p class="muted">No habits yet (they are generated soon after boot).</p>');
  parts.push(`<details><summary>edit habits (JSON)</summary><textarea class="habits-json" rows="8" style="width:100%">${esc(JSON.stringify(habits.map(({ what, doing, kind, window, place, action }) => ({ what, doing, kind, window, place, action })), null, 1))}</textarea><button data-habits-save>save habits</button></details>`);
  parts.push('<h4>Deaths they know of</h4>');
  parts.push(deaths.length ? `<ul class="life-list">${deaths.map((d) => `<li>${esc(d.name)} — ${esc(HOW[d.how] ?? (String(d.how).startsWith('told:') ? `told by ${name(d.how.slice(5))}` : d.how))}, ${esc(gameTime(d.learnedAt))}${d.where ? ` <span class="dim">(${esc(roomName(d.where))})</span>` : ''} <span class="pill">${esc(d.certainty)}</span>${d.grief ? ` <span class="dim">grief ${d.grief}</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted">None.</p>');
  const feared = Object.entries(c.fearedPlaces ?? {});
  if (feared.length) parts.push(`<div class="dim">Dreads: ${feared.map(([id, f]) => `${esc(roomName(id))} (${esc(f.why)})`).join('; ')}</div>`);
  return parts.join('\n');
}

function placeWord(p) {
  return { home: 'home', any_food: 'wherever there is food', any_bed: 'wherever there is a bed' }[p] ?? roomName(p);
}

/** Click and input handling for the panel; `reload` refreshes the inspector. */
export async function lifeClick(e, c, reload) {
  const drop = e.target.closest('[data-intent-drop]');
  if (drop) {
    const list = (c.intentions ?? []).filter((i) => i.id !== drop.dataset.intentDrop);
    await api.post('/api/director/intentions', { citizenId: c.id, intentions: list });
    return reload(), true;
  }
  if (e.target.closest('[data-intent-add]')) {
    const input = e.target.closest('.life-panel')?.querySelector('.intent-add');
    const text = input?.value.trim();
    if (!text) return true;
    await api.post('/api/director/intentions', { citizenId: c.id, intentions: [...(c.intentions ?? []), { text, source: 'self' }] });
    return reload(), true;
  }
  if (e.target.closest('[data-habits-regen]')) {
    e.target.textContent = 'regenerating…';
    await api.post('/api/director/habits/regenerate', { citizenId: c.id });
    return reload(), true;
  }
  if (e.target.closest('[data-habits-save]')) {
    const ta = e.target.closest('.life-panel')?.querySelector('.habits-json');
    let habits;
    try { habits = JSON.parse(ta.value); } catch { alert('Not valid JSON'); return true; }
    await api.post('/api/director/habits', { citizenId: c.id, habits });
    return reload(), true;
  }
  return false;
}
