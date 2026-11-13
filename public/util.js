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
export const detok = (t) => String(t ?? '').replace(/\{\{c:([\w-]+)\}\}/g, (_m, id) => store.citizens.get(id)?.name ?? id);

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
  body: () => 'body',
  meal: () => 'body',
  wake: () => 'body',
  collapse: () => 'body',
  forced_sleep: () => 'body',
  revive: () => 'body',
  death: () => 'body',
  learn_place: () => 'speech',
  plan: () => 'memory',
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
    case 'activity': return `${who(actor)} <span class="dim">${esc(d.from ?? '?')} → ${esc(d.to)}${d.detail?.description ? `: ${esc(d.detail.description)}` : ''}</span>`;
    case 'damage': return `${who(actor)} <span class="bad">is hurt</span> <span class="dim">(−${esc(d.amount)} hp, now ${esc(d.hp)})</span>`;
    case 'body': return `${who(actor)} <span class="${d.importance >= 7 ? 'bad' : 'dim'}">feels ${esc(d.level)}${d.reminder ? ' (still)' : ''}:</span> <span class="ithought">${esc(d.text)}</span>`;
    case 'meal': return `${who(actor)} <span class="dim">${d.completed ? 'finished eating' : 'ate part of a meal'} (hunger −${esc(d.relief)}, now ${esc(d.hunger)})</span>`;
    case 'wake': return `${who(actor)} wakes up <span class="dim">(${esc(d.reason)}, slept ${Math.round((d.sleptMinutes ?? 0) / 6) / 10} h)</span>`;
    case 'forced_sleep': return `${who(actor)} <span class="bad">drops asleep from exhaustion</span> at ${esc(roomName(e.location))}`;
    case 'collapse': return `${who(actor)} <span class="bad">collapses</span> at ${esc(roomName(e.location))} <span class="dim">(${esc(d.reason)})</span>`;
    case 'revive': return `${who(actor)} comes to${d.by && d.by !== 'director' ? `, fed by ${who(d.by)}` : d.by === 'director' ? ' <span class="dim">(director)</span>' : ''}`;
    case 'death': return `${who(actor)} <span class="bad">dies</span> <span class="dim">(${esc(d.reason)})</span>`;
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
