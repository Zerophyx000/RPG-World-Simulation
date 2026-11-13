// Step 8: characters. A character is built in four layers, all by code:
//   1. a REGION-CODED TEMPLATE per build / direction / pose / frame: a grid whose cells say which body part they are
//      (head, neck, chest, abdomen, upper arm L/R, forearm, hand, thigh, shin, foot ...: the step-7 part tree)
//   2. the LOOK colours the regions (skin, hair, eyes) with palette ramps and auto shading (light from the top-left)
//   3. GARMENTS colour the regions they cover (worn state: holes, rags; bloodied: dark speckles near wounds)
//   4. the BODY draws injuries on the regions (blood, bandages, splints, bruises, burns, scars, missing parts) and the
//      FACE draws the expressed emotion
// The result is cached per appearance. `characterSprite` is the one producer: replace it to swap in hand-made art.
import { Img, mix, rngFor } from './pixels.js';

export const DIRS = ['down', 'up', 'left', 'right'];
export const POSES = { idle: 2, walk: 4, sit: 1, lie: 1, crawl: 2, work: 2, carry: 4 };

// region codes (grid cells)
export const R = { none: 0, head: 1, neck: 2, chest: 3, abdomen: 4, uL: 5, uR: 6, fL: 7, fR: 8, kL: 9, kR: 10, tL: 11, tR: 12, sL: 13, sR: 14, oL: 15, oR: 16 };
const CODE_LETTER = '.HNCAuUfFkKtTsSoO';
export const regionLetter = (code) => CODE_LETTER[code] ?? '.';

// step-7 part ids → region codes (anatomical left shows on the viewer's right when facing down)
export const PART_REGIONS = {
  head: [R.head], skull: [R.head], brain: [R.head], neck: [R.neck], torso: [R.chest, R.abdomen], chest: [R.chest], abdomen: [R.abdomen],
  upper_arm_left: [R.uL], upper_arm_right: [R.uR], forearm_left: [R.fL], forearm_right: [R.fR], hand_left: [R.kL], hand_right: [R.kR], fingers_left: [R.kL], fingers_right: [R.kR],
  thigh_left: [R.tL], thigh_right: [R.tR], shin_left: [R.sL], shin_right: [R.sR], foot_left: [R.oL], foot_right: [R.oR],
  jaw: [R.head], nose: [R.head], eye_left: [R.head], eye_right: [R.head], ear_left: [R.head], ear_right: [R.head], tongue: [R.head],
  heart: [R.chest], lung_left: [R.chest], lung_right: [R.chest], stomach: [R.abdomen], liver: [R.abdomen], spine: [R.chest, R.abdomen],
};
// what hangs off a part when it is missing (the arm below the elbow goes with the forearm, and so on)
const DISTAL = {
  upper_arm_left: [R.uL, R.fL, R.kL], forearm_left: [R.fL, R.kL], hand_left: [R.kL], fingers_left: [],
  upper_arm_right: [R.uR, R.fR, R.kR], forearm_right: [R.fR, R.kR], hand_right: [R.kR], fingers_right: [],
  thigh_left: [R.tL, R.sL, R.oL], shin_left: [R.sL, R.oL], foot_left: [R.oL],
  thigh_right: [R.tR, R.sR, R.oR], shin_right: [R.sR, R.oR], foot_right: [R.oR],
};

export const BUILDS = {
  slim:    { torsoW: 10, armW: 3, legW: 3, headW: 12, headH: 12, legShort: 0 },
  average: { torsoW: 12, armW: 3, legW: 4, headW: 13, headH: 13, legShort: 0 },
  broad:   { torsoW: 15, armW: 4, legW: 5, headW: 14, headH: 13, legShort: 0 },
  short:   { torsoW: 12, armW: 3, legW: 4, headW: 13, headH: 12, legShort: 3 },
};

export const FRAME_W = 32;
export const FRAME_H = 48;
const FEET_Y = 46; // the baseline of a standing character

// ---------- 1. templates ----------
/** Parts of one frame as drawable rects: { code, x, y, w, h } in painter's order (later paints over earlier). */
function skeleton(build, dir, pose, frame) {
  const B = BUILDS[build] ?? BUILDS.average;
  const side = dir === 'left' || dir === 'right';
  const tw = side ? Math.max(9, Math.round(B.torsoW * 0.8)) : B.torsoW; // seen from the side the body is a little narrower, not a stick
  const cx = 16;
  const ls = B.legShort;
  const phase = [0, 1, 0, -1][frame % 4];                 // walk cycle: -1, 0, 1
  const bob = pose === 'walk' || pose === 'carry' ? (frame % 2 ? -1 : 0) : pose === 'idle' ? (frame % 2 ? -1 : 0) : 0;
  let top = 0;                                              // extra drop of the upper body (sitting)
  let thighH = 7; let shinH = 6; let footH = 3;
  const parts = [];
  const add = (code, x, y, w, h) => parts.push({ code, x: Math.round(x), y: Math.round(y), w, h });

  if (pose === 'sit') { top = 7; thighH = 4; }
  const headY = 2 + ls + top + bob; const headH = B.headH;
  const neckY = headY + headH; const chestY = neckY + 2; const absY = chestY + 7; const hipY = absY + 6;
  const legTop = pose === 'sit' ? hipY - 1 : hipY;
  const thighY = legTop + (ls ? 0 : 0); const shinY = thighY + thighH; const footY = FEET_Y - footH + 1;
  const shinHeff = footY - shinY;
  const lw = B.legW; const aw = B.armW;
  const swing = pose === 'walk' || pose === 'carry' ? phase : 0;

  const leg = (sideSign, off, code3) => {
    // sideSign: -1 left of the figure (anatomical right in front view), +1 right
    const x = side ? cx - Math.floor(lw / 2) : cx + (sideSign > 0 ? 1 : -lw - 1);
    if (side) {
      // a stride: the legs swing forward and back, both feet stay on the baseline
      const dx = off * 3;
      add(code3[0], x + Math.round(dx * 0.5), thighY, lw, thighH);
      add(code3[1], x + dx, shinY, lw, shinHeff);
      add(code3[2], x + dx + 1, footY, lw + 1, footH);
    } else {
      // front / back: the stepping leg lifts its foot (never drops below the baseline: that read as a glitch)
      const lift = off > 0 ? 2 : 0;
      add(code3[0], x, thighY, lw, thighH);
      add(code3[1], x, shinY, lw, Math.max(2, shinHeff - lift));
      add(code3[2], x, footY - lift, lw + 1, footH);
    }
  };
  // far leg first, so the near leg paints over it
  const legs = () => {
    if (side) {
      const far = -swing; const near = swing;
      leg(-1, far, [R.tR, R.sR, R.oR]);
      leg(+1, near, [R.tL, R.sL, R.oL]);
    } else {
      leg(+1, swing, [R.tL, R.sL, R.oL]);
      leg(-1, -swing, [R.tR, R.sR, R.oR]);
    }
  };
  if (pose !== 'sit' || !side) legs();
  else legs();

  // torso
  const torso = () => {
    add(R.abdomen, cx - tw / 2, absY, tw, 6);
    add(R.chest, cx - tw / 2, chestY, tw, 7);
  };

  // arms: { upper, fore, hand } along the side of the torso; swing / raise per pose
  const arm = (sideSign, sw) => {
    const isL = sideSign > 0; // anatomical left = viewer's right (front view)
    const ux = side ? cx - aw / 2 + (isL ? 1 : -1) : cx + (sideSign > 0 ? tw / 2 : -tw / 2 - aw);
    const codes = isL ? [R.uL, R.fL, R.kL] : [R.uR, R.fR, R.kR];
    const sy = chestY + 1;
    let upperY = sy; let foreY = sy + 6; let handY = foreY + 5; let foreX = ux; let handX = ux; let fh = 5; let uh = 6;
    if (pose === 'work') {
      const up = (frame % 2 === 0) === isL;
      foreY = sy + 4; fh = 4; handY = up ? sy - 1 : sy + 5; foreX = ux + (side ? 3 : 0); handX = foreX;
    } else if (pose === 'carry') {
      foreY = sy + 4; fh = 4; handY = sy + 6; foreX = ux + (side ? 3 : isL ? -1 : 1); handX = foreX + (isL ? -1 : 1);
    } else if (pose === 'walk' || pose === 'idle') {
      const dy = side ? 0 : -sw * 2 * (isL ? 1 : -1) * -1;
      foreY += Math.round(dy / 2); handY += Math.round(dy);
      if (side) { foreX = ux + sw * 2 * (isL ? 1 : -1); handX = foreX + sw * (isL ? 1 : -1); }
    } else if (pose === 'sit') {
      handY = foreY + 3;
    }
    return [
      { code: codes[0], x: ux, y: upperY, w: aw, h: uh },
      { code: codes[1], x: foreX, y: foreY, w: aw, h: fh },
      { code: codes[2], x: handX, y: handY, w: aw, h: 3 },
    ];
  };
  const armPieces = (sw) => {
    const out = [];
    // far arm first in side views (it sits behind the torso), then torso, then near arm
    if (side) {
      for (const p of arm(-1, -sw)) add(p.code, p.x, p.y, p.w, p.h);
      torso();
      for (const p of arm(+1, sw)) add(p.code, p.x, p.y, p.w, p.h);
    } else {
      torso();
      for (const p of arm(+1, sw)) add(p.code, p.x, p.y, p.w, p.h);
      for (const p of arm(-1, -sw)) add(p.code, p.x, p.y, p.w, p.h);
    }
    return out;
  };
  armPieces(swing);

  // neck and head
  add(R.neck, cx - 2, neckY, 4, 2);
  const hw = side ? B.headW - 1 : B.headW;
  add(R.head, cx - hw / 2, headY, hw, headH);
  return { parts, head: { x: Math.round(cx - hw / 2), y: headY, w: hw, h: headH }, B, tw };
}

function rasterize(parts, w = FRAME_W, h = FRAME_H) {
  const grid = new Uint8Array(w * h);
  for (const p of parts) {
    for (let j = 0; j < p.h; j++) for (let i = 0; i < p.w; i++) {
      const x = p.x + i; const y = p.y + j;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      // round the corners of heads and torsos a little
      if (p.code === R.head && ((i === 0 || i === p.w - 1) && (j === 0 || j === p.h - 1))) continue;
      grid[y * w + x] = p.code;
    }
  }
  return { w, h, cells: grid };
}

const templateCache = new Map();
/** The region grid for one frame: { w, h, cells, head } (left = the right-facing grid mirrored; lie / crawl = the standing grid turned). */
export function template(build, dir, pose, frame = 0) {
  const key = `${build}|${dir}|${pose}|${frame}`;
  let t = templateCache.get(key);
  if (t) return t;
  if (dir === 'left') {
    const r = template(build, 'right', pose, frame);
    const cells = new Uint8Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) cells[y * r.w + (r.w - 1 - x)] = r.cells[y * r.w + x];
    t = { w: r.w, h: r.h, cells, head: { ...r.head, x: r.w - r.head.x - r.head.w }, mirrored: true, base: r };
  } else if (pose === 'lie' || pose === 'crawl') {
    const src = template(build, 'down', pose === 'lie' ? 'idle' : 'walk', pose === 'lie' ? 0 : frame * 2);
    // turn counter-clockwise: the head goes left, the feet right; crop to the used rows
    const w = src.h; const h = src.w;
    const cells = new Uint8Array(w * h);
    for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) cells[(src.w - 1 - x) * w + y] = src.cells[y * src.w + x];
    // crop
    let y0 = h; let y1 = 0; let x0 = w; let x1 = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (cells[y * w + x]) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    const cw = x1 - x0 + 1; const ch = y1 - y0 + 1;
    const out = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = cells[(y + y0) * w + x + x0];
    const hd = src.head;
    t = { w: cw, h: ch, cells: out, head: { x: hd.y - x0, y: src.w - 1 - (hd.x + hd.w - 1) - y0, w: hd.h, h: hd.w }, lying: true };
  } else {
    const sk = skeleton(build, dir, pose, frame);
    const g = rasterize(sk.parts);
    t = { ...g, head: sk.head };
  }
  templateCache.set(key, t);
  return t;
}

/** The template as text (for docs and the art gallery): one letter per region, '.' for empty. */
export function templateText(build, dir, pose, frame = 0) {
  const t = template(build, dir, pose, frame);
  const rows = [];
  for (let y = 0; y < t.h; y++) { let r = ''; for (let x = 0; x < t.w; x++) r += regionLetter(t.cells[y * t.w + x]); rows.push(r); }
  return rows.join('\n');
}

// ---------- 2-4. compositing ----------
const FACE_EXPRESSIONS = ['neutral', 'happy', 'sad', 'angry', 'afraid', 'disgusted', 'ashamed', 'surprised'];
export { FACE_EXPRESSIONS };

const SKIN_REGIONS = new Set([R.head, R.neck, R.uL, R.uR, R.fL, R.fR, R.kL, R.kR]);
const GARMENT_ORDER = { trousers: 1, skirt: 1, boots: 2, tunic: 3, cloak: 5, hood: 6, cap: 6, gloves: 4 };

function regionsOfParts(parts) {
  const s = new Set();
  for (const p of parts ?? []) for (const code of PART_REGIONS[p] ?? []) s.add(code);
  return s;
}

/** Hair shapes in head-box coordinates. */
function hairPixels(style, dir, head) {
  const out = [];
  const { x, y, w, h } = head;
  const row = (j, x0, x1) => { for (let i = x0; i < x1; i++) out.push([x + i, y + j]); };
  const side = dir === 'left' || dir === 'right';
  switch (style) {
    case 'bald': return out;
    case 'crop': row(0, 2, w - 2); row(1, 1, w - 1); row(2, 0, w); break;
    case 'long':
      row(0, 2, w - 2); row(1, 1, w - 1); row(2, 0, w); row(3, 0, w); row(4, 0, 2); row(4, w - 2, w);
      for (let j = 5; j < h + 5; j++) { out.push([x, y + j], [x + 1, y + j], [x + w - 1, y + j], [x + w - 2, y + j]); }
      if (dir === 'up' || side) for (let j = 4; j < h + 6; j++) row(j, 1, w - 1);
      break;
    case 'bun': row(0, 2, w - 2); row(1, 1, w - 1); row(2, 0, w); row(3, 0, 2); row(3, w - 2, w); row(4, 0, 1); row(4, w - 1, w);
      for (let j = -3; j < 0; j++) row(j, Math.floor(w / 2) - 2, Math.floor(w / 2) + 2); break;
    case 'ponytail': row(0, 2, w - 2); row(1, 1, w - 1); row(2, 0, w); row(3, 0, 2); row(3, w - 2, w);
      if (dir === 'up') for (let j = 3; j < h + 6; j++) row(j, Math.floor(w / 2) - 1, Math.floor(w / 2) + 1);
      else if (side) for (let j = 2; j < h + 4; j++) out.push([x + (dir === 'right' ? 0 : w - 1), y + j], [x + (dir === 'right' ? 1 : w - 2), y + j]);
      break;
    case 'curly': row(-1, 3, w - 3); row(0, 1, w - 1); row(1, 0, w); row(2, 0, w); row(3, 0, 2); row(3, w - 2, w); row(4, 0, 1); row(4, w - 1, w); break;
    case 'braid': row(0, 2, w - 2); row(1, 1, w - 1); row(2, 0, w); row(3, 0, 2); row(3, w - 2, w);
      for (let j = 4; j < h + 8; j++) { out.push([x + 1, y + j], [x + w - 2, y + j]); if (dir === 'up') row(j, Math.floor(w / 2) - 1, Math.floor(w / 2) + 1); } break;
    default: row(0, 2, w - 2); row(1, 1, w - 1); row(2, 0, w); row(3, 0, w); row(4, 0, 1); row(4, w - 1, w); // short
  }
  if (dir === 'up') for (let j = 3; j < h - 1; j++) if (style !== 'bald') row(j, j < h - 2 ? 0 : 1, j < h - 2 ? w : w - 1); // the back of the head is all hair, down to the nape
  if (side) for (let j = 4; j < Math.floor(h * 0.6); j++) if (style !== 'bald') out.push([x + (dir === 'right' ? 0 : w - 1), y + j], [x + (dir === 'right' ? 1 : w - 2), y + j]);
  return out;
}

function expressionFace(img, dir, head, expr, ink, skinShadow, mouthCol, closed = false) {
  const { x, y, w } = head;
  const cxh = x + Math.floor(w / 2);
  const side = dir === 'left' || dir === 'right';
  if (dir === 'up') return;
  const eyeY = y + 6;
  const pts = side ? [[dir === 'right' ? x + w - 4 : x + 3, eyeY]] : [[cxh - 4, eyeY], [cxh + 2, eyeY]];
  const wideE = expr === 'afraid' || expr === 'surprised';
  for (const [ex, ey] of pts) {
    if (closed) { img.rect(ex, ey + 1, 2, 1, ink); continue; }
    if (wideE) { img.rect(ex, ey - 1, 2, 3, [250, 250, 245, 255]); img.set(ex + (side ? (dir === 'right' ? 1 : 0) : 0), ey, ink); img.set(ex + (side ? (dir === 'right' ? 1 : 0) : 0), ey + 1, ink); }
    else if (expr === 'ashamed') { img.rect(ex, ey + 1, 2, 2, ink); }
    else if (expr === 'happy') { img.set(ex, ey + 1, ink); img.set(ex + 1, ey, ink); img.set(ex + 1, ey + 1, ink); } // a small arc
    else { img.rect(ex, ey, 2, 2, ink); img.set(ex, ey, [255, 255, 255, 255]); img.set(ex, ey, ink); }
    // brows
    const by = ey - 2;
    if (expr === 'angry') { img.set(ex + (ex < cxh ? 0 : 1), by + 1, ink); img.set(ex + (ex < cxh ? 1 : 0), by, ink); img.set(ex + (ex < cxh ? 2 : -1), by, ink); }
    else if (expr === 'sad' || expr === 'afraid') { img.set(ex + (ex < cxh ? 0 : 1), by, ink); img.set(ex + (ex < cxh ? 1 : 0), by + (ex < cxh ? 0 : 0), ink); img.set(ex + (ex < cxh ? 2 : -1), by + 1, ink); }
    else if (expr === 'surprised') { img.rect(ex, by - 1, 2, 1, ink); }
    else if (expr === 'disgusted') { img.rect(ex, by + (ex < cxh ? 1 : 0), 2, 1, ink); }
    else img.rect(ex, by + 1, 2, 1, skinShadow);
  }
  // mouth
  const mx = side ? (dir === 'right' ? x + w - 5 : x + 2) : cxh - 1;
  const my = y + 10;
  switch (expr) {
    case 'happy': img.rect(mx - 1, my, 4, 1, mouthCol); img.set(mx - 2, my - 1, mouthCol); img.set(mx + 3, my - 1, mouthCol); break;
    case 'sad': img.rect(mx - 1, my, 3, 1, mouthCol); img.set(mx - 2, my + 1, mouthCol); img.set(mx + 2, my + 1, mouthCol); break;
    case 'angry': img.rect(mx - 1, my, 4, 1, mouthCol); img.set(mx - 1, my + 1, mouthCol); img.set(mx + 2, my + 1, mouthCol); break;
    case 'afraid': case 'surprised': img.rect(mx, my - 1, 2, 3, mouthCol); break;
    case 'disgusted': img.rect(mx - 1, my, 3, 1, mouthCol); img.set(mx + 2, my - 1, mouthCol); img.set(mx - 2, my + 1, mouthCol); break;
    case 'ashamed': img.rect(mx, my + 1, 2, 1, mouthCol); break;
    default: img.rect(mx - 1, my, 3, 1, mouthCol);
  }
}

/**
 * Compose one frame. spec: { build, look: { skin, hair: { style, color }, facial, eyes },
 *   garments: [{ type, state, bloodied, color, pattern, covers }], wounds: [{ part, kind, bleed, bandaged, wrapped, splinted, stitched, severity }],
 *   missing: [partIds], aids: [types], pallor (0..1), expression, carried?: Img }
 * → { img, anchor: [x, y] (feet / body centre), w, h }
 */
export function composeFrame(pal, spec, dir, pose, frameIndex = 0) {
  const t = template(spec.build ?? 'average', dir, pose, frameIndex);
  const img = new Img(t.w, t.h);
  const look = spec.look ?? {};
  const skinRamp = look.skin ?? 'skin_light';
  const rng = rngFor(`${spec.id ?? 'x'}|${dir}|${pose}`);
  const missingRegions = new Set();
  for (const p of spec.missing ?? []) for (const code of DISTAL[p] ?? PART_REGIONS[p] ?? []) missingRegions.add(code);
  const pegOn = (spec.aids ?? []).includes('peg_leg');
  const garments = [...(spec.garments ?? [])].filter((g) => g.state !== 'destroyed').sort((a, b) => (GARMENT_ORDER[a.type] ?? 3) - (GARMENT_ORDER[b.type] ?? 3));
  const at = (x, y) => (x < 0 || y < 0 || x >= t.w || y >= t.h ? 0 : t.cells[y * t.w + x]);

  // 2. skin by region, rim-lit from the top-left
  const tone = (x, y, code, own) => {
    const code_ = (xx, yy) => own(xx, yy);
    const tl = code_(x - 1, y) !== code || code_(x, y - 1) !== code;
    const br = code_(x + 1, y) !== code || code_(x, y + 1) !== code;
    return br ? 0 : tl ? 2 : 1;
  };
  const lying = Boolean(t.lying);
  for (let y = 0; y < t.h; y++) {
    for (let x = 0; x < t.w; x++) {
      const code = at(x, y);
      if (!code || missingRegions.has(code)) continue;
      const base = SKIN_REGIONS.has(code) ? skinRamp : 'linen'; // under-clothes colour for the covered parts
      img.set(x, y, pal.color(base, tone(x, y, code, at)));
    }
  }
  // arms / legs that are bare get a slightly darker far side: nothing more here; garments next
  const ownGarmentPixels = new Map(); // garment index → Set of pixel keys
  garments.forEach((g, gi) => {
    const regs = regionsOfParts(g.covers);
    const covered = new Set();
    const ramp = g.color ?? 'brown';
    const grng = rngFor(`${spec.id ?? 'x'}|${g.type}|${dir}`);
    for (let y = 0; y < t.h; y++) {
      for (let x = 0; x < t.w; x++) {
        const code = at(x, y);
        if (!code || !regs.has(code) || missingRegions.has(code)) continue;
        // hoods and caps cover the top of the head only; cloaks leave hands and feet alone (covers says so)
        if ((g.type === 'hood' || g.type === 'cap') && code === R.head && y > t.head.y + (g.type === 'cap' ? 4 : 8) - (lying ? 0 : 0)) continue;
        if (g.type === 'hood' && code === R.head && dir !== 'up' && x > t.head.x + 2 && x < t.head.x + t.head.w - 3 && y > t.head.y + 4) continue; // the face stays open
        covered.add(y * t.w + x);
      }
    }
    // a cloak is a cape: the whole back, from the front only its edges and the shoulders, from the side a strip behind
    if (g.type === 'cloak' && dir !== 'up') {
      let tx0 = 1e9; let tx1 = -1; let ty0 = 1e9; let ty1 = -1;
      for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) { const c0 = at(x, y); if (c0 === R.chest || c0 === R.abdomen) { tx0 = Math.min(tx0, x); tx1 = Math.max(tx1, x); ty0 = Math.min(ty0, y); ty1 = Math.max(ty1, y); } }
      const side = dir === 'left' || dir === 'right';
      const backLeft = dir === 'right'; // facing right, the back is on the left
      for (const k of [...covered]) {
        const x = k % t.w; const y = (k / t.w) | 0; const c0 = at(x, y);
        let keep = false;
        if (lying) keep = true;
        else if (!side) keep = ((c0 === R.chest || c0 === R.abdomen) && (x <= tx0 + 1 || x >= tx1 - 1)) || ((c0 === R.uL || c0 === R.uR) && y <= ty0 + 2) || (c0 === R.chest && y === ty0);
        else keep = (c0 === R.chest || c0 === R.abdomen || c0 === R.tL || c0 === R.tR) && (backLeft ? x <= tx0 + 2 : x >= tx1 - 2);
        if (!keep) covered.delete(k);
      }
      if (side && !lying && tx1 >= 0) {
        // the cape hangs behind the body down to the knees
        const fx = backLeft ? tx0 - 1 : tx1 + 1;
        for (let y = ty0 + 1; y <= Math.min(t.h - 6, ty1 + 9); y++) for (const xx of [fx, backLeft ? fx - 1 : fx + 1]) if (xx >= 0 && xx < t.w && !at(xx, y) && (y > ty0 + 2 || xx === fx)) covered.add(y * t.w + xx);
      }
    } else if (g.type === 'cloak' && dir === 'up' && !lying) {
      let tx0 = 1e9; let tx1 = -1; let ty1 = -1;
      for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) { const c0 = at(x, y); if (c0 === R.chest || c0 === R.abdomen) { tx0 = Math.min(tx0, x); tx1 = Math.max(tx1, x); ty1 = Math.max(ty1, y); } }
      for (let y = ty1 + 1; y <= ty1 + 8; y++) for (let x = tx0 - 1; x <= tx1 + 1; x++) if (x >= 0 && x < t.w && y < t.h - 4) covered.add(y * t.w + x); // the cape falls over the back of the legs
    }
    // wear: holes show what lies beneath
    const holeRate = g.state === 'torn' ? 0.1 : g.state === 'rags' ? 0.34 : 0;
    for (const k of covered) {
      const x = k % t.w; const y = (k / t.w) | 0;
      const own = (xx, yy) => (covered.has(yy * t.w + xx) ? 1 : 0);
      let t_ = tone(x, y, 1, (xx, yy) => own(xx, yy));
      if (g.pattern === 'striped' && y % 4 === 0) t_ = Math.max(0, t_ - 1);
      if (g.pattern === 'checked' && ((x >> 1) + (y >> 1)) % 2) t_ = Math.max(0, t_ - 1);
      if (g.state === 'worn' && grng() < 0.07) t_ = Math.min(2, t_ + 1);
      if (holeRate && grng() < holeRate) continue;
      if (g.state === 'rags' && own(x, y + 1) === 0 && grng() < 0.5) continue; // a ragged lower edge
      img.set(x, y, pal.color(ramp, t_));
    }
    if (g.pattern === 'trimmed') {
      for (const k of covered) { const x = k % t.w; const y = (k / t.w) | 0; if (!covered.has((y + 1) * t.w + x) && grng() > 0.2) img.set(x, y, pal.color('gold', 1)); }
    }
    ownGarmentPixels.set(gi, covered);
  });

  // peg leg replaces a missing lower leg
  if (pegOn) for (const [codeS, codeO] of [[R.sL, R.oL], [R.sR, R.oR]]) {
    if (!missingRegions.has(codeS)) continue;
    for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) {
      const c0 = t.cells[y * t.w + x];
      if (c0 === codeS || c0 === codeO) { const dxs = codeS === R.sL ? 1 : 0; if ((x + dxs) % 2 === 0 || true) img.set(x, y, pal.color('wood', y % 3 === 0 ? 2 : 1)); }
    }
  }

  // hair (over the head), facial hair
  if (look.hair?.style !== 'bald') {
    const hcol = look.hair?.color ?? 'hair_brown';
    const hp = hairPixels(look.hair?.style ?? 'short', dir, t.head);
    const hset = new Set(hp.map(([x, y]) => `${x},${y}`));
    for (const [x, y] of hp) {
      if (x < 0 || y < 0 || x >= t.w || y >= t.h) continue;
      const own = (xx, yy) => (hset.has(`${xx},${yy}`) ? 1 : 0);
      const covering = garments.some((g) => (g.type === 'hood' || g.type === 'cap') && g.state !== 'destroyed' && ownGarmentPixels.get(garments.indexOf(g))?.has(y * t.w + x));
      if (covering) continue;
      if (at(x, y) === R.head || at(x, y) === 0 || at(x, y) === R.neck) img.set(x, y, pal.color(hcol, tone(x, y, 1, own)));
    }
  }
  if (look.facial && look.facial !== 'none' && dir !== 'up') {
    const hc = look.hair?.color ?? 'hair_brown'; const { x, y, w } = t.head;
    const fr = (xx, yy, ww) => img.rect(xx, yy, ww, 1, pal.color(hc, 1));
    if (look.facial === 'beard') { for (let j = 8; j < 13; j++) fr(x + 2, y + j, w - 4); }
    if (look.facial === 'mustache' || look.facial === 'beard') fr(x + Math.floor(w / 2) - 3, y + 9, 6);
    if (look.facial === 'stubble') for (let j = 9; j < 12; j++) for (let i = 3; i < w - 3; i += 2) img.set(x + i, y + j, pal.color(hc, 2));
  }

  // 4. the body: injuries on the regions
  const anchorOf = (code) => {
    let sx = 0; let sy = 0; let n = 0; let bx = 1e9; let by = 1e9; let ex = -1; let ey = -1;
    for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) if (t.cells[y * t.w + x] === code) { sx += x; sy += y; n++; bx = Math.min(bx, x); by = Math.min(by, y); ex = Math.max(ex, x); ey = Math.max(ey, y); }
    return n ? { x: Math.round(sx / n), y: Math.round(sy / n), n, box: [bx, by, ex, ey] } : null;
  };
  const blood = (code, intensity) => {
    const a = anchorOf(code);
    if (!a) return;
    const r = rngFor(`${spec.id}|${code}|${dir}`);
    const cnt = Math.min(18, 3 + Math.round(intensity * 2));
    for (let i = 0; i < cnt; i++) {
      const x = a.x + Math.round((r() - 0.5) * (a.box[2] - a.box[0])); const y = a.y + Math.round((r() - 0.5) * (a.box[3] - a.box[1]));
      if (at(x, y) === code) img.set(x, y, pal.color('blood', i % 3 === 0 ? 2 : 1));
    }
  };
  const bloodied = (gi, code, intensity) => {
    const a = anchorOf(code);
    if (!a) return;
    const r = rngFor(`${spec.id}|g${gi}|${code}|${dir}`);
    const cover = ownGarmentPixels.get(gi);
    for (const k of cover ?? []) {
      const x = k % t.w; const y = (k / t.w) | 0;
      if (Math.abs(x - a.x) + Math.abs(y - a.y) <= 5 + intensity && r() < 0.55) img.set(x, y, pal.color('blood', r() < 0.5 ? 0 : 1));
    }
  };
  const exposed = (x, y) => {
    // is the topmost drawn layer at this pixel skin (no garment)? (garment pixels hide wounds under them)
    for (const set of ownGarmentPixels.values()) if (set.has(y * t.w + x)) return false;
    return true;
  };
  for (const wd of spec.wounds ?? []) {
    for (const code of PART_REGIONS[wd.part] ?? []) {
      if (missingRegions.has(code) || wd.internal) continue;
      const a = anchorOf(code);
      if (!a) continue;
      const covering = garments.findIndex((g, gi) => g.state !== 'destroyed' && regionsOfParts(g.covers).has(code) && ownGarmentPixels.get(gi)?.has(a.y * t.w + a.x));
      if (wd.bleed > 0.3) { if (covering >= 0) bloodied(covering, code, Math.min(4, wd.bleed / 20)); else blood(code, Math.min(6, wd.bleed / 12)); }
      if (covering >= 0 && !['bruise', 'burn'].includes(wd.kind)) continue;
      // marks on bare skin
      if (wd.kind === 'bruise' || wd.kind === 'crush') for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) if (t.cells[y * t.w + x] === code && exposed(x, y)) img.set(x, y, mix(img.get(x, y), [92, 80, 150, 255], 0.4));
      else if (wd.kind === 'burn') for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) if (t.cells[y * t.w + x] === code && exposed(x, y)) img.set(x, y, mix(img.get(x, y), [170, 70, 40, 255], 0.5));
      else if (wd.kind === 'scar') { for (let i = -2; i <= 2; i++) { if (at(a.x + i, a.y + (i >> 1)) === code && exposed(a.x + i, a.y + (i >> 1))) img.set(a.x + i, a.y + (i >> 1), pal.color(skinRamp, 2)); } }
      else if (wd.kind === 'cut' || wd.kind === 'puncture') { for (let i = -2; i <= 1; i++) if (at(a.x + i, a.y) === code && exposed(a.x + i, a.y)) img.set(a.x + i, a.y, pal.color('blood', 0)); }
      if (wd.bandaged) { for (let y = a.y - 1; y <= a.y + 1; y++) for (let x = 0; x < t.w; x++) if (t.cells[y * t.w + x] === code && exposed(x, y)) img.set(x, y, pal.color('linen', (x + y) % 5 === 0 ? 0 : 2)); }
      else if (wd.wrapped) { for (let y = a.y - 1; y <= a.y + 1; y++) for (let x = 0; x < t.w; x++) if (t.cells[y * t.w + x] === code && exposed(x, y)) img.set(x, y, pal.color('brown', (x * 3 + y) % 4 === 0 ? 0 : 2)); if (wd.bleed > 0.3) blood(code, 1); }
      if (wd.splinted) { for (const dy of [-2, 0, 2]) for (let x = 0; x < t.w; x++) if (t.cells[(a.y + dy) * t.w + x] === code) img.set(x, a.y + dy, pal.color('wood', 1)); }
    }
  }
  if ((spec.aids ?? []).includes('sling')) { const a = anchorOf(R.chest); if (a) for (let i = 0; i < 12; i++) img.set(a.x - 5 + i, a.y - 3 + (i >> 1), pal.color('linen', 2)); }
  if ((spec.aids ?? []).includes('eye_patch') && dir !== 'up') { const { x, y, w } = t.head; img.rect(x + Math.floor(w / 2) + 1, y + 5, 3, 3, pal.color('black', 0)); img.set(x + Math.floor(w / 2) - 2, y + 5, pal.color('black', 0)); }

  // pallor, fever, shock: the skin goes grey or flushed
  if (spec.pallor > 0.05) img.map((c, x, y) => (SKIN_REGIONS.has(at(x, y)) && exposed(x, y) ? mix(c, [150, 150, 158, 255], Math.min(0.6, spec.pallor * 0.7)) : c));
  if (spec.flush > 0.05) img.map((c, x, y) => (SKIN_REGIONS.has(at(x, y)) && exposed(x, y) ? mix(c, [200, 90, 80, 255], Math.min(0.4, spec.flush * 0.5)) : c));

  // face
  const ink = pal.color('hair_black', 0); const skinShadow = pal.color(skinRamp, 0);
  const closed = pose === 'lie' && (spec.asleep || spec.dead || spec.unconscious);
  if (!lying) expressionFace(img, dir, t.head, spec.expression ?? 'neutral', ink, skinShadow, pal.color(skinRamp, 0).map((v, i) => (i < 3 ? Math.round(v * 0.7) : 255)), false);
  else expressionFaceLying(img, t, ink, closed || spec.dead, spec.expression ?? 'neutral');

  // dead: the colour drains
  if (spec.dead) img.desaturate(0.75).tint([120, 125, 140, 255], 0.18);

  // 5. the outline in a dark shade of what is next to it
  img.outline((c) => [Math.round(c[0] * 0.45), Math.round(c[1] * 0.42), Math.round(c[2] * 0.48), 255]);
  const padded = img.padded(1);
  const anchor = lying ? [Math.round(t.w / 2) + 1, Math.round(t.h / 2) + 1] : [16 + 1, FEET_Y + 1];
  return { img: padded, anchor, w: padded.w, h: padded.h };
}

function expressionFaceLying(img, t, ink, closed, expr) {
  // the head lies on its side at the left end: two eyes (closed when asleep / out) along the face edge
  const { x, y, w, h } = t.head;
  const ex = x + Math.floor(w * 0.3);
  for (const ey of [y + Math.floor(h * 0.3), y + Math.floor(h * 0.62)]) {
    if (closed) img.rect(ex, ey, 2, 1, ink); else img.rect(ex, ey, 2, 2, ink);
  }
}

// ---------- looks ----------
const SKIN = ['skin_pale', 'skin_light', 'skin_tan', 'skin_dark'];
const HAIR = ['hair_black', 'hair_brown', 'hair_auburn', 'hair_blond', 'hair_grey'];
const STYLES_F = ['long', 'bun', 'ponytail', 'braid', 'short', 'curly'];
const STYLES_M = ['short', 'crop', 'curly', 'short', 'bald', 'ponytail'];

/** Derive a stable look from persona data (content `persona.look` wins; the appearance text nudges the rest). */
export function deriveLook(c) {
  const p = c.persona ?? {};
  const given = p.look ?? {};
  const r = rngFor(`look|${c.id}`);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const text = `${p.appearance ?? ''} ${p.occupation ?? ''}`.toLowerCase();
  const female = String(p.sex ?? '').toLowerCase().startsWith('f');
  const older = Number(p.age) >= 55 || /grey|gray|white-haired|old\b|elderly|weathered/.test(text);
  const build = given.build ?? (/broad|burly|stout|heavy|muscular|big\b/.test(text) ? 'broad' : /slim|slender|thin|wiry|lean/.test(text) ? 'slim' : /short|small|stocky/.test(text) ? 'short' : pick(['average', 'average', 'slim', 'broad']));
  return {
    build,
    skin: given.skin ?? pick(SKIN.slice(0, 3)),
    hair: { style: given.hair?.style ?? pick(female ? STYLES_F : STYLES_M), color: given.hair?.color ?? (older ? 'hair_grey' : /blond/.test(text) ? 'hair_blond' : /red|auburn|ginger/.test(text) ? 'hair_auburn' : /black|dark/.test(text) ? 'hair_black' : pick(HAIR.slice(0, 4))) },
    facial: given.facial ?? (!female && /beard|bearded|stubble|moustache|mustache/.test(text) ? (/stubble/.test(text) ? 'stubble' : 'beard') : !female && r() < 0.25 ? 'mustache' : 'none'),
    eyes: given.eyes ?? 'brown',
  };
}

// ---------- the producer ----------
const sheetCache = new Map();
const FRAMES_CACHE_MAX = 4000;

/** Hash of everything that changes how a character looks (not the expression: that is part of the frame key). */
export function appearanceKey(spec) {
  return JSON.stringify([spec.id, spec.build, spec.look, spec.garments?.map((g) => [g.type, g.state, g.bloodied, g.color, g.pattern]), spec.wounds?.map((w) => [w.part, w.kind, Math.round((w.bleed ?? 0) / 5), w.bandaged, w.wrapped, w.splinted]), spec.missing, spec.aids, Math.round((spec.pallor ?? 0) * 4), Math.round((spec.flush ?? 0) * 4), Boolean(spec.dead)]);
}

/** The sprite producer. → { frame(dir, pose, index, expression) → { img, anchor } } */
export function characterSprite(pal, spec) {
  const key = appearanceKey(spec);
  let sheet = sheetCache.get(key);
  if (!sheet) {
    sheet = new Map();
    if (sheetCache.size > FRAMES_CACHE_MAX) sheetCache.clear();
    sheetCache.set(key, sheet);
  }
  return {
    frame(dir, pose, index = 0, expression = 'neutral') {
      const poseFrames = POSES[pose] ?? 1;
      const idx = index % poseFrames;
      const d = pose === 'lie' ? (dir === 'left' ? 'left' : 'right') : dir;
      const k = `${d}|${pose}|${idx}|${pose === 'lie' || dir === 'up' ? '' : expression}`;
      let f = sheet.get(k);
      if (!f) { f = composeFrame(pal, { ...spec, expression }, d, pose, idx); sheet.set(k, f); }
      return f;
    },
  };
}
