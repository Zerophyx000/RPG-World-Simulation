// Shared helpers: API, escaping, time formatting, names in color, readable event sentences, event modal.
import { store, emit } from './store.js';
import { colorOf } from './colors.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export const api = {
  async get(path) {
    const res = await fetch(path);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? res.statusText);
    return json;
  },
  async post(path, body = {}) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? res.statusText);
    return json;
  },
  async patch(path, body = {}) {
    const res = await fetch(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? res.statusText);
    return json;
  },
};

// ---------- time ----------
export function gameTime(minutes) {
  if (minutes == null) return '';
  const day = Math.floor(minutes / 1440) + 1;
  const m = ((minutes % 1440) + 1440) % 1440;
  return `D${day} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
}

export function clockOnly(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
}

export function minutesLeft(activity) {
  if (!activity || activity.until == null || !store.clock) return null;
  return Math.max(0, activity.until - store.clock.gameMinutes);
}

// ---------- names ----------
/** Stored world texts may carry per-viewer name tokens {{c:id}}; the UI always shows real names. */
export const detok = (t) => String(t ?? '').replace(/\{\{[cp]:([\w-]+)\}\}/g, (_m, id) => store.citizens.get(id)?.name ?? id);

export const citizenName = (id) => store.citizens.get(id)?.name ?? id ?? '?';
export const roomName = (id) => (id ? store.rooms.get(id)?.name ?? id : 'on the way');

/** A citizen's name in their color (clickable: opens the inspector). */
export function who(id, { plain = false } = {}) {
  if (!id) return '<span class="dim">someone</span>';
  const name = esc(citizenName(id));
  return plain
    ? `<span class="who" style="color:${colorOf(id)}">${name}</span>`
    : `<span class="who" data-citizen="${esc(id)}" style="color:${colorOf(id)}">${name}</span>`;
}

export function dot(id) {
  return `<span class="cdot" style="background:${colorOf(id)}" title="${esc(citizenName(id))}"></span>`;
}

// ---------- activity ----------
export const ICONS = { idle: '·', thinking: '💭', talking: '🗣', moving: '🚶', waiting: '⏳', doing: '🔨', sleeping: '💤', collapsed: '⛔' };

export function activityLabel(c) {
  const a = c?.activity ?? { type: 'idle' };
  const d = a.detail ?? {};
  const left = minutesLeft(a);
  const rest = left != null ? ` · ${Math.ceil(left)} min left` : '';
  switch (a.type) {
    case 'doing': return `${d.description ?? 'busy'}${rest}`;
    case 'waiting': return `${d.reason ? `waiting: ${d.reason}` : 'waiting'}${rest}`;
    case 'moving': return `→ ${roomName(d.to)}${d.finalDest && d.finalDest !== d.to ? ` (to ${roomName(d.finalDest)})` : ''}${rest}`;
    case 'talking': {
      if (d.held) return 'talking (about to speak)';
      const conv = store.conversations.get(c.conversationId);
      const others = (conv?.participants ?? []).filter((id) => id !== c.id).map(citizenName);
      return others.length ? `talking with ${others.join(', ')}` : 'talking';
    }
    case 'thinking': return 'thinking…';
    case 'sleeping': return `${d.forced ? 'passed out' : 'sleeping'}${d.quality === 'rough' ? ' on the ground' : ' in a bed'}${d.hours ? rest : ''}`;
    case 'collapsed': return d.dead ? 'dead' : 'collapsed, unconscious';
    default: return 'idle';
  }
}

// Need badges: level >= 2 shows an icon, colored from yellow to red by level.
const NEED_ICONS = { hunger: '🍞', fatigue: '😴', hp: '❤️' };
const NEED_LEVEL_NAMES = {
  hunger: ['satisfied', 'peckish', 'hungry', 'starving', 'ravenous', 'dying of hunger'],
  fatigue: ['rested', 'sleepy', 'tired', 'exhausted', 'collapsing'],
  hp: ['healthy', 'hurting', 'weak', 'fading', 'dying'],
};
export function needLevel(c, kind) {
  return c?.needs?.levels?.[kind] ?? 0;
}
export function needBadges(c, { min = 2 } = {}) {
  const out = [];
  for (const k of ['hunger', 'fatigue', 'hp']) {
    const lvl = needLevel(c, k);
    if (k === 'hp' ? lvl < 1 : lvl < min) continue;
    const max = NEED_LEVEL_NAMES[k].length - 1;
    const sev = Math.min(1, lvl / max);
    out.push(`<span class="need-badge" style="--sev:${sev}" title="${esc(NEED_LEVEL_NAMES[k][lvl] ?? k)}">${NEED_ICONS[k]}</span>`);
  }
  return out.join('');
}
export function needLevelName(kind, lvl) {
  return NEED_LEVEL_NAMES[kind]?.[lvl] ?? '';
}

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ---------- event sentences ----------
const SPEECH_TOOLS = new Set(['say', 'leave_conversation', 'tell_about_place']);
const MOVE_TOOLS = new Set(['move_to', 'travel_to']);
const BODY_TOOLS = new Set(['eat', 'sleep', 'feed']);
const OBJECT_TOOLS = new Set(['take', 'put', 'give', 'examine', 'search', 'use']);
export const EVENT_CATEGORY = {
  action: (e) => (SPEECH_TOOLS.has(e.data?.tool) ? 'speech' : MOVE_TOOLS.has(e.data?.tool) ? 'movement' : BODY_TOOLS.has(e.data?.tool) ? 'body' : OBJECT_TOOLS.has(e.data?.tool) ? 'object' : 'action'),
  object: () => 'object',
  search: () => 'object',
  examine: () => 'object',
  keeper: () => 'object',
  notice: () => 'object',
  emotion: () => 'emotion',
  feeling: () => 'emotion',
  relationship: () => 'social',
  signal: () => 'social',
  group: () => 'social',
  arrive: () => 'movement',
  conversation_end: () => 'speech',
  director: (e) => (String(e.data?.action ?? '').startsWith('clock.') ? 'system' : 'director'),
  director_effect: () => 'director',
  damage: () => 'director',
  interrupt: () => 'interrupt',
  rethink_stale: () => 'interrupt',
  action_stale: () => 'interrupt',
  activity: () => 'activity',
  position: () => 'activity', // step 9: position changes (for map replay) sit with the raw activity events
  body: () => 'body',
  meal: () => 'body',
  wake: () => 'body',
  collapse: () => 'body',
  forced_sleep: () => 'body',
  revive: () => 'body',
  death: () => 'body',
  learn_place: () => 'speech',
  plan: () => 'memory',
  // step 9.5
  learned_death: () => 'social', news: () => 'speech', gathering: () => 'social', burial: () => 'social', tend_body: () => 'action', vigil: () => 'action',
  // step 10
  physical: () => 'action', crime: () => 'social', altercation_start: () => 'social', altercation_end: () => 'social', altercation_join: () => 'social', aftermath: () => 'memory', coherence: () => 'system', coherence_retry: () => 'system', intent: () => 'memory', touch: () => 'social',
  fire_start: () => 'director', fire_out: () => 'object', fire_burnt: () => 'object', room_fire: () => 'director', room_fire_out: () => 'object', barricade: () => 'object', barricade_removed: () => 'object', object_broken: () => 'object', light_knocked_over: () => 'object', restraint_end: () => 'body', vigil_relieved: () => 'action', habit_blocked: () => 'system', tier_capped: () => 'system', learned_from_reflection: () => 'social',
  intention: () => 'memory', habits: () => 'memory', habit: () => 'activity', habit_change: () => 'memory', mortality: () => 'body', dread: () => 'director', stock: () => 'object',
  // step 11
  persona_traits: () => 'memory', ambition: () => 'memory', ambition_rejected: () => 'system', scheme: () => 'director', scheme_none: () => 'memory', scheme_rejected: () => 'system', scheme_step_due: () => 'memory',
  lie: () => 'social', lie_retold: () => 'speech', lie_caught: () => 'social', lie_confessed: () => 'social', trust_claim: () => 'social', contradiction: () => 'social', tell: () => 'social', leak: () => 'social', deceive_incomplete: () => 'system',
  feeling_repaired: () => 'system', feeling_dropped: () => 'system', feeling_target_unmapped: () => 'system',
  reflection_gate: () => 'memory',
  consolidation: () => 'memory',
  error: () => 'system',
  system: () => 'system',
};

export function eventCategory(e) {
  return (EVENT_CATEGORY[e.type] ?? (() => 'system'))(e);
}

const actorOf = (e) => e.actor_id ?? e.actorId ?? null;

export function transcriptHtml(lines, { thoughts = false } = {}) {
  return (lines ?? []).map((l) => `<div class="tline">${who(l.speakerId)}${l.toId ? ` <span class="dim">→</span> ${who(l.toId)}` : ''}: “${esc(l.text)}”${
    thoughts && l.thought ? `<div class="tthought">${esc(l.thought)}</div>` : ''}</div>`).join('') || '<span class="dim">(nothing was said)</span>';
}

export function describeDoingHtml(id, action) {
  const a = String(action ?? '').trim();
  return /^\s*\w+ing\b/i.test(a) ? `${who(id)} is ${esc(a)}` : `${who(id)} is busy: ${esc(a)}`;
}

const targetHtml = (t) => (Array.isArray(t) ? t.map((x) => who(x)).join(', ') : ['here', 'near', 'far', 'reached', 'everyone'].includes(t ?? 'here') ? esc(t ?? 'here') : who(t));

/** A director effect as a short phrase. */
export function effectHtml(x) {
  const room = (id) => esc(roomName(id));
  const tgt = targetHtml(x.target);
  switch (x.type) {
    case 'damage': return `${tgt} −${esc(x.amount)} hp`;
    case 'heal': return `${tgt} +${esc(x.amount)} hp`;
    case 'needs': return `${tgt} needs ${['hunger', 'fatigue', 'hp'].filter((k) => x[k] != null && x[k] !== '').map((k) => `${k} ${x.mode === 'add' && x[k] > 0 ? '+' : ''}${esc(x[k])}`).join(', ')}${x.mode === 'add' ? '' : ' (set)'}`;
    case 'move': return `${tgt} → ${room(x.to)}`;
    case 'sleep': return `${tgt} falls asleep${x.hours ? ` (${esc(x.hours)} h)` : ''}`;
    case 'wake': return `${tgt} wakes up`;
    case 'collapse': return `${tgt} knocked out`;
    case 'revive': return `${tgt} revived`;
    case 'knowPlace': return `${tgt} learns ${room(x.place)}`;
    case 'forgetPlace': return `${tgt} forgets ${room(x.place)}`;
    case 'mark': return `${tgt} now “${esc(x.text)}”${x.minutes ? ` (${esc(x.minutes)} min)` : ''}`;
    case 'unmark': return `${tgt} appearance restored`;
    case 'goal': return `${tgt} ${x.mode === 'remove' ? 'drops' : 'gains'} goal “${esc(x.text)}”`;
    case 'trait': return `${tgt} ${esc(x.trait)} ${x.value != null && x.value !== '' ? `= ${esc(x.value)}` : `${x.delta > 0 ? '+' : ''}${esc(x.delta)}`}`;
    case 'persona': return `${tgt} ${esc(x.field)} ${x.mode === 'append' ? '+=' : '='} “${esc(truncate(x.text, 60))}”`;
    case 'roomService': return `${room(x.room)}: ${esc(x.service)} ${x.enabled === false ? 'unavailable' : 'available again'}${x.minutes ? ` (${esc(x.minutes)} min)` : ''}`;
    case 'blockExit': return `path ${room(x.room)} ⇄ ${room(x.to)} blocked${x.minutes ? ` (${esc(x.minutes)} min)` : ''}`;
    case 'unblockExit': return `path ${room(x.room)} ⇄ ${room(x.to)} open`;
    case 'whisper': return `🤫 ${tgt}: ${esc(x.text)}`;
    default: return esc(x.type);
  }
}

/** One event as a readable HTML sentence. */
export function eventHtml(e) {
  const d = e.data ?? {};
  const actor = actorOf(e);
  const thought = d.thought ? ` <span class="ithought">(${esc(d.thought)})</span>` : '';
  switch (e.type) {
    case 'action': {
      const args = d.args ?? {};
      switch (d.tool) {
        case 'say':
          return `${who(actor)}${d.toId ? ` <span class="dim">→</span> ${who(d.toId)}` : ''}: <span class="speech">“${esc(args.text)}”</span>${d.truncated ? ' <span class="dim">[cut]</span>' : ''}${thought}`;
        case 'tell_about_place':
          return `${who(actor)} <span class="dim">tells</span> ${who(d.toId)} <span class="dim">about ${esc(roomName(args.place))}:</span> <span class="speech">“${esc(args.text)}”</span>${thought}`;
        case 'move_to': return `${who(actor)} heads to ${esc(roomName(args.destination))}${thought}`;
        case 'travel_to': return `${who(actor)} sets off for ${esc(roomName(args.destination))}${d.route?.length > 1 ? ` <span class="dim">via ${d.route.slice(0, -1).map((r) => esc(roomName(r))).join(', ')}</span>` : ''}${thought}`;
        case 'do': return `${describeDoingHtml(actor, args.action)} <span class="dim">(${esc(args.minutes)} min)</span>${d.objectId ? ` <span class="dim">on</span> ${objName(d.objectId)}` : ''}${thought}`;
        case 'wait': return `${who(actor)} waits: ${esc(args.reason)} <span class="dim">(${esc(args.minutes)} min)</span>${thought}`;
        case 'eat': return `${who(actor)} sits down and eats at ${esc(roomName(e.location))}${thought}`;
        case 'sleep': return `${who(actor)} goes to sleep ${d.quality === 'rough' ? '<span class="bad">on the ground</span>' : 'in a bed'} at ${esc(roomName(e.location))}${thought}`;
        case 'feed': return `${who(actor)} feeds ${who(d.targetId)}${thought}`;
        case 'take': case 'put': case 'give': case 'examine': case 'search': case 'use':
          return `${who(actor)} <span class="dim">${esc(d.tool)}${d.conceal || args.conceal ? ' (hide)' : ''}</span> ${objName(d.objectId ?? d.targetId)}${args.intent ? `: “${esc(args.intent)}”` : ''}${d.toId ? ` → ${who(d.toId)}` : ''}${d.anchorId ? ` <span class="dim">${esc(args.relation ?? 'on')}</span> ${objName(d.anchorId)}` : ''}${thought}`;
        case 'hide_feelings': return `${who(actor)} <span class="dim">🎭 hides ${args.emotion ? esc(args.emotion) : 'what they feel'}</span>${thought}`;
        case 'propose_party': return `${who(actor)} <span class="dim">proposes a party to</span> ${(d.invited ?? []).map((x) => who(x)).join(', ')}: ${esc(args.purpose)}${thought}`;
        case 'accept_invitation': return `${who(actor)} <span class="good">accepts</span> ${who(d.fromId)}<span class="dim">'s invitation</span>${thought}`;
        case 'decline_invitation': return `${who(actor)} <span class="bad">declines</span> ${who(d.fromId)}<span class="dim">'s invitation</span>${thought}`;
        case 'leave_group': return `${who(actor)} <span class="dim">leaves the party</span>${args.farewell ? `: <span class="speech">“${esc(args.farewell)}”</span>` : ''}${thought}`;
        case 'leave_conversation':
          return `${who(actor)} leaves the conversation${args.farewell ? `: <span class="speech">“${esc(args.farewell)}”</span>` : ''}${thought}`;
        default: return `${who(actor)} ${esc(d.tool)} ${esc(JSON.stringify(args))}`;
      }
    }
    case 'arrive': return `${who(actor)} arrives at ${esc(roomName(e.location))}`;
    case 'emotion': return d.contagion
      ? `${who(actor)} <span class="dim">catches the</span> <b>${esc(d.emotion)}</b> <span class="dim">spreading at ${esc(roomName(e.location))}${d.otherId ? ' (aimed at ' : ''}</span>${d.otherId ? `${who(d.otherId)}<span class="dim">)</span>` : ''} <span class="dim">→ ${esc(d.intensity)}</span>`
      : `${who(actor)} <span class="dim">is gripped by</span> <b>${esc(d.emotion)}</b> <span class="dim">of</span> ${who(d.otherId)}${d.about && store.citizens.has(d.about) ? ` <span class="dim">over</span> ${who(d.about)}` : ''} <span class="dim">(${esc(d.intensity)})</span>${d.cause ? `: <span class="ithought">${esc(detok(d.cause))}</span>` : ''}`;
    case 'feeling': return `${who(actor)} <span class="dim">feels:</span> ${d.parsed ? `<b>${esc(d.parsed.type)} ${d.parsed.change > 0 ? '+' : ''}${esc(d.parsed.change)}</b>${d.parsed.target ? ` → ${who(d.parsed.target)}` : ''}${d.parsed.why ? ` <span class="ithought">${esc(d.parsed.why)}</span>` : ''}` : `<span class="dim">(not understood) ${esc(d.raw)}</span>`}`;
    case 'relationship': return `${who(actor)} <span class="dim">now sees</span> ${who(d.otherId)} <span class="dim">differently</span> ${d.dTrust ? `<span class="${d.dTrust > 0 ? 'good' : 'bad'}">trust ${d.dTrust > 0 ? '+' : ''}${esc(d.dTrust)}</span>` : ''} ${d.dAffinity ? `<span class="${d.dAffinity > 0 ? 'good' : 'bad'}">liking ${d.dAffinity > 0 ? '+' : ''}${esc(d.dAffinity)}</span>` : ''} <span class="dim">(${esc(d.source)})</span>: “${esc(detok(d.reason))}”`;
    case 'signal': return `${who(actor)} <span class="bad">⚠ warning sign</span> about ${who(d.otherId)}: <b>${esc(d.sign)}</b>${d.text ? ` <span class="dim">“${esc(detok(d.text))}”</span>` : ''}${d.dTrust ? ` <span class="bad">trust ${esc(d.dTrust)}</span>` : ''}`;
    case 'group': return groupEventHtml(d, actor);
    case 'object': return objectEventHtml(e, d, actor);
    case 'notice': return `${who(actor)} <span class="${d.importance >= 7 ? 'bad' : 'dim'}">notices:</span> ${esc(d.text)}`;
    case 'search': return `${who(actor)} searches ${d.targetId ? `around ${objName(d.targetId)}` : esc(roomName(e.location))}: ${d.found?.length ? `<span class="good">finds ${d.found.map(objName).join(', ')}</span>` : '<span class="dim">nothing</span>'}${(d.rolls ?? []).length ? ` <span class="dim">[${d.rolls.map((r) => `${esc(r.id)} d${esc(r.difficulty)} ${Math.round(r.chance * 100)}% ${r.hit ? '✓' : '✗'}`).join(', ')}]</span>` : ''}`;
    case 'examine': return `${who(actor)} examines ${objName(d.objectId)}${d.noticed?.length ? ` <span class="dim">and notices ${d.noticed.map(objName).join(', ')}</span>` : ''}`;
    case 'keeper': return `<span class="dim">🗝 keeper ${esc(d.verdict)}${d.objectId ? ` on ${esc(d.objectId)}` : ''}: ${esc(d.reason ?? d.error ?? '')}</span>`;
    case 'action_stale': return `${who(actor)} <span class="dim">couldn't ${esc(d.tool)}: ${esc(detok(d.reason))}</span>`;
    case 'interrupt': return `${who(actor)} <span class="bad">is interrupted mid-thought</span>${d.cause ? ` <span class="dim">by: ${esc(truncate(detok(d.cause.text), 90))}</span>` : ''}`;
    case 'rethink_stale': return `${who(actor)} <span class="bad">rethinks</span> <span class="dim">(${esc(d.linesSince)} new lines while thinking)</span>`;
    case 'position': return `${who(actor)} <span class="dim">${esc(d.kind ?? 'moves')}: ${esc(d.fromRoom ?? '?')}${d.fromSpot ? ` (${esc(d.fromSpot)})` : ''} → ${esc(d.toRoom ?? '?')}${d.toSpot ? ` (${esc(d.toSpot)})` : ''}</span>`;
    case 'activity': return `${who(actor)} <span class="dim">${esc(d.from ?? '?')} → ${esc(d.to)}${d.detail?.description ? `: ${esc(d.detail.description)}` : ''}</span>`;
    case 'damage': return `${who(actor)} <span class="bad">is hurt</span> <span class="dim">(−${esc(d.amount)} hp, now ${esc(d.hp)})</span>`;
    case 'body': return `${who(actor)} <span class="${d.importance >= 7 ? 'bad' : 'dim'}">feels ${esc(d.level)}${d.reminder ? ' (still)' : ''}:</span> <span class="ithought">${esc(d.text)}</span>`;
    case 'meal': return `${who(actor)} <span class="dim">${d.completed ? 'finished eating' : 'ate part of a meal'} (hunger −${esc(d.relief)}, now ${esc(d.hunger)})</span>`;
    case 'wake': return `${who(actor)} wakes up <span class="dim">(${esc(d.reason)}, slept ${Math.round((d.sleptMinutes ?? 0) / 6) / 10} h)</span>`;
    case 'forced_sleep': return `${who(actor)} <span class="bad">drops asleep from exhaustion</span> at ${esc(roomName(e.location))}`;
    case 'collapse': return `${who(actor)} <span class="bad">collapses</span> at ${esc(roomName(e.location))} <span class="dim">(${esc(d.reason)})</span>`;
    case 'revive': return `${who(actor)} comes to${d.by && d.by !== 'director' ? `, fed by ${who(d.by)}` : d.by === 'director' ? ' <span class="dim">(director)</span>' : ''}`;
    case 'death': return `${who(actor)} <span class="bad">dies</span> <span class="dim">(${esc(d.reason)})</span>`;
    // step 9.5
    case 'learned_death': return `${who(actor)} ${d.certainty === 'suspected' ? 'sees someone lying still:' : 'learns'} ${who(d.deadId)} ${d.certainty === 'suspected' ? '' : 'is dead'} <span class="dim">(${esc(String(d.how).startsWith('told:') ? `told by ${store.citizens.get(d.how.slice(5))?.name ?? d.how.slice(5)}` : d.how)}, ${esc(d.certainty)})</span>`;
    case 'news': return `${who(actor)} tells ${who(d.to)}: ${who(d.person)} <span class="bad">${esc(String(d.news).replace('_', ' '))}</span> <span class="dim">(heard by ${(d.heardBy ?? []).length})</span>`;
    case 'gathering': return `${who(actor)} calls people to ${esc(roomName(d.place))} (${esc(d.time)}): ${esc(d.purpose)} <span class="dim">(${esc(d.told)} told)</span>`;
    case 'burial': return `${who(actor)} <span class="bad">buries</span> ${who(d.deadId)}${d.words ? ` — “${esc(d.words)}”` : ''} <span class="dim">(${(d.present ?? []).length} present)</span>`;
    case 'tend_body': return `${who(actor)} tends the body of ${who(d.deadId)}: ${esc(String(d.how).replace('_', ' '))}`;
    case 'vigil': return `${who(actor)} keeps vigil over ${who(d.deadId)}`;
    // step 10
    case 'physical': return `${who(actor)} <span class="${['shove', 'grab', 'slap', 'punch', 'kick', 'strike', 'throw_at', 'snatch', 'pin_down', 'choke', 'tie_up', 'drag'].includes(d.act) ? 'bad' : ''}">${esc(String(d.act).replace('_', ' '))}</span> ${who(d.targetId)}${d.with ? ` <span class="dim">with ${esc(d.with)}</span>` : ''}${d.hit === false ? ' <span class="dim">— misses</span>' : (d.effects ?? []).length ? ` — <span class="bad">${esc(d.effects.join(', '))}</span>` : ''}${d.words ? ` “${esc(d.words)}”` : ''}${d.reason ? ` <span class="dim">(why: ${esc(d.reason)})</span>` : ''}`;
    case 'crime': return `⚖ ${who(actor)} <span class="bad">${esc(String(d.kind).replace('_', ' '))}</span>${d.victimId ? ` against ${who(d.victimId)}` : ''} <span class="dim">(severity ${esc(d.severity)}, ${(d.witnesses ?? []).length ? `seen by ${(d.witnesses ?? []).length}` : 'unseen'})</span>`;
    // step 11 (director view: the truth is shown next to the lie)
    case 'persona_traits': return `${who(actor)} <span class="dim">is honesty ${esc(d.honesty)}/10, cunning ${esc(d.cunning)}/10${d.reason ? ` — ${esc(d.reason)}` : ''} (${esc(d.origin)})</span>`;
    case 'ambition': return `${who(actor)} <span class="dim">ambition ${esc(d.op)}:</span> ${esc(d.text)}${d.intensity != null ? ` <span class="dim">(${esc(d.kind)}, ${esc(d.intensity)}/10${d.secrecy ? `, ${esc(d.secrecy)}` : ''})</span>` : ''}${d.why ? ` — <i>${esc(d.why)}</i>` : ''}`;
    case 'ambition_rejected': return `${who(actor)} <span class="dim">ambition rejected: ${esc(d.text)} (${esc(d.why)})</span>`;
    case 'scheme': return `🕸 ${who(actor)} <span class="dim">scheme #${esc(d.schemeId)} ${esc(d.op)}${d.status ? ` → ${esc(d.status)}` : ''}:</span> ${esc(d.goal ?? d.why ?? '')}`;
    case 'scheme_none': return `${who(actor)} <span class="dim">makes no plan</span>${d.why ? ` — <i>${esc(d.why)}</i>` : ''}`;
    case 'scheme_rejected': return `<span class="dim">${who(actor)}'s plan had invalid steps: ${esc(JSON.stringify(d.rejected).slice(0, 200))}</span>`;
    case 'scheme_step_due': return `🕸 ${who(actor)} <span class="dim">plan step due:</span> ${esc(d.text)}`;
    case 'lie': return `🤥 ${who(actor)} <span class="bad">lies</span> <span class="dim">(${esc(d.kind)})</span>: “${esc(d.said)}” <span class="dim">— truth: ${esc(d.truth)}${d.why ? `; why: ${esc(d.why)}` : ''}</span>`;
    case 'lie_retold': return `${who(actor)} <span class="dim">passes lie #${esc(d.lieId)} on to</span> ${who(d.to)}`;
    case 'lie_caught': return `🤥 ${who(actor)} <span class="bad">sees through</span> ${who(d.liarId)}'s lie <span class="dim">(${esc(d.how)})</span>`;
    case 'lie_confessed': return `🙏 ${who(actor)} <span class="good">owns up</span> to lie #${esc(d.lieId)} <span class="dim">(to ${(d.to ?? []).map((id) => store.citizens.get(id)?.name ?? id).join(', ') || 'nobody'})</span>`;
    case 'trust_claim': return `${who(actor)} <span class="dim">${esc(d.verdict)}s</span> ${who(d.from)}: “${esc(d.claim)}”${d.why ? ` <span class="dim">— ${esc(d.why)}</span>` : ''}${d.lieId ? ' <span class="dim">(a lie)</span>' : ''}`;
    case 'contradiction': return `${who(actor)} <span class="dim">notices something doesn't fit</span> in ${who(d.liarId)}'s story <span class="dim">— ${esc(String(d.why ?? '').replace(/\{\{[cp]:(\w+)\}\}/g, (_m, id) => store.citizens.get(id)?.name ?? id))}</span>`;
    case 'tell': return `${who(d.to)} <span class="dim">notices</span> ${who(actor)} <span class="dim">${d.nervousTruth ? 'seems nervous (telling the truth)' : 'giving something away'}</span>`;
    case 'leak': return `${who(actor)} <span class="bad">${d.leaked === 'full' ? 'gives away' : 'hints at'}</span> a secret ${esc(d.kind)} to ${who(d.to)}${d.what ? ` <span class="dim">— ${esc(d.what)}</span>` : ''}`;
    case 'altercation_start': return `⚔ ${who(actor)} goes at ${who(d.targetId)} <span class="dim">(${esc(d.intent)})</span>`;
    case 'altercation_end': return `⚔ a fight ends: ${esc(d.reason)} <span class="dim">(${(d.participants ?? []).map((id) => store.citizens.get(id)?.name ?? id).join(', ')})</span>`;
    case 'coherence': return `${who(actor)} <span class="dim">${esc(d.kind)}:</span> ${esc(d.action)} → ${who(d.victimId)}${d.reason ? ` — “${esc(d.reason)}”` : ''}`;
    case 'coherence_retry': return `${who(actor)} <span class="dim">asked again:</span> ${esc(d.message)}`;
    case 'fire_start': return `🔥 <span class="bad">fire</span> in ${esc(roomName(e.location))} <span class="dim">(${esc(d.cause)})</span>${actor ? ` — ${who(actor)}` : ''}`;
    case 'room_fire': return `🔥 <span class="bad">${esc(roomName(e.location))} is on fire</span>`;
    case 'fire_out': return `the fire on ${esc(d.objectId)} is out <span class="dim">(${esc(d.how)})</span>${actor ? ` — ${who(actor)}` : ''}`;
    case 'intention': return `${who(actor)} <span class="dim">intention ${esc(d.op)}:</span> ${esc(d.text ?? d.id)}`;
    case 'habits': return `${who(actor)} <span class="dim">habits (${esc(d.origin)}):</span> ${esc((d.habits ?? []).join('; '))}`;
    case 'habit': return `<span class="dim">↺ out of habit,</span> ${who(actor)} ${esc(d.what)} <span class="dim">(${esc(d.step)})</span>`;
    case 'habit_change': return `${who(actor)} <span class="dim">habit ${esc(d.op)}:</span> ${esc(d.what)} — “${esc(d.why)}”`;
    case 'mortality': return `${who(actor)} <span class="bad">${d.state ? `fears for ${esc(d.state === 'critical' ? 'their life — critical' : 'their life')}` : 'is out of danger'}</span>`;
    case 'dread': return `<span class="director">village dread ${esc(d.delta > 0 ? '+' : '')}${esc(d.delta)} → ${esc(d.value)}</span> <span class="dim">(${esc(d.why)})</span>`;
    case 'stock': return `${who(actor)} restocks ${esc(roomName(e.location))} <span class="dim">(${esc(d.service)}: ${esc(Math.round(d.before))} → ${esc(Math.round(d.after))})</span>`;
    case 'learn_place': return `${who(actor)} learns about ${esc(roomName(d.placeId))} from ${who(d.from)} <span class="dim">(${esc((d.services ?? []).join(', ') || 'no services')})</span>`;
    case 'director_effect': return `<span class="director">✨ ${effectHtml(d)}</span>${d.notify ? ` <span class="dim">“${esc(d.notify)}”</span>` : ''}`;
    case 'conversation_end': {
      const names = (d.participants ?? []).map((p) => who(p.id)).join(', ');
      return `<span class="dim">Conversation ended (${esc(d.reason)}, ${(d.lines ?? []).length} lines) in ${esc(roomName(e.location))}:</span> ${names}
        <details class="inline"><summary>transcript</summary><div class="transcript">${transcriptHtml(d.lines, { thoughts: true })}</div></details>`;
    }
    case 'director':
      if (d.action === 'event' || d.action === 'effects') {
        const where = d.roomId === '*' ? 'everywhere' : d.roomId ? esc(roomName(d.roomId)) : 'director';
        return `<span class="director">${esc(d.icon ?? (d.action === 'effects' ? '✨' : '📣'))} ${where}${d.radius ? ` (radius ${esc(d.radius)})` : ''}:</span> ${esc(d.texts?.here || d.text || '')}`
          + `${d.roomEffect ? ` <span class="effect">lasting: ${esc(d.roomEffect.text)}</span>` : ''}`
          + `${(d.effects ?? []).length ? ` <span class="dim">[${d.effects.map(effectHtml).join(' · ')}]</span>` : ''}`;
      }
      if (d.action === 'whisper') return `<span class="director">🤫 whisper → </span>${who(d.citizenId)}: ${esc(d.text)}`;
      return `<span class="dim">[director] ${esc(d.action)}${d.value != null ? ` ${esc(d.value)}` : ''}${d.name ? ` ${esc(d.name)}` : ''}${d.scenario ? ` ${esc(d.scenario)}` : ''}</span>`;
    case 'plan': return `${who(actor)} <span class="dim">${d.revised ? 'revises' : 'plans'} the day: ${esc(d.steps)} steps${d.dropped ? ` (${esc(d.dropped)} made no sense)` : ''}</span>`;
    case 'reflection_gate': return `${who(actor)} <span class="dim">reflects on ${esc(d.conversationId)}: ${esc(d.path)} (${esc(d.reason)})</span>`;
    case 'consolidation': return `${who(actor)} <span class="dim">sleeps on the day: ${esc(d.lasting)} lasting, ${esc(d.merged)} merged, ${esc(d.faded)} faded, ${esc(d.gists)} gists</span>`;
    case 'error': return `<span class="bad">${actor ? `${esc(citizenName(actor))}: ` : ''}${esc(d.message)}</span>`;
    default: return `<span class="dim">${esc(JSON.stringify(d))}</span>`;
  }
}

// ---------- groups (step 5.5) ----------
function groupEventHtml(d, actor) {
  const lock = d.secret || d.public === false ? ' 🔒' : '';
  switch (d.action) {
    case 'create': return `<span class="dim">👥 group formed:</span> <b>${esc(d.name)}</b> <span class="dim">(${esc(d.kind)}, ${esc(d.origin)})${lock}</span>`;
    case 'join': return `${who(actor)} <span class="dim">joins</span> <b>${esc(d.name)}</b>${d.role && d.role !== 'member' ? ` <span class="dim">as ${esc(d.role)}</span>` : ''}${lock}`;
    case 'leave': return `${who(actor)} <span class="dim">leaves</span> <b>${esc(d.name)}</b>`;
    case 'dissolve': return `<span class="dim">👥</span> <b>${esc(d.name)}</b> <span class="dim">is dissolved</span>`;
    case 'propose': return `${who(actor)} <span class="dim">asks</span> ${(d.invited ?? []).map((x) => who(x)).join(', ')} <span class="dim">to form a party:</span> ${esc(d.purpose)}`;
    case 'decline': return `${who(actor)} <span class="dim">turns down</span> ${who(d.from)}<span class="dim">'s invitation</span>`;
    default: return `<span class="dim">[group] ${esc(d.action)} ${esc(d.name ?? '')}</span>`;
  }
}

// ---------- objects (step 5) ----------
function objName(id) {
  if (!id) return '';
  const o = store.objects?.get(id);
  return `<span class="ob-name" data-object="${esc(id)}">${esc(o ? o.label : id)}</span>`;
}

const OBJ_VERB = { take: 'picks up', put: 'puts down', give: 'gives', conceal: 'hides', use: 'uses', state: 'changes', move: 'moves', reset: 'resets', create: 'creates', edit: 'edits', use_rejected: 'fails to use' };
function objectEventHtml(e, d, actor) {
  const by = actor ? who(actor) : `<span class="director">${esc(d.by === 'director' ? '✨ director' : d.by ?? 'code')}</span>`;
  const a = d.after ?? {};
  const b = d.before ?? {};
  const place = (x) => (x?.holder ? `→ ${who(x.holder)}` : x?.placement?.of ? `${esc(x.placement.relation)} ${objName(x.placement.of)}` : '');
  let what = '';
  if (d.action === 'give') what = place(a);
  else if (d.action === 'put' || d.action === 'conceal' || d.action === 'move') what = place(a);
  else if (b.state && a.state && b.state !== a.state) what = `<span class="dim">${esc(b.state)} →</span> <b>${esc(a.state)}</b>`;
  else if (d.intent) what = `“${esc(d.intent)}”${d.reason ? ` <span class="dim">— ${esc(d.reason)}</span>` : ''}`;
  const seen = d.witnesses == null ? '' : d.witnesses.length ? ` <span class="dim">seen by ${d.witnesses.map((w) => esc(citizenName(w))).join(', ')}</span>` : (actor ? ' <span class="bad">— unseen</span>' : '');
  return `${by} ${esc(OBJ_VERB[d.action] ?? d.action)} ${objName(d.objectId)} ${what}${seen}`;
}

// ---------- navigation ----------
/** Switch the main view (app.js listens). params are view-specific (e.g. { conversationId }). */
export function navigate(view, params = {}) {
  emit('navigate', { view, params });
}

// ---------- event detail modal ----------
export async function showEvent(id) {
  let e;
  try {
    e = await api.get(`/api/events/${id}`);
  } catch (err) {
    return showModal(`<p class="bad">${esc(err.message)}</p>`);
  }
  const links = [];
  if (e.conversationId) links.push(`<button data-open-conv="${esc(e.conversationId)}">Open conversation</button>`);
  if (e.type === 'conversation_end') links.push(`<button data-open-conv="${esc(e.data.conversationId)}">Open conversation</button>`);
  if (actorOf(e)) links.push(`<button data-citizen="${esc(actorOf(e))}">Inspect ${esc(citizenName(actorOf(e)))}</button>`);
  showModal(`
    <div class="modal-head"><span class="t">#${e.id} · ${esc(gameTime(e.game_time))}</span> <span class="type">${esc(e.type)}</span></div>
    <div class="modal-sentence">${eventHtml(e)}</div>
    <div class="row">${links.join('')}</div>
    <details><summary>raw</summary><pre class="detail">${esc(JSON.stringify(e.data, null, 2))}</pre></details>`);
}

export function showModal(html) {
  closeModal();
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal" role="dialog">${html}<button class="modal-close" title="Close (Esc)">✕</button></div>`;
  back.addEventListener('click', (ev) => {
    if (ev.target === back || ev.target.closest('.modal-close')) closeModal();
    const conv = ev.target.closest('[data-open-conv]');
    if (conv) {
      closeModal();
      navigate('conversations', { conversationId: conv.dataset.openConv });
    }
  });
  document.body.append(back);
}

export function closeModal() {
  const m = document.querySelector('.modal-back');
  if (m) {
    m.remove();
    return true;
  }
  return false;
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** localStorage, but never throws (private windows, blocked storage). */
export const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`aw.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`aw.${key}`, JSON.stringify(value));
    } catch { /* ignore */ }
  },
};

/** step 11: a director-only marker on a conversation line: a lie (hover: the truth), a confiding, a confession. */
export function lineMarkHtml(l) {
  const m = l?.mark;
  if (!m) return '';
  if (m.kind === 'lie') return ` <span class="line-mark lie" title="${esc(`A lie (${m.lieKind}). Truth: ${m.truth}${m.why ? `
Why: ${m.why}` : ''}`)}">🤥</span>`;
  if (m.kind === 'confide') return ` <span class="line-mark confide" title="${esc(`Confiding a secret plan (scheme #${m.scheme ?? '?'}, asks: ${m.ask})`)}">🤫</span>`;
  if (m.kind === 'confess') return ` <span class="line-mark confess" title="${esc(`Owning up to lie #${m.lie ?? '?'}`)}">🙏</span>`;
  return '';
}
