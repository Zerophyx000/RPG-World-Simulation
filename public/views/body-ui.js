// Step 7B UI: the body figure (parts coloured by health, internal layer, condition icons, garments and aids drawn on),
// the inspector's body panel, roster/world chips. Everything is plain SVG/HTML from GET /api/citizens/:id/body.
import { esc, gameTime } from '../util.js';

// ---------- chips for the roster and the map ----------
/** 🩸 bleeding · 🦴 fracture · 🤒 fever · 😵 unconscious · 💀 dead */
export function bodyChips(c) {
  const chips = c?.body?.chips ?? [];
  const out = [];
  if (c?.alive === false) out.push('<span class="body-chip dead" title="dead">💀</span>');
  else {
    if (chips.includes('bleeding')) out.push(`<span class="body-chip bleed" title="bleeding${c.body?.bleeding ? ` (${Math.round(c.body.bleeding)}% blood/h)` : ''}${c.body?.critical != null ? ` — critical, ~${Math.round(c.body.critical)} game min` : ''}">🩸</span>`);
    if (chips.includes('fracture')) out.push('<span class="body-chip" title="a broken bone">🦴</span>');
    if (chips.includes('fever')) out.push('<span class="body-chip" title="fever or infection">🤒</span>');
    if (chips.includes('unconscious')) out.push('<span class="body-chip" title="unconscious">😵</span>');
  }
  return out.join('');
}

// ---------- the figure ----------
// Shapes for the anatomical LEFT side are drawn on the viewer's right; the right side is mirrored.
const W = 120;
const SHAPES = {
  head: ['ellipse', 60, 20, 17, 19], skull: ['ellipse', 60, 17, 11, 12, true], brain: ['ellipse', 60, 16, 7, 6, true],
  eye_left: ['circle', 67, 18, 3], ear_left: ['ellipse', 78, 22, 3, 5], nose: ['rect', 58, 22, 4, 7], jaw: ['rect', 50, 33, 20, 7],
  tongue: ['rect', 56, 34, 8, 4, true], neck: ['rect', 54, 40, 12, 9],
  torso: ['rect', 38, 49, 44, 62], chest: ['rect', 40, 50, 40, 28], abdomen: ['rect', 40, 79, 40, 30], spine: ['rect', 59, 50, 2, 58, true],
  heart: ['circle', 66, 60, 5, null, true], lung_left: ['rect', 61, 54, 14, 18, true], stomach: ['ellipse', 66, 86, 7, 6, true], liver: ['ellipse', 52, 84, 8, 6, true],
  upper_arm_left: ['rect', 84, 50, 13, 30], forearm_left: ['rect', 85, 82, 12, 28], hand_left: ['rect', 85, 112, 12, 12], fingers_left: ['rect', 85, 125, 12, 9],
  thigh_left: ['rect', 61, 111, 17, 42], shin_left: ['rect', 62, 155, 15, 38], foot_left: ['rect', 60, 195, 19, 10],
};
const SELF_SYMMETRIC = new Set(['head', 'skull', 'brain', 'nose', 'jaw', 'tongue', 'neck', 'torso', 'chest', 'abdomen', 'spine', 'heart', 'stomach', 'liver']);

function shapeOf(id) {
  if (SHAPES[id]) return SHAPES[id];
  if (id.endsWith('_right')) {
    const left = SHAPES[id.replace('_right', '_left')];
    if (!left) return null;
    const [t, a, b, c, d, internal] = left;
    return t === 'rect' ? [t, W - a - c, b, c, d, internal] : [t, W - a, b, c, d, internal];
  }
  if (id === 'lung_right') return ['rect', 45, 54, 14, 18, true];
  return null;
}

const centre = ([t, a, b, c, d]) => (t === 'rect' ? [a + c / 2, b + d / 2] : [a, b]);
const healthColor = (frac) => `hsl(${Math.round(Math.max(0, Math.min(1, frac)) * 120)}, 62%, 44%)`;

function shapeSvg(spec, attrs) {
  const [t, a, b, c, d] = spec;
  if (t === 'rect') return `<rect x="${a}" y="${b}" width="${c}" height="${d}" rx="2" ${attrs}/>`;
  if (t === 'circle') return `<circle cx="${a}" cy="${b}" r="${c}" ${attrs}/>`;
  return `<ellipse cx="${a}" cy="${b}" rx="${c}" ry="${d}" ${attrs}/>`;
}

const GARMENT_STROKE = { intact: '', worn: '#c9b27a', torn: '#e08a3c', rags: '#d9483b', destroyed: '#d9483b' };

/** The SVG figure. opts: { pickable (parts are clickable, data-part), selected (part id), internal (show the organ layer) } */
export function bodyFigureSvg(v, opts = {}) {
  if (!v?.parts) return '';
  const byPart = new Map();
  for (const c of [...(v.conditions ?? []), ...(v.permanent ?? [])]) if (c.part) (byPart.get(c.part) ?? byPart.set(c.part, []).get(c.part)).push(c);
  const out = [];
  const draw = (p, layer) => {
    const spec = shapeOf(p.id);
    if (!spec || Boolean(spec[5]) !== layer) return;
    const frac = p.maxHealth ? p.health / p.maxHealth : 1;
    const conds = byPart.get(p.id) ?? [];
    const tip = `${p.label}: ${p.missing ? 'missing' : `${Math.round(p.health * 10) / 10}/${p.maxHealth}`}${conds.map((c) => `\n· ${c.type.replace(/_/g, ' ')} ${c.severity}${c.bleeding > 0.3 ? ` (${c.bleedWord ?? 'bleeding'})` : ''}`).join('')}`;
    const fill = p.missing ? '#3a3a3a' : healthColor(frac);
    const cls = `part${p.missing ? ' missing' : ''}${opts.selected === p.id ? ' picked' : ''}${layer ? ' internal' : ''}`;
    out.push(`<g class="${cls}" ${opts.pickable ? `data-part="${esc(p.id)}"` : ''}><title>${esc(tip)}</title>${shapeSvg(spec, `fill="${fill}" fill-opacity="${layer ? 0.9 : 0.78}" stroke="${p.missing ? '#888' : '#222'}" stroke-width="${opts.selected === p.id ? 2.2 : 0.8}" ${p.missing ? 'stroke-dasharray="3 2"' : ''}`)}</g>`);
  };
  for (const p of v.parts) draw(p, false);
  // garments: an outline over what they cover (state by colour), blood as a red wash
  for (const g of v.garments ?? []) {
    const stroke = GARMENT_STROKE[g.state];
    if (!stroke && !g.bloodied) continue;
    for (const id of g.covers ?? []) {
      const spec = shapeOf(id);
      if (!spec) continue;
      out.push(`<g class="garment-mark" pointer-events="none">${shapeSvg(spec, `fill="${g.bloodied ? 'rgba(170,20,20,0.35)' : 'none'}" stroke="${stroke || 'none'}" stroke-width="1.2" stroke-dasharray="${g.state === 'torn' || g.state === 'rags' ? '2 2' : '0'}"`)}</g>`);
    }
  }
  for (const p of v.parts) draw(p, true);
  // condition icons
  for (const [partId, conds] of byPart) {
    const spec = shapeOf(partId);
    if (!spec) continue;
    const [cx, cy] = centre(spec);
    const icons = [];
    if (conds.some((c) => c.bleeding > 0.3)) icons.push('🩸');
    if (conds.some((c) => c.type === 'fracture')) icons.push('🦴');
    if (conds.some((c) => c.type === 'burn')) icons.push('🔥');
    if (conds.some((c) => c.type === 'infection')) icons.push('🦠');
    icons.forEach((ic, i) => out.push(`<text class="cond-ico${ic === '🩸' ? ' pulse' : ''}${shapeOf(partId)[5] ? ' internal' : ''}" x="${cx + (i - (icons.length - 1) / 2) * 7}" y="${cy + 3}" font-size="8" text-anchor="middle" pointer-events="none">${ic}</text>`));
  }
  // aids drawn on
  for (const c of v.conditions ?? []) {
    if (!c.part || !c.flags) continue;
    const spec = shapeOf(c.part);
    if (!spec) continue;
    const [t, a, b, w, h] = spec;
    if (c.flags.splinted && t === 'rect') out.push(`<g pointer-events="none" stroke="#b5894a" stroke-width="1.6">${[0.25, 0.5, 0.75].map((k) => `<line x1="${a - 1}" y1="${b + h * k}" x2="${a + w + 1}" y2="${b + h * k}"/>`).join('')}</g>`);
    if ((c.flags.bandaged || c.flags.wrapped) && t === 'rect') out.push(`<rect pointer-events="none" x="${a - 1}" y="${b + h * 0.3}" width="${w + 2}" height="${h * 0.4}" fill="${c.flags.bandaged ? '#f2efe6' : '#b9a98a'}" fill-opacity="0.85" stroke="#777" stroke-width="0.5"/>`);
  }
  for (const a of v.aids ?? []) {
    if (a.type === 'crutch') out.push('<line pointer-events="none" x1="106" y1="96" x2="86" y2="206" stroke="#8a6a3a" stroke-width="2.4"><title>crutch</title></line>');
    if (a.type === 'sling') out.push('<path pointer-events="none" d="M84 52 L44 90 L90 96" fill="none" stroke="#e9e2cc" stroke-width="3"><title>sling</title></path>');
    if (a.type === 'eye_patch') out.push('<circle pointer-events="none" cx="67" cy="18" r="3.6" fill="#111"><title>eye patch</title></circle>');
    if (a.type === 'peg_leg') out.push('<rect pointer-events="none" x="63" y="158" width="6" height="42" fill="#8a6a3a"><title>peg leg</title></rect>');
  }
  return `<svg class="body-fig${opts.internal ? ' show-internal' : ''}" viewBox="0 0 120 210" preserveAspectRatio="xMidYMid meet">${out.join('')}</svg>`;
}

// ---------- the inspector panel ----------
const CAP_LABEL = {
  consciousness: 'consciousness', sight: 'sight', hearing: 'hearing', speech: 'speech', breathing: 'breathing', bloodPumping: 'heart',
  manipulationLeft: 'left hand', manipulationRight: 'right hand', moving: 'moving', eating: 'eating',
};
const bar = (label, value, max, cls = '', text = null) => `<div class="body-bar ${cls}"><span class="bl">${esc(label)}</span><span class="bb"><i style="width:${Math.max(0, Math.min(100, (value / max) * 100))}%"></i></span><span class="bv">${esc(text ?? Math.round(value))}</span></div>`;

function conditionRow(c) {
  const tr = (c.treatments ?? []).map((t) => `${esc(t.method.replace(/_/g, ' '))} <span class="dim">(${esc(t.quality)}${t.effective === false ? ', no effect' : ''}, ${esc(gameTime(t.at))})</span>`).join(', ');
  const flags = Object.entries(c.flags ?? {}).filter(([k, v]) => v && !['critical', 'clotted', 'quality', 'infected', 'age'].includes(k) && typeof v !== 'object').map(([k]) => k).join(', ');
  return `<div class="cond-row ${c.bleeding > 0.3 ? 'bleeding' : ''}">
    <div class="cond-head"><b>${esc(c.type.replace(/_/g, ' '))}</b>${c.partLabel ? ` · ${esc(c.partLabel)}` : ''} <span class="dim">severity ${c.severity}${c.initialSeverity !== c.severity ? ` (from ${c.initialSeverity})` : ''}${c.pain ? ` · pain ${c.pain}` : ''}</span>
      ${c.bleeding > 0.3 ? `<span class="bad">🩸 ${esc(c.bleedWord ?? '')} ${c.bleeding}%/h</span>` : ''}${c.permanent ? ' <span class="dim">permanent</span>' : ''}</div>
    <div class="cond-look dim">${esc(c.look || c.feel || '')} · ${esc(c.cause ?? '')}${c.geometry?.vessel ? ` · ${esc(c.geometry.vessel.replace('_', ' '))}, ${esc(c.geometry.depth ?? '')}${c.geometry.length_cm ? `, ${c.geometry.length_cm} cm` : ''}` : ''}</div>
    ${c.permanent ? '' : `<div class="cond-prog"><span class="dim">healing</span><span class="bb"><i style="width:${Math.round(c.healing * 100)}%"></i></span>${c.infection > 0.05 ? `<span class="dim">infection</span><span class="bb inf"><i style="width:${Math.round(c.infection * 100)}%"></i></span>` : ''}${c.clot > 0 && c.bleeding > 0 ? `<span class="dim">clot</span><span class="bb"><i style="width:${Math.round(c.clot * 100)}%"></i></span>` : ''}</div>`}
    ${flags ? `<div class="dim">${esc(flags)}</div>` : ''}${tr ? `<div class="cond-tr">${tr}</div>` : ''}</div>`;
}

export function bodyPanelHtml(v, { internal = false } = {}) {
  if (!v) return '<p class="muted">…</p>';
  const crit = v.critical ? `<div class="critical-banner">🩸 critical: ~${Math.round(v.critical.remaining)} game min before the bleeding turns fatal</div>` : '';
  const caps = Object.entries(v.capacities ?? {}).map(([k, x]) => bar(CAP_LABEL[k] ?? k, x, 1, x < 0.35 ? 'bad' : x < 0.8 ? 'warn' : '', `${Math.round(x * 100)}%`)).join('');
  const statuses = (v.status ?? []).map((s) => `<span class="status-chip">${esc(s)}</span>`).join('');
  const worn = (v.garments ?? []).map((g) => `<span class="garment ${esc(g.state)}${g.bloodied ? ' bloodied' : ''}">${esc(g.name.replace(/^the /, ''))} <span class="dim">${esc(g.state)}${g.bloodied ? ', bloodied' : ''}</span></span>`).join(' ');
  const aids = (v.aids ?? []).map((a) => `<span class="garment">${esc(a.type.replace(/_/g, ' '))}</span>`).join(' ');
  return `${crit}
    <div class="body-top">
      ${bar('vitality', v.vitality, 100, v.vitality < 40 ? 'bad' : v.vitality < 75 ? 'warn' : '', `${Math.round(v.vitality)}`)}
      ${bar('blood', v.blood, 100, v.blood < 60 ? 'bad' : v.blood < 85 ? 'warn' : '', `${Math.round(v.blood)}%${v.bloodStage && v.bloodStage !== 'none' ? ` · ${v.bloodStage}` : ''}`)}
      ${bar('pain', v.pain, 10, v.pain >= 6 ? 'bad' : '', `${v.pain}`)}
      ${v.bleeding?.total > 0.3 ? `<div class="bad">bleeding ${v.bleeding.total}% blood/h${v.regen !== 1 ? ` · regen ×${v.regen}` : ''}</div>` : v.regen !== 1 ? `<div class="dim">regen ×${v.regen}</div>` : ''}
      <div class="status-chips">${statuses || '<span class="dim">no status effects</span>'}</div>
    </div>
    <div class="body-main">
      <div class="body-fig-wrap"><label class="check"><input type="checkbox" class="body-internal" ${internal ? 'checked' : ''}> internal organs</label>${bodyFigureSvg(v, { internal })}</div>
      <div class="body-caps">${caps}</div>
    </div>
    ${worn ? `<div class="body-worn"><span class="dim">wearing</span> ${worn}</div>` : ''}${aids ? `<div class="body-worn"><span class="dim">aids</span> ${aids}</div>` : ''}
    <div class="body-conds">${v.conditions.length ? v.conditions.map(conditionRow).join('') : '<p class="muted">No injuries or illness.</p>'}${v.permanent.length ? `<h4>Lasting</h4>${v.permanent.map(conditionRow).join('')}` : ''}</div>`;
}
