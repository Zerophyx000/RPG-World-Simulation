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
export const POSES = { idle: 2, walk: 8, run: 8, sit: 1, sitHigh: 1, lie: 1, crawl: 2, work: 2, carry: 8, kneel: 1, crouch: 2, hammer: 3, knead: 2, sweep: 2, eat: 2, read: 1, talk: 3, push: 1 };

/** step 9: the intermediate direction for a 180-degree turn (or null). */
export function turnVia(from, to) {
  if ((from === 'left' && to === 'right') || (from === 'right' && to === 'left')) return 'down';
  if ((from === 'up' && to === 'down') || (from === 'down' && to === 'up')) return 'left';
  return null;
}

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
// step 9: 8-frame walk and run cycles; working poses (hammer, knead, sweep, eat, read, kneel, crouch), talking gestures,
// a shout (push) and sitting on a high bench (sitHigh). `geo` carries the shape modifiers that change the template
// (headDy, slump, lean, crossArms, tilt); the purely colour ones (blink, look, fists, sway, held) are applied later.
const WALK8 = [0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5];
const SITTING = new Set(['sit', 'sitHigh', 'eat', 'read']);

/** Parts of one frame as drawable rects: { code, x, y, w, h } in painter's order (later paints over earlier). */
function skeleton(build, dir, pose, frame, geo = {}) {
  const B = BUILDS[build] ?? BUILDS.average;
  const side = dir === 'left' || dir === 'right';
  const tw = side ? Math.max(9, Math.round(B.torsoW * 0.8)) : B.torsoW; // seen from the side the body is a little narrower, not a stick
  const cx = 16;
  const ls = B.legShort;
  const moving = pose === 'walk' || pose === 'run' || pose === 'carry';
  const phase = moving ? WALK8[frame % 8] : 0;                 // the stride: -1 .. 1
  const amp = pose === 'run' ? 1.6 : 1;
  const bob = pose === 'run' ? (frame % 4 === 2 ? -2 : -1) : moving ? (frame % 4 === 2 ? -1 : 0) : pose === 'idle' ? (frame % 2 ? -1 : 0) : 0;
  let top = 0;                                              // extra drop of the upper body (sitting, kneeling, crouching)
  let thighH = 7; let footLift = 0;
  const footH = 3;
  const parts = [];
  const add = (code, x, y, w, h) => { if (w > 0 && h > 0) parts.push({ code, x: Math.round(x), y: Math.round(y), w, h }); };

  if (SITTING.has(pose)) { top = 7; thighH = 4; }
  if (pose === 'sitHigh') footLift = 3;                     // feet dangling above the floor
  if (pose === 'kneel') { top = 9; thighH = 4; }
  if (pose === 'crouch') { top = 7; thighH = 4; }
  const lean = side ? (geo.lean ?? 0) + (pose === 'run' ? 1 : 0) : 0;
  const headDy = geo.headDy ?? 0;
  const slump = geo.slump ? 1 : 0;
  const tilt = geo.tilt ?? 0;
  const headY = 2 + ls + top + bob + headDy; const headH = B.headH;
  const neckY = 2 + ls + top + bob + headH; const chestY = neckY + 2; const absY = chestY + 7; const hipY = absY + 6;
  const legTop = SITTING.has(pose) ? hipY - 1 : hipY;
  const thighY = legTop; const shinY = thighY + thighH; const footY = FEET_Y - footH + 1 - footLift;
  const shinHeff = footY - shinY;
  const lw = B.legW; const aw = B.armW;
  const swing = moving ? phase : 0;

  const leg = (sideSign, off, code3) => {
    // sideSign: -1 left of the figure (anatomical right in front view), +1 right
    const wide = pose === 'push' ? sideSign : 0;            // a shout plants the feet apart
    const x = (side ? cx - Math.floor(lw / 2) : cx + (sideSign > 0 ? 1 : -lw - 1)) + wide;
    if (pose === 'kneel') {
      // one knee down: the near leg folded under, the far one bent with the foot forward
      if (side) {
        add(code3[0], x + (sideSign > 0 ? 2 : -1), thighY, lw, thighH);
        add(code3[1], x + (sideSign > 0 ? -3 : 1), shinY, sideSign > 0 ? lw + 3 : lw, sideSign > 0 ? 3 : Math.max(2, FEET_Y - shinY - 2));
        add(code3[2], x + (sideSign > 0 ? -4 : 2), sideSign > 0 ? shinY + 1 : footY, lw, footH);
      } else {
        add(code3[0], x, thighY, lw, thighH);
        add(code3[1], x, shinY, lw, sideSign > 0 ? 3 : Math.max(2, FEET_Y - shinY - 2));
        add(code3[2], x, sideSign > 0 ? shinY + 2 : footY, lw + 1, footH);
      }
      return;
    }
    if (side) {
      // a stride: the legs swing forward and back, both feet stay on the baseline
      const dx = Math.round(off * 3 * amp);
      add(code3[0], x + Math.round(dx * 0.5), thighY, lw, thighH);
      add(code3[1], x + dx, shinY, lw, shinHeff);
      add(code3[2], x + dx + 1, footY, lw + 1, footH);
    } else {
      // front / back: the stepping leg lifts its foot (never drops below the baseline: that read as a glitch)
      const lift = off > 0 ? Math.round(off * 2 * amp) : 0;
      add(code3[0], x, thighY, lw, thighH);
      add(code3[1], x, shinY, lw, Math.max(2, shinHeff - lift));
      add(code3[2], x, footY - lift, lw + 1, footH);
    }
  };
  // far leg first, so the near leg paints over it
  if (side) { leg(-1, -swing, [R.tR, R.sR, R.oR]); leg(+1, swing, [R.tL, R.sL, R.oL]); } else { leg(+1, swing, [R.tL, R.sL, R.oL]); leg(-1, -swing, [R.tR, R.sR, R.oR]); }

  // torso (slumped shoulders: the chest starts 1 px lower and is 1 px narrower at the top)
  const ux0 = lean; // the upper body leans forward in side views
  const torso = () => {
    add(R.abdomen, cx - tw / 2 + Math.round(lean / 2), absY, tw, 6);
    add(R.chest, cx - tw / 2 + ux0 + (slump && !side ? 0.5 : 0), chestY + slump, tw - (slump && !side ? 1 : 0), 7 - slump);
  };

  // arms: { upper, fore, hand } along the side of the torso; swing / raise per pose
  const arm = (sideSign, sw) => {
    const isL = sideSign > 0; // anatomical left = viewer's right (front view)
    const ux = (side ? cx - aw / 2 + (isL ? 1 : -1) : cx + (sideSign > 0 ? tw / 2 : -tw / 2 - aw)) + ux0;
    const codes = isL ? [R.uL, R.fL, R.kL] : [R.uR, R.fR, R.kR];
    const sy = chestY + 1 + slump;
    const fwd = side ? 3 : 0;          // "in front of the body" in side views
    const inward = side ? 0 : (isL ? -2 : 2);
    let upperY = sy; let foreY = sy + 6; let handY = foreY + 5; let foreX = ux; let handX = ux; let fh = 5; const uh = 6;
    let fw = aw; let hidden = false;
    const f = frame;
    if (geo.crossArms && !moving) {
      if (dir === 'down') { foreY = sy + 5; fh = 3; fw = tw - 2; foreX = cx - tw / 2 + 1 + ux0; handX = isL ? cx - tw / 2 - 1 : cx + tw / 2 - aw + 1; handY = sy + 5; }
      else hidden = true; // behind the body
    } else if (pose === 'work') {
      const up = (f % 2 === 0) === isL;
      foreY = sy + 4; fh = 4; handY = up ? sy - 1 : sy + 5; foreX = ux + fwd; handX = foreX;
    } else if (pose === 'carry') {
      foreY = sy + 4; fh = 4; handY = sy + 6; foreX = ux + (side ? 3 : isL ? -1 : 1); handX = foreX + (isL ? -1 : 1);
    } else if (pose === 'hammer') {
      // the near (left) arm swings the hammer: raised, mid, impact; the other steadies the work
      if (isL) {
        const stage = f % 3;
        if (stage === 0) { foreY = sy - 5; fh = 5; handY = sy - 8; foreX = ux + (side ? 1 : 1); handX = foreX; }
        else if (stage === 1) { foreY = sy; fh = 4; handY = sy + 1; foreX = ux + fwd + 1; handX = foreX + 1; }
        else { foreY = sy + 4; fh = 4; handY = sy + 8; foreX = ux + fwd + 2; handX = foreX + 1; }
      } else { foreY = sy + 4; fh = 4; handY = sy + 8; foreX = ux + fwd + inward; handX = foreX; }
    } else if (pose === 'knead') {
      const push = f % 2;
      foreY = sy + 4; fh = 4; handY = sy + 7 + push * 2; foreX = ux + fwd + inward + (side ? push : 0); handX = foreX + (side ? 1 : 0);
    } else if (pose === 'sweep') {
      const toLeft = f % 2 === 0;
      foreY = sy + 5; fh = 5; handY = sy + 10; foreX = ux + (side ? (toLeft ? 2 : 4) : (toLeft ? -2 : 2)); handX = foreX;
    } else if (pose === 'eat') {
      if (isL && f % 2 === 0) { foreY = sy + 1; fh = 4; handY = headY + 9; foreX = ux + fwd + inward * 2; handX = cx + (side ? 4 : 0) + ux0 - 1; }
      else { foreY = sy + 4; fh = 4; handY = sy + 7; foreX = ux + fwd + inward; handX = foreX; }
    } else if (pose === 'read') {
      foreY = sy + 3; fh = 4; handY = sy + 5; foreX = ux + fwd + inward * 1.5; handX = foreX + (side ? 1 : inward);
    } else if (pose === 'talk') {
      const g = f % 3;
      const raised = (g === 0 && isL) || (g === 2 && !isL) || g === 1;
      if (raised) { foreY = sy + 2; fh = 4; handY = g === 1 ? sy + 3 : sy; foreX = ux + fwd + (side ? 0 : (isL ? 1 : -1)); handX = foreX + (side ? 1 : (isL ? 1 : -1)); }
    } else if (pose === 'push') {
      foreY = sy + 1; fh = 4; handY = sy; foreX = ux + (side ? 4 : (isL ? 3 : -3)); handX = foreX + (side ? 2 : (isL ? 2 : -2));
    } else if (pose === 'kneel' || pose === 'crouch') {
      const rummage = pose === 'crouch' ? (f % 2 === 0) === isL : false;
      foreY = sy + 4; fh = 4; handY = sy + 8 + (rummage ? 2 : 0); foreX = ux + fwd + 1 + inward; handX = foreX + (side ? 1 : 0);
    } else if (moving || pose === 'idle') {
      const k = pose === 'run' ? 2 : 1;
      const dy = side ? 0 : sw * 2 * k * (isL ? 1 : -1);
      foreY += Math.round(dy / 2); handY += Math.round(dy);
      if (side) { foreX = ux + Math.round(sw * 2 * k) * (isL ? 1 : -1); handX = foreX + Math.round(sw * k) * (isL ? 1 : -1); }
    } else if (SITTING.has(pose)) {
      handY = foreY + 3;
    }
    const out = [{ code: codes[0], x: ux, y: upperY, w: aw, h: uh }];
    if (!hidden) out.push({ code: codes[1], x: foreX, y: foreY, w: fw, h: fh }, { code: codes[2], x: handX, y: handY, w: aw, h: 3 });
    return out;
  };
  // far arm first in side views (it sits behind the torso), then torso, then near arm
  if (side) {
    for (const p of arm(-1, -swing)) add(p.code, p.x, p.y, p.w, p.h);
    torso();
    for (const p of arm(+1, swing)) add(p.code, p.x, p.y, p.w, p.h);
  } else {
    torso();
    const crossed = geo.crossArms && dir === 'down' && !moving;
    // crossed arms: the forearms lie over the chest, drawn after both upper arms
    const a1 = arm(+1, swing); const a2 = arm(-1, -swing);
    if (crossed) { add(a1[0].code, a1[0].x, a1[0].y, a1[0].w, a1[0].h); add(a2[0].code, a2[0].x, a2[0].y, a2[0].w, a2[0].h); for (const p of [...a1.slice(1), ...a2.slice(1)]) add(p.code, p.x, p.y, p.w, p.h); }
    else for (const p of [...a1, ...a2]) add(p.code, p.x, p.y, p.w, p.h);
  }

  // neck and head (lowered for a nod or in sadness; shifted for a head tilt)
  const hx = cx + lean + (side ? Math.sign(lean) : 0) + tilt;
  add(R.neck, hx - 2, neckY + Math.min(1, headDy), 4, Math.max(1, 2 - Math.min(1, headDy)));
  const hw = side ? B.headW - 1 : B.headW;
  add(R.head, hx - hw / 2, headY, hw, headH);
  return { parts, head: { x: Math.round(hx - hw / 2), y: headY, w: hw, h: headH }, B, tw };
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
export function template(build, dir, pose, frame = 0, geo = null) {
  const gk = geo ? `${geo.headDy | 0}${geo.slump ? 1 : 0}${geo.lean | 0}${geo.crossArms ? 1 : 0}${geo.tilt | 0}` : '';
  const key = `${build}|${dir}|${pose}|${frame}|${gk}`;
  let t = templateCache.get(key);
  if (t) return t;
  if (dir === 'left') {
    const r = template(build, 'right', pose, frame, geo);
    const cells = new Uint8Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) cells[y * r.w + (r.w - 1 - x)] = r.cells[y * r.w + x];
    t = { w: r.w, h: r.h, cells, head: { ...r.head, x: r.w - r.head.x - r.head.w }, mirrored: true, base: r };
  } else if (pose === 'lie' || pose === 'crawl') {
    const src = template(build, 'down', pose === 'lie' ? 'idle' : 'walk', pose === 'lie' ? 0 : (frame % 2 ? 6 : 2));
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
    const sk = skeleton(build, dir, pose, frame, geo ?? {});
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

function expressionFace(img, dir, head, expr, ink, skinShadow, mouthCol, closed = false, look = 0) {
  const { x, y, w } = head;
  const cxh = x + Math.floor(w / 2);
  const side = dir === 'left' || dir === 'right';
  if (dir === 'up') return;
  const eyeY = y + 6;
  const lk = side ? 0 : Math.max(-1, Math.min(1, look | 0)); // step 9: a glance moves the eyes
  const pts = side ? [[dir === 'right' ? x + w - 4 : x + 3, eyeY]] : [[cxh - 4 + lk, eyeY], [cxh + 2 + lk, eyeY]];
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
export function composeFrame(pal, spec, dir, pose, frameIndex = 0, mods = null) {
  const geo = mods && (mods.headDy || mods.slump || mods.lean || mods.crossArms || mods.tilt) ? { headDy: Math.max(0, Math.min(2, mods.headDy | 0)), slump: Boolean(mods.slump), lean: Math.max(-2, Math.min(2, mods.lean | 0)), crossArms: Boolean(mods.crossArms), tilt: Math.max(-1, Math.min(1, mods.tilt | 0)) } : null;
  const t = template(spec.build ?? 'average', dir, pose, frameIndex, geo);
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
  if (!lying) expressionFace(img, dir, t.head, spec.expression ?? 'neutral', ink, skinShadow, pal.color(skinRamp, 0).map((v, i) => (i < 3 ? Math.round(v * 0.7) : 255)), Boolean(mods?.blink) || Boolean(spec.asleep && pose !== 'lie'), mods?.look ?? 0);

  // step 9: colour-level modifiers: clenched fists, a trailing cape and hair, things in the hands
  if (mods && !lying) applyMods(img, t, pal, spec, mods, dir, pose, garments, ownGarmentPixels, skinRamp);
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
    frame(dir, pose, index = 0, expression = 'neutral', mods = null) {
      if (!POSES[pose]) pose = 'idle';
      const poseFrames = POSES[pose];
      const idx = ((index % poseFrames) + poseFrames) % poseFrames;
      const d = pose === 'lie' ? (dir === 'left' ? 'left' : 'right') : dir;
      const mk = modsKey(mods);
      const k = `${d}|${pose}|${idx}|${pose === 'lie' || dir === 'up' ? '' : expression}|${mk}`;
      let f = sheet.get(k);
      if (!f) {
        if (sheet.size > 600) sheet.clear(); // many modifier combinations: keep each sheet bounded
        f = composeFrame(pal, { ...spec, expression }, d, pose, idx, mk ? mods : null); sheet.set(k, f);
      }
      return f;
    },
  };
}

// ---------- step 9: modifiers, portraits ----------
/** A stable key for the modifiers that change pixels ('' when none). */
function modsKey(m) {
  if (!m) return '';
  const k = `${m.blink ? 'b' : ''}${m.look ? `l${m.look}` : ''}${m.headDy ? `h${m.headDy}` : ''}${m.slump ? 's' : ''}${m.lean ? `n${m.lean}` : ''}${m.fists ? 'f' : ''}${m.crossArms ? 'x' : ''}${m.sway ? `w${m.sway}` : ''}${m.tilt ? `t${m.tilt}` : ''}${m.held ? `H${m.held}` : ''}`;
  return k;
}

function applyMods(img, t, pal, spec, mods, dir, pose, garments, ownGarmentPixels, skinRamp) {
  const at = (x, y) => (x < 0 || y < 0 || x >= t.w || y >= t.h ? 0 : t.cells[y * t.w + x]);
  // clenched fists: the hands darker and squarer
  if (mods.fists) for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) { const c = at(x, y); if ((c === R.kL || c === R.kR) && img.alphaAt(x, y)) img.set(x, y, pal.color(skinRamp, 0)); }
  // a trailing cape / long hair: a copy shifted by the sway, only onto empty pixels (the tail flows behind)
  const sway = Math.max(-2, Math.min(2, mods.sway | 0));
  if (sway) {
    const shoulder = t.head.y + t.head.h;
    const keys = [];
    garments.forEach((g, gi) => { if (g.type === 'cloak') for (const k of ownGarmentPixels.get(gi) ?? []) keys.push(k); });
    for (let y = shoulder; y < t.h; y++) for (let x = 0; x < t.w; x++) if (!at(x, y) && img.alphaAt(x, y)) keys.push(y * t.w + x); // hair hanging outside the body
    const moves = [];
    for (const k of keys) { const x = k % t.w; const y = (k / t.w) | 0; if (y < shoulder) continue; const c = img.get(x, y); if (c && c[3]) moves.push([x + sway, y, c]); }
    for (const [x, y, c] of moves) if (!img.alphaAt(x, y)) img.set(x, y, c);
  }
  // things in the hands
  if (mods.held) {
    const anchor = (code) => { let sx = 0; let sy = 0; let n = 0; for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) if (at(x, y) === code) { sx += x; sy += y; n++; } return n ? [Math.round(sx / n), Math.round(sy / n)] : null; };
    const hand = anchor(R.kL) ?? anchor(R.kR);
    if (hand) {
      const [hx, hy] = hand;
      const c = (r, tn) => pal.color(r, tn);
      switch (mods.held) {
        case 'bowl': img.ellipse(hx - 3, hy - 1, 7, 4, c('wood', 1)); img.rect(hx - 2, hy - 1, 5, 1, c('flour', 1)); break;
        case 'spoon': img.line(hx, hy, hx + 1, hy - 4, c('iron', 2)); break;
        case 'cup': img.rect(hx - 1, hy - 3, 3, 4, c('wood', 1)); img.rect(hx - 1, hy - 3, 3, 1, c('wood', 2)); break;
        case 'book': img.rect(hx - 2, hy - 2, 5, 4, c('leather', 1)); img.rect(hx - 1, hy - 2, 3, 1, c('linen', 2)); break;
        case 'paper': img.rect(hx - 2, hy - 3, 4, 5, c('linen', 2)); img.set(hx - 1, hy - 1, c('linen', 0)); break;
        case 'hammer': img.line(hx, hy, hx, hy - 5, c('wood', 1)); img.rect(hx - 2, hy - 7, 5, 2, c('iron', 1)); break;
        case 'broom': {
          const bx = hx + 2;
          img.line(bx, hy - 3, bx + (pose === 'sweep' ? 3 : 1), FEET_Y - 2, c('wood', 1));
          img.rect(bx + (pose === 'sweep' ? 1 : -1), FEET_Y - 3, 5, 3, c('straw', 1));
          break;
        }
        default: break;
      }
    }
  }
}

const portraitCache = new Map();
/** step 9: head and shoulders of a character, upscaled (watch list now, a dialogue box later). */
export function portrait(pal, spec, expression = 'neutral', scale = 3) {
  const key = `${appearanceKey(spec)}|${expression}|${scale}`;
  let img = portraitCache.get(key);
  if (img) return img;
  if (portraitCache.size > 200) portraitCache.clear();
  const f = characterSprite(pal, spec).frame('down', 'idle', 0, expression);
  img = f.img.crop(0, 0, f.img.w, 24).scale(scale);
  portraitCache.set(key, img);
  return img;
}
