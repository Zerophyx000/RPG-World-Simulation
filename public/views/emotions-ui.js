// Step 6 UI pieces: emotion colours, roster rings, the inspector's emotions panel with the mood line.
import { store } from '../store.js';
import { api, esc, gameTime, who, citizenName } from '../util.js';

export const EMO_COLOR = {
  joy: '#e8c547', sadness: '#5b7fb5', fear: '#e08a3c', anger: '#d9483b', disgust: '#8a9a3a', shame: '#b56b8f', guilt: '#8b6fb0',
  pride: '#c9a227', affection: '#e58aa5', gratitude: '#d4b04a', envy: '#4fae5a', jealousy: '#9a5fd0',
};
const BAND = ['slight', 'strong', 'intense', 'overwhelming'];

let types = null;
export async function emotionTypes() {
  if (!types) {
    types = await api.get('/api/emotions/types').catch(() => ({ types: {} }));
    for (const [k, t] of Object.entries(types.types ?? {})) if (t.color) EMO_COLOR[k] = t.color;
  }
  return types;
}

const hexA = (hex, a) => {
  const n = parseInt(String(hex).slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

/** Inline style for a ring in the dominant emotion's colour (intensity = how saturated). '' if calm. */
export function ringStyle(c, width = 2) {
  const d = c?.emotion?.dominant;
  if (!d || d.intensity < 2) return '';
  const color = EMO_COLOR[d.type] ?? d.color ?? '#888';
  return `box-shadow: 0 0 0 ${width}px ${hexA(color, Math.min(1, 0.25 + d.intensity / 10))}${d.intensity >= 7 ? `, 0 0 10px ${hexA(color, 0.6)}` : ''};`;
}

export function ringTitle(c) {
  const d = c?.emotion?.dominant;
  return d && d.intensity >= 2 ? `${BAND[d.intensity <= 3 ? 0 : d.intensity <= 6 ? 1 : d.intensity <= 8 ? 2 : 3]} ${d.type}${d.target ? ` at ${citizenName(d.target)}` : ''}` : '';
}

/** Green eye for envy, purple cracked heart for jealousy, when >= 4. */
export function emoIcons(c) {
  const e = c?.emotion;
  if (!e) return '';
  return `${e.envy >= 4 ? `<span class="emo-ico" title="envy ${e.envy}" style="color:${EMO_COLOR.envy}">👁</span>` : ''}${e.jealousy >= 4 ? `<span class="emo-ico" title="jealousy ${e.jealousy}" style="color:${EMO_COLOR.jealousy}">💔</span>` : ''}`;
}

/** Inspector panel: bars per entry, what they show, the mood line. */
export function emotionsPanelHtml(v, history) {
  if (!v) return '<p class="muted">…</p>';
  const bars = v.entries.length ? v.entries.map((e) => {
    const color = EMO_COLOR[e.type] ?? e.color;
    return `<div class="emo-row" title="${esc(`${e.cause ?? ''}\nsource: ${e.source} · since ${gameTime(e.since)} · shows ${e.expressed}${e.masked ? ' (masked)' : ''}`)}">
      <span class="emo-name" style="color:${color}">${esc(e.type)}</span>
      <span class="emo-bar"><i style="width:${e.intensity * 10}%;background:${color}"></i><b style="left:${Math.min(100, e.expressed * 10)}%" title="how much shows"></b></span>
      <span class="emo-val">${e.intensity.toFixed(1)}</span>
      <span class="emo-aim">${e.target ? `→ ${who(e.target)}` : ''}${e.aboutName ? ` <span class="dim">about ${esc(e.aboutName)}</span>` : ''}${e.masked ? ' <span class="mask" title="hiding it">🎭</span>' : ''}</span>
      <div class="emo-cause">${esc(e.cause ?? '')} <span class="dim">· ${esc(e.source)}</span></div></div>`;
  }).join('') : '<p class="muted">Calm: no feelings to speak of right now.</p>';
  const shows = v.showsAnyone.filter((s) => s.visible).map((s) => `<span style="color:${EMO_COLOR[s.type]}">${esc(BAND[s.band])} ${esc(s.type)}${s.target ? ` at ${esc(citizenName(s.target))}` : ''}</span>`).join(', ');
  const m = v.mood;
  return `${bars}
    <div class="emo-shows"><span class="dim">What others see:</span> ${shows || '<span class="dim">nothing shows</span>'}${v.shows?.length ? ` <span class="dim">— “${esc(v.shows[0])}”</span>` : ''}
      <span class="dim">· composure ${v.composure}</span></div>
    <div class="mood-head"><b>Mood</b> valence <b class="${m.valence < m.baseline.valence - 1 ? 'bad' : m.valence > m.baseline.valence + 1 ? 'good' : ''}">${m.valence.toFixed(1)}</b>
      <span class="dim">(baseline ${m.baseline.valence.toFixed(1)})</span> · tension <b>${m.tension.toFixed(1)}</b> <span class="dim">(baseline ${m.baseline.tension.toFixed(1)})</span>
      ${m.state.dir && m.state.lastingDays >= 2 ? `<span class="${m.state.dir < 0 ? 'bad' : 'good'}">· ${m.state.dir < 0 ? 'low' : 'high'} for ${m.state.lastingDays.toFixed(1)} days</span>` : ''}</div>
    ${moodSvg(history, m)}`;
}

/** Mood over the last game days: valence (line around a zero axis) and tension (thin line), nights marked. */
export function moodSvg(history, mood) {
  const samples = (history ?? []).filter((h) => (h.kind === 'sample' || h.kind === 'mood') && h.mood || h.kind === 'mood');
  const pts = samples.map((h) => ({ t: h.gameTime, v: h.mood?.valence ?? h.valence, s: h.mood?.tension ?? h.tension, night: Boolean(h.night) })).filter((p) => Number.isFinite(p.v));
  if (pts.length < 2) return '<p class="muted">The mood line appears after a few game hours.</p>';
  const W = 400; const H = 86; const pad = 4;
  const t0 = pts[0].t; const t1 = Math.max(pts.at(-1).t, t0 + 60);
  const x = (t) => pad + ((t - t0) / (t1 - t0)) * (W - pad * 2);
  const yv = (v) => H / 2 - (v / 5) * (H / 2 - pad);
  const ys = (s) => H - pad - (s / 10) * (H - pad * 2);
  const line = (f) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${f(p).toFixed(1)}`).join(' ');
  const days = [];
  for (let d = Math.ceil(t0 / 1440) * 1440; d < t1; d += 1440) days.push(`<line x1="${x(d)}" y1="0" x2="${x(d)}" y2="${H}" class="mday"/><text x="${x(d) + 2}" y="9" class="mlabel">day ${d / 1440 + 1}</text>`);
  const nights = pts.filter((p) => p.night).map((p) => `<circle cx="${x(p.t)}" cy="${yv(p.v)}" r="3" class="mnight"><title>consolidation (${esc(gameTime(p.t))})</title></circle>`);
  const base = mood?.baseline?.valence ?? 0;
  return `<svg class="mood-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" class="mzero"/><line x1="0" y1="${yv(base)}" x2="${W}" y2="${yv(base)}" class="mbase"><title>personality baseline</title></line>
    ${days.join('')}
    <path d="${line((p) => ys(p.s))}" class="mtension"><title>tension</title></path>
    <path d="${line((p) => yv(p.v))}" class="mvalence"><title>valence</title></path>${nights.join('')}</svg>
    <div class="dim mood-legend"><span class="lv">— valence (−5…+5)</span> <span class="lt">— tension (0…10)</span> <span>● night</span> <span>┄ baseline</span></div>`;
}

/** Emotion bumps as readable rows (the director's appraisal log). */
export function appraisalRowsHtml(rows) {
  return rows.length ? rows.map((r) => `<div class="appr-row"><span class="dim">${esc(gameTime(r.gameTime))}</span> ${who(r.citizenId)}
      <b style="color:${EMO_COLOR[r.type] ?? '#aaa'}">${esc(r.type)} ${r.delta > 0 ? '+' : ''}${esc(r.delta)}</b>${r.target ? ` → ${who(r.target)}` : ''}
      <span class="dim">${esc(r.source)}${r.rule && r.rule !== r.source ? `: ${esc(r.rule)}` : ''} → ${esc(r.intensity)}</span><div class="emo-cause">${esc(r.cause ?? '')}</div></div>`).join('')
    : '<p class="muted">Nothing yet.</p>';
}

export function colorOfEmotion(type) {
  return EMO_COLOR[type] ?? '#888';
}

export { store };
