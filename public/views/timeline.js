// Timeline: SVG swimlanes, one lane per citizen. Activity blocks (talking solid, doing hatched,
// moving thin line, waiting light, thinking = pulse markers), conversation bands, speech ticks,
// director markers, red ticks for interrupts/rethinks. Wheel = zoom, drag = pan, "follow live".
import { store, subscribe, subscribeMany, select } from '../store.js';
import { api, esc, gameTime, clockOnly, citizenName, truncate, navigate, showEvent, debounce, prefs } from '../util.js';
import { EMO_COLOR } from './emotions-ui.js';
import { colorOf } from '../colors.js';

const LABEL_W = 96;
const POINT_ICONS = { eat: '🍲', learn_place: '💡', revive: '✚', collapse: '⛔', forced_sleep: '💤', death: '💀', injury: '🩹', treatment: '⚕', accident: '⚠', critical_window: '🩸', learned_death: '🕯', habit: '↺', gathering: '📣', burial: '⚱', news: '✉', physical: '✊', crime: '⚖', fire_start: '🔥', room_fire: '🔥', altercation_start: '⚔', barricade: '🚪', scheme: '🕸', scheme_step_due: '🕸', lie_caught: '🤥', lie_confessed: '🙏', contradiction: '❓' };
const LANE_H = 34;
const TOP = 26;
const MIN_SPAN = 15;
const MAX_SPAN = 7 * 1440;

let root = null;
let span = prefs.get('timelineSpan', 360);
let follow = true;
let end = null; // game minutes at the right edge when not following
let data = null;
let timer = null;
let loading = false;

let showVitality = false;

export function mount(el) {
  root = el;
  el.innerHTML = `
    <div class="tl-toolbar">
      <label class="check"><input type="checkbox" id="tl-follow" checked> Follow live</label>
      <label class="check" title="hourly vitality while someone is hurt or ill"><input type="checkbox" id="tl-vitality"> Vitality</label>
      <button id="tl-in" title="Zoom in">＋</button><button id="tl-out" title="Zoom out">－</button>
      <button id="tl-6h">6 h</button>
      <span class="dim" id="tl-range"></span>
      <span class="legend">
        <span><i class="lg solid"></i>talking</span><span><i class="lg hatch"></i>doing</span>
        <span><i class="lg line"></i>moving</span><span><i class="lg light"></i>waiting</span><span><i class="lg dark"></i>sleeping</span><span><i class="lg down"></i>collapsed</span>
        <span><i class="lg pulse"></i>thinking</span><span><i class="lg tick"></i>speech</span><span><i class="lg red"></i>interrupt / rethink</span>
      </span>
    </div>
    <div class="tl-wrap" id="tl-wrap"><svg id="tl-svg"></svg></div>`;
  el.querySelector('#tl-follow').addEventListener('change', (e) => {
    follow = e.target.checked;
    if (follow) end = null;
    load();
  });
  el.querySelector('#tl-vitality').addEventListener('change', (e) => { showVitality = e.target.checked; render(); });
  el.querySelector('#tl-in').addEventListener('click', () => zoom(1 / 1.5));
  el.querySelector('#tl-out').addEventListener('click', () => zoom(1.5));
  el.querySelector('#tl-6h').addEventListener('click', () => {
    span = 360;
    load();
  });
  const svg = el.querySelector('#tl-svg');
  svg.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('mousedown', onDragStart);
  svg.addEventListener('click', onClick);

  const refresh = debounce(() => follow && load(), 1200);
  const offs = [
    subscribe('event', refresh),
    subscribeMany(['filter', 'citizens'], () => render()),
    subscribe('clock', () => follow && data && render()),
  ];
  const onResize = debounce(render, 100);
  window.addEventListener('resize', onResize);
  timer = setInterval(() => follow && load(), 5000);
  load();
  return () => {
    offs.forEach((off) => off());
    clearInterval(timer);
    window.removeEventListener('resize', onResize);
    root = null;
  };
}

function windowRange() {
  const now = store.clock?.gameMinutes ?? 0;
  const to = follow || end == null ? now : end;
  return { from: to - span, to };
}

async function load() {
  if (!root || loading) return;
  loading = true;
  const { from, to } = windowRange();
  try {
    data = await api.get(`/api/timeline?from=${from}&to=${to}`);
  } catch (err) {
    data = null;
    root.querySelector('#tl-range').textContent = err.message;
  } finally {
    loading = false;
  }
  render();
}

function zoom(factor, anchorT = null) {
  const { from, to } = windowRange();
  const newSpan = Math.min(MAX_SPAN, Math.max(MIN_SPAN, span * factor));
  if (!follow && anchorT != null) {
    const ratio = (anchorT - from) / (to - from);
    end = anchorT + (1 - ratio) * newSpan;
  }
  span = newSpan;
  prefs.set('timelineSpan', span);
  load();
}

function onWheel(e) {
  e.preventDefault();
  if (e.shiftKey) return pan(e.deltaY * span / 1000);
  const t = timeAt(e);
  zoom(e.deltaY > 0 ? 1.2 : 1 / 1.2, t);
}

function pan(deltaMinutes) {
  const { to } = windowRange();
  follow = false;
  root.querySelector('#tl-follow').checked = false;
  end = Math.min(store.clock?.gameMinutes ?? to, to + deltaMinutes);
  load();
}

function onDragStart(e) {
  if (e.button !== 0 || e.target.closest('[data-ev],[data-conv],[data-cit]')) return;
  const startX = e.clientX;
  const startEnd = windowRange().to;
  const width = root.querySelector('#tl-svg').clientWidth - LABEL_W - 10;
  const move = (ev) => {
    const dx = ev.clientX - startX;
    if (Math.abs(dx) < 3) return;
    follow = false;
    root.querySelector('#tl-follow').checked = false;
    end = Math.min(store.clock?.gameMinutes ?? startEnd, startEnd - (dx / width) * span);
    render(true);
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    if (!follow) load();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function timeAt(e) {
  const svg = root.querySelector('#tl-svg');
  const rect = svg.getBoundingClientRect();
  const { from, to } = windowRange();
  const w = rect.width - LABEL_W - 10;
  return from + ((e.clientX - rect.left - LABEL_W) / w) * (to - from);
}

function onClick(e) {
  const ev = e.target.closest('[data-ev]');
  const conv = e.target.closest('[data-conv]');
  const cit = e.target.closest('[data-cit]');
  if (conv && !ev) return navigate('conversations', { conversationId: conv.dataset.conv });
  if (ev?.dataset.conv) return navigate('conversations', { conversationId: ev.dataset.conv });
  if (ev) return showEvent(ev.dataset.ev);
  if (cit) select(cit.dataset.cit);
}

function render(provisional = false) {
  if (!root || !data) return;
  const svg = root.querySelector('#tl-svg');
  const W = root.querySelector('#tl-wrap').clientWidth || 800;
  const { from, to } = provisional ? windowRange() : { from: data.from, to: follow ? (store.clock?.gameMinutes ?? data.to) : data.to };
  const citizens = data.citizens.filter((c) => store.citizens.get(c.id)?.kind !== 'shadow');
  const lane = new Map(citizens.map((c, i) => [c.id, i]));
  const H = TOP + citizens.length * LANE_H + 8;
  const x = (t) => LABEL_W + ((t - from) / (to - from)) * (W - LABEL_W - 10);
  const clampX = (t) => Math.max(LABEL_W, Math.min(W - 10, x(t)));
  const y = (id) => TOP + lane.get(id) * LANE_H;
  const dimmed = (id) => (store.filterCitizen && store.filterCitizen !== id ? ' opacity="0.25"' : '');
  root.querySelector('#tl-range').textContent = `${gameTime(from)} – ${gameTime(to)} (${Math.round((to - from) / 60 * 10) / 10} h)`;

  const out = [];
  // patterns for "doing"
  out.push('<defs>', ...citizens.map((c) => `<pattern id="hatch-${esc(c.id)}" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
    <rect width="6" height="6" fill="${colorOf(c.id)}" fill-opacity="0.18"/><line x1="0" y1="0" x2="0" y2="6" stroke="${colorOf(c.id)}" stroke-width="2.5"/></pattern>`), '</defs>');

  // hour grid
  const step = to - from > 1440 * 2 ? 360 : to - from > 720 ? 120 : to - from > 180 ? 60 : to - from > 60 ? 15 : 5;
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
    out.push(`<line class="grid" x1="${x(t)}" y1="${TOP - 6}" x2="${x(t)}" y2="${H}"/><text class="axis" x="${x(t) + 3}" y="14">${esc(t % 1440 === 0 ? gameTime(t) : clockOnly(t))}</text>`);
  }

  // lanes + labels
  for (const c of citizens) {
    const yy = y(c.id);
    out.push(`<g data-cit="${esc(c.id)}"${dimmed(c.id)}><rect class="lane" x="0" y="${yy}" width="${W}" height="${LANE_H - 4}"/>
      <text class="lane-label" x="8" y="${yy + LANE_H / 2 + 2}" fill="${colorOf(c.id)}">${esc(truncate(c.name, 12))}</text></g>`);
  }

  // Step 6: lanes tinted by the dominant emotion of each hourly sample; bumps of 3+ as small diamonds.
  const emo = data.emotions ?? { samples: {}, bumps: [] };
  for (const c of citizens) {
    const list = emo.samples[c.id] ?? [];
    for (let i = 0; i < list.length; i++) {
      const [t, type, intensity] = list[i];
      const end = Math.min(list[i + 1]?.[0] ?? t + 60, t + 90);
      if (!type || intensity < 2 || end < from || t > to) continue;
      const x1 = clampX(t);
      const x2 = clampX(end);
      out.push(`<rect class="emo-tint" x="${x1}" y="${y(c.id)}" width="${Math.max(1, x2 - x1)}" height="${LANE_H - 4}" fill="${EMO_COLOR[type] ?? '#888'}" fill-opacity="${Math.min(0.42, 0.06 + intensity * 0.035)}"${dimmed(c.id)}><title>${esc(`${c.name}: ${type} ${intensity}`)}</title></rect>`);
    }
  }
  for (const b of emo.bumps) {
    if (!lane.has(b.citizenId) || b.t < from || b.t > to) continue;
    const px = x(b.t);
    const py = y(b.citizenId) + 5;
    out.push(`<path class="emo-bump" d="M${px},${py - 4} l4,4 l-4,4 l-4,-4 z" fill="${EMO_COLOR[b.type] ?? '#888'}"${dimmed(b.citizenId)}><title>${esc(`${b.type} ${b.delta > 0 ? '+' : ''}${b.delta}${b.target ? ` at ${store.citizens.get(b.target)?.name ?? b.target}` : ''} (${b.source})\n${b.cause ?? ''}`)}</title></path>`);
  }

  // conversation bands (behind activity blocks)
  for (const cv of data.conversations) {
    const ids = cv.participants.filter((id) => lane.has(id));
    if (!ids.length) continue;
    const x1 = clampX(cv.from);
    const x2 = clampX(cv.to);
    if (x2 <= LABEL_W || x1 >= W - 10) continue;
    const ys = ids.map((id) => y(id));
    const title = `<title>${esc(`Conversation in ${store.rooms.get(cv.roomId)?.name ?? cv.roomId}: ${ids.map(citizenName).join(', ')} · ${cv.lines} lines`)}</title>`;
    out.push(`<g class="band" data-conv="${esc(cv.id)}">${title}${ids.map((id) => `<rect x="${x1}" y="${y(id) + 1}" width="${Math.max(2, x2 - x1)}" height="${LANE_H - 6}" rx="4"/>`).join('')}
      <line x1="${x1}" y1="${Math.min(...ys) + 4}" x2="${x1}" y2="${Math.max(...ys) + LANE_H - 8}"/></g>`);
  }

  // activity spans
  for (const s of data.spans) {
    if (!lane.has(s.citizenId)) continue;
    const x1 = clampX(s.from);
    const x2 = clampX(s.open && follow ? to : s.to); // open spans grow with the clock between refreshes
    if (x2 < LABEL_W || x1 > W - 10) continue;
    const w = Math.max(1, x2 - x1);
    const yy = y(s.citizenId);
    const color = colorOf(s.citizenId);
    const d = s.detail ?? {};
    const what = d.description ?? d.reason ?? (d.to ? `→ ${store.rooms.get(d.to)?.name ?? d.to}` : '');
    const title = `<title>${esc(`${citizenName(s.citizenId)}: ${s.type}${what ? ` · ${what}` : ''}\n${gameTime(s.from)} – ${clockOnly(s.to)}`)}</title>`;
    const attrs = `${s.eventId ? `data-ev="${s.eventId}"` : `data-cit="${esc(s.citizenId)}"`}${dimmed(s.citizenId)}`;
    switch (s.type) {
      case 'talking':
        out.push(`<rect class="sp" ${attrs} x="${x1}" y="${yy + 7}" width="${w}" height="${LANE_H - 18}" rx="2" fill="${color}" fill-opacity="0.85">${title}</rect>`);
        break;
      case 'doing':
        out.push(`<rect class="sp" ${attrs} x="${x1}" y="${yy + 7}" width="${w}" height="${LANE_H - 18}" rx="2" fill="url(#hatch-${esc(s.citizenId)})" stroke="${color}" stroke-opacity="0.5">${title}</rect>`);
        break;
      case 'moving':
        out.push(`<rect class="sp" ${attrs} x="${x1}" y="${yy + LANE_H / 2 - 3}" width="${w}" height="2" fill="${color}">${title}</rect>`);
        break;
      case 'waiting':
        out.push(`<rect class="sp" ${attrs} x="${x1}" y="${yy + 7}" width="${w}" height="${LANE_H - 18}" rx="2" fill="${color}" fill-opacity="0.2">${title}</rect>`);
        break;
      case 'sleeping':
        out.push(`<rect class="sp" ${attrs} x="${x1}" y="${yy + 7}" width="${w}" height="${LANE_H - 18}" rx="2" fill="#0b0c10" stroke="${color}" stroke-opacity="0.4">${title}</rect>`);
        break;
      case 'collapsed':
        out.push(`<rect class="sp" ${attrs} x="${x1}" y="${yy + 7}" width="${w}" height="${LANE_H - 18}" rx="2" fill="#5a1f1f" stroke="#e06666" stroke-opacity="0.6">${title}</rect>`);
        break;
      case 'thinking':
        out.push(`<circle class="sp pulse-dot" ${attrs} cx="${x1}" cy="${yy + LANE_H / 2 - 2}" r="2.5" fill="#cfd3ff">${title}</circle>`);
        break;
      default: break; // idle: empty lane
    }
  }

  // point events
  for (const p of data.points) {
    if (p.t < from || p.t > to) continue;
    const px = x(p.t);
    if (p.type === 'director') {
      out.push(`<g class="marker" data-ev="${p.eventId}"><title>${esc(`${p.label ?? 'Director event'} at ${store.rooms.get(p.roomId)?.name ?? p.roomId}\n${p.text}`)}</title>
        <line x1="${px}" y1="${TOP - 6}" x2="${px}" y2="${H}"/><text x="${px - 7}" y="${TOP - 8}">${esc(p.icon ?? '📣')}</text></g>`);
      continue;
    }
    if (!p.citizenId || !lane.has(p.citizenId)) continue;
    const yy = y(p.citizenId);
    if (p.type === 'speech') {
      const title = `${citizenName(p.citizenId)}${p.toId ? ` → ${citizenName(p.toId)}` : ''}: “${p.text}”${p.thought ? `\n(${p.thought})` : ''}`;
      out.push(`<g class="tick" data-ev="${p.eventId}" ${p.conversationId ? `data-conv="${esc(p.conversationId)}"` : ''}${dimmed(p.citizenId)}>
        <title>${esc(title)}</title><rect x="${px - 3}" y="${yy}" width="6" height="9" fill="transparent"/>
        <line x1="${px}" y1="${yy + 1}" x2="${px}" y2="${yy + 8}" stroke="${colorOf(p.citizenId)}" stroke-width="2"/></g>`);
    } else if (POINT_ICONS[p.type]) {
      const icon = p.type === 'physical' ? ['', '✊', '🩸', '☠'][p.severity ?? 1] ?? '✊' : POINT_ICONS[p.type]; // step 10: violence by severity
      out.push(`<g class="tick" data-ev="${p.eventId}"${dimmed(p.citizenId)}><title>${esc(`${p.type.replace('_', ' ')}${p.text ? `: ${p.text}` : ''}`)}</title><text x="${px - 6}" y="${yy + LANE_H - 6}" font-size="${p.severity >= 3 ? 13 : 11}">${icon}</text></g>`);
    } else if (p.type === 'whisper') {
      out.push(`<g class="tick" data-ev="${p.eventId}"><title>${esc(`Whisper: ${p.text}`)}</title><text x="${px - 6}" y="${yy + LANE_H - 6}" font-size="11">🤫</text></g>`);
    } else {
      out.push(`<g class="tick red" data-ev="${p.eventId}"><title>${esc(`${p.type}${p.text ? `: ${p.text}` : ''}`)}</title>
        <rect x="${px - 3}" y="${yy + LANE_H - 13}" width="6" height="9" fill="transparent"/>
        <line x1="${px}" y1="${yy + LANE_H - 12}" x2="${px}" y2="${yy + LANE_H - 5}"/></g>`);
    }
  }

  // step 7B: the vitality line per citizen (optional overlay): 100 at the top of the lane, 0 at the bottom
  if (showVitality) {
    const per = new Map();
    for (const s of data.vitality ?? []) {
      if (s.t < from - 120 || s.t > to + 120 || !lane.has(s.citizenId)) continue;
      (per.get(s.citizenId) ?? per.set(s.citizenId, []).get(s.citizenId)).push(s);
    }
    for (const [id, list] of per) {
      const yy = y(id);
      const pts = list.map((s) => `${x(s.t).toFixed(1)},${(yy + LANE_H - 3 - (Math.max(0, Math.min(100, s.v)) / 100) * (LANE_H - 6)).toFixed(1)}`);
      if (pts.length > 1) out.push(`<polyline class="vit-line" points="${pts.join(' ')}" fill="none" stroke="#d9483b" stroke-width="1.4"${dimmed(id)}><title>${esc(citizenName(id))}: vitality</title></polyline>`);
    }
  }

  // now line
  const now = store.clock?.gameMinutes;
  if (now != null && now >= from && now <= to) out.push(`<line class="now" x1="${x(now)}" y1="${TOP - 6}" x2="${x(now)}" y2="${H}"/>`);

  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = out.join('');
}
