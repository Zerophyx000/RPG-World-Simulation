// Step 8: the art gallery page (/art.html): everything the renderer can draw, on one page, drawn by the same code.
import { makePalette } from './art/palette.js';
import { makeTiles, WATER_FRAMES } from './art/tiles.js';
import { makeObjects } from './art/objects.js';
import { characterSprite, DIRS, FACE_EXPRESSIONS } from './art/character.js';
import { Img } from './art/pixels.js';
import { textImg } from './art/font.js';
import { buildGrid } from './art/mapdata.js';
import { CanvasTarget } from './art/target.js';

const out = document.getElementById('out');
const [art, mapsRes] = await Promise.all([fetch('/api/art').then((r) => r.json()), fetch('/api/maps').then((r) => r.json())]);
const pal = makePalette(art.palette);
const objs = makeObjects(pal, art.recipes);
const tiles = makeTiles(pal);
out.innerHTML = '';

function section(title, note = '') {
  const h = document.createElement('h2'); h.textContent = title; out.append(h);
  if (note) { const p = document.createElement('div'); p.className = 'muted'; p.textContent = note; out.append(p); }
  const d = document.createElement('div'); d.className = 'sheet'; out.append(d);
  return d;
}
function show(parent, img, scale = 2) {
  const src = CanvasTarget.canvasOf(img);
  const cv = document.createElement('canvas'); cv.width = img.w; cv.height = img.h;
  cv.getContext('2d').drawImage(src, 0, 0);
  cv.style.width = `${img.w * scale}px`; cv.style.height = `${img.h * scale}px`;
  parent.append(cv);
}

// palette
{
  const d = section('Palette', 'Ramps of [shadow, base, highlight]; everything snaps to these.');
  for (const [name, tones] of Object.entries(art.palette.ramps)) {
    const row = document.createElement('span'); row.className = 'swatch';
    row.innerHTML = tones.map((t) => `<i style="background:${t}"></i>`).join('') + name;
    d.append(row);
  }
}
// font
{
  const d = section('Font', 'Own 5x7 bitmap font, 6x9 cell, with umlauts and accents.');
  const lines = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789 .,:;!?()[]+-=/%&', 'ÄÖÜäöüß ÀÉÈÊÇñ áéíóú - The quick brown fox'];
  for (const l of lines) show(d, textImg(l, { color: [250, 246, 236, 255], outline: [20, 18, 24, 255] }), 3);
}
// tiles
{
  const d = section('Tiles', '32x32, autotiled by neighbours; water has 4 frames.');
  const grid = buildGrid(mapsRes.maps[0]);
  show(d, tiles.chunk(grid, 1, 1, 16, 0).crop(0, 0, 512, 400), 1.5);
  const row = new Img(WATER_FRAMES * 34, 34);
  const wgrid = { ...grid, ground: grid.ground.map((r) => r.map(() => 'water')) };
  for (let f = 0; f < WATER_FRAMES; f++) row.blit(tiles.ground(wgrid, 3, 3, f), f * 34, 1);
  show(d, row, 2);
}
// characters
{
  const d = section('Characters', 'Region-coded templates tied to the body model: builds, directions, poses, expressions, clothes, wounds, aids.');
  const base = { id: 'greta', build: 'average', look: { skin: 'skin_light', hair: { style: 'bun', color: 'hair_auburn' }, facial: 'none' }, garments: [{ type: 'skirt', state: 'worn', color: 'brown', covers: ['thigh_left', 'thigh_right', 'shin_left', 'shin_right'] }, { type: 'tunic', state: 'worn', color: 'blue', pattern: 'trimmed', covers: ['torso', 'chest', 'abdomen', 'upper_arm_left', 'upper_arm_right'] }, { type: 'boots', state: 'worn', color: 'leather', covers: ['foot_left', 'foot_right'] }] };
  const sheet = new Img(32 * 14 + 8, 52 * 5 + 8);
  const put = (spr, dir, pose, i, x, y, e) => { const f = spr.frame(dir, pose, i, e); sheet.blit(f.img, x + 16 - f.anchor[0], y + 48 - f.anchor[1] + (pose === 'lie' || pose === 'crawl' ? -14 : 0)); };
  const spr = characterSprite(pal, base);
  DIRS.forEach((dir, i) => put(spr, dir, 'idle', 0, 4 + i * 34, 4));
  [0, 1, 2, 3].forEach((i) => put(spr, 'down', 'walk', i, 4 + (4 + i) * 34, 4));
  [0, 1, 2, 3].forEach((i) => put(spr, 'right', 'walk', i, 4 + (8 + i) * 34, 4));
  put(spr, 'down', 'sit', 0, 4 + 12 * 34, 4);
  [0, 1].forEach((i) => put(spr, 'down', 'work', i, 4 + i * 34, 56));
  [0, 1, 2, 3].forEach((i) => put(spr, 'down', 'carry', i, 4 + (2 + i) * 34, 56));
  put(spr, 'right', 'lie', 0, 4 + 6 * 34, 56); put(spr, 'right', 'crawl', 0, 4 + 8 * 34, 56); put(spr, 'right', 'crawl', 1, 4 + 10 * 34, 56);
  ['slim', 'average', 'broad', 'short'].forEach((b, i) => put(characterSprite(pal, { ...base, id: `b${b}`, build: b, look: { skin: ['skin_pale', 'skin_tan', 'skin_dark', 'skin_light'][i], hair: { style: ['long', 'short', 'bald', 'curly'][i], color: ['hair_blond', 'hair_black', 'hair_grey', 'hair_brown'][i] }, facial: ['none', 'beard', 'beard', 'mustache'][i] } }), 'down', 'idle', 0, 4 + i * 34, 108));
  FACE_EXPRESSIONS.forEach((e, i) => put(spr, 'down', 'idle', 0, 4 + (4 + i) * 34, 108, e));
  const wounded = { ...base, id: 'w1', wounds: [{ part: 'forearm_left', kind: 'cut', bleed: 40 }, { part: 'shin_right', kind: 'burn' }, { part: 'forearm_right', kind: 'cut', bandaged: true }] };
  put(characterSprite(pal, wounded), 'down', 'idle', 0, 4, 160);
  put(characterSprite(pal, { ...base, id: 'w2', garments: base.garments.map((g) => (g.type === 'tunic' ? { ...g, state: 'torn', bloodied: true } : g)), wounds: [{ part: 'chest', kind: 'cut', bleed: 60 }] }), 'down', 'idle', 0, 38, 160);
  put(characterSprite(pal, { ...base, id: 'w3', missing: ['shin_left', 'foot_left'], aids: ['peg_leg'], pallor: 0.8 }), 'down', 'idle', 0, 72, 160);
  put(characterSprite(pal, { ...base, id: 'w4', aids: ['sling', 'eye_patch'], wounds: [{ part: 'forearm_right', kind: 'fracture', splinted: true }] }), 'down', 'idle', 0, 106, 160);
  put(characterSprite(pal, { ...base, id: 'w5', dead: true }), 'right', 'lie', 0, 140, 160);
  put(characterSprite(pal, { ...base, id: 'w6', flush: 0.9 }), 'down', 'idle', 0, 174, 160);
  show(d, sheet, 3);
}
// objects
{
  const d = section('Objects', 'One recipe per type (content/art/objects/*.json); states add or remove shapes; tag fallback for types without a recipe.');
  const sheet = new Img(1000, 520); let x = 6; let y = 6; let rh = 0;
  for (const r of art.recipes) {
    if (r.type.startsWith('@')) continue;
    for (const st of [[], ...Object.keys(r.states ?? {}).slice(0, 4).map((s) => [s])]) {
      const s = objs.sprite(r.type, { states: st });
      if (x + s.w + 4 > 994) { x = 6; y += rh + 4; rh = 0; }
      sheet.blit(s.img, x, y);
      for (const f of s.flames) sheet.blit(objs.flame(f.w, f.h, 0), x + f.x, y + f.y);
      x += s.w + 4; rh = Math.max(rh, s.h);
    }
  }
  show(d, sheet.crop(0, 0, 1000, y + rh + 8), 2);
}
// effects
{
  const d = section('Effects', 'Fire (4 frames) here; smoke, rubble, bloodstains, the blast flash, rain and the night tint are drawn live on the map.');
  const row = new Img(4 * 44, 44);
  for (let f = 0; f < 4; f++) row.blit(objs.flame(32, 40, f), f * 44 + 6, 2);
  show(d, row, 3);
}
