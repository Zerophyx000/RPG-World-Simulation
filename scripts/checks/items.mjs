// Step 10 check: items in motion (visual only, no browser, no LLM). Every kind of item has a motion and a material; what
// is held shows in the hand; a chop really travels through its arc (wound back, over, down); a thrust differs from a
// chop; the motion table covers every weapon and light. node --disable-warning=ExperimentalWarning scripts/checks/items.mjs .
import fs from 'node:fs';
import path from 'node:path';
const [,, rootArg = process.cwd()] = process.argv;
const root = path.resolve(rootArg).split(path.sep).join('/');
const imp = (p) => import(`file:///${root}/${p}`);
const { makePalette } = await imp('public/art/palette.js');
const { characterSprite } = await imp('public/art/character.js');
const { motionOf } = await imp('public/art/itemmotion.js');
const { createItems } = await imp('public/render/items.js');
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) pass++; else fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const read = (f) => JSON.parse(fs.readFileSync(`${root}/${f}`, 'utf8'));
const table = read('content/art/item-motions.json');
const types = read('content/object-types.json');
const pal = makePalette(read('content/art/palette.json'));
const spec = { build: 'broad', look: { skin: 'skin_light', hair: { style: 'short', color: 'hair_grey' } } };
const sp = characterSprite(pal, spec);
const pixels = (img) => { let n = 0; for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (img.alphaAt(x, y)) n++; return n; };
const same = (a, b) => { if (a.w !== b.w || a.h !== b.h) return false; for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false; return true; };

console.log('\n--- the motion table');
const weapons = types.filter((t) => t.weapon || (t.tags ?? []).some((x) => ['weapon', 'blade', 'heavy'].includes(x)));
ok(weapons.every((t) => ['heavy', 'blade', 'light'].includes(motionOf(table, { typeId: t.id, tags: t.tags }).class)), `every weapon and heavy tool has a striking motion (${weapons.map((t) => `${t.id}:${motionOf(table, { typeId: t.id, tags: t.tags }).class}`).join(' ')})`);
ok(motionOf(table, { typeId: 'axe' }).cls.strike === 'chop' && motionOf(table, { typeId: 'sword' }).cls.strike === 'thrust' && motionOf(table, { typeId: 'club' }).cls.strike === 'swing', 'an axe chops, a sword thrusts, a club swings');
ok(motionOf(table, { typeId: 'bottle' }).mat.break === 'shards' && motionOf(table, { typeId: 'flour_sack' }).mat.burn === 'flash' && motionOf(table, { typeId: 'hammer' }).mat.hit === 'spark' && motionOf(table, { typeId: 'stool' }).mat.break === 'splinter', 'materials: glass shatters, flour flashes, iron sparks, wood splinters');
ok(['torch', 'lantern', 'candle'].every((id) => motionOf(table, { typeId: id }).class === 'light_source'), 'lights are carried as lights');
ok(motionOf(table, { typeId: 'unknown_thing', tags: ['blade'] }).class === 'blade' && motionOf(table, { typeId: 'x', tags: [] }).material === 'wood', 'unlisted types fall back by tag');

console.log('\n--- in the hand');
const bare = sp.frame('right', 'idle', 0, 'neutral', null).img;
for (const h of ['axe', 'hammer', 'sword', 'knife', 'club', 'bar', 'spade', 'torch', 'lantern', 'bucket', 'bottle', 'jug', 'stool', 'rope', 'cloth', 'candle']) {
  const img = sp.frame('right', 'idle', 0, 'neutral', { held: h }).img;
  if (same(img, bare) && pixels(img) <= pixels(bare)) ok(false, `${h} shows in the hand`); // small things are drawn over the body: different pixels, not more
}
ok(true, 'every held drawing shows in the hand (16 kinds)');
const chop = [0, 1, 2, 3].map((i) => sp.frame('right', 'hammer', Math.min(2, i), 'neutral', { held: 'axe', swing: `chop${i}` }).img);
ok(chop.every((a, i) => chop.every((b, j) => i === j || !same(a, b))), 'an axe chop: four different frames (wound back, over, down, follow-through)');
const thrust = [0, 1].map((i) => sp.frame('right', 'push', 0, 'neutral', { held: 'sword', swing: `thrust${i}` }).img);
ok(!same(thrust[0], thrust[1]) && !same(thrust[1], chop[2]), 'a sword thrust: drawn back, then straight out');
const left = sp.frame('left', 'hammer', 2, 'neutral', { held: 'axe', swing: 'chop2' }).img;
ok(!same(left, chop[2]), 'facing left, the swing is mirrored');

console.log('\n--- items layer: flights, shakes, barricades');
{
  const emitted = [];
  const layer = createItems({ art: { itemMotions: table }, quality: { get: () => true } });
  const sprite = { img: { w: 8, h: 12 }, ax: 4, ay: 11, w: 8, h: 12 };
  const mkF = (ms, objects, people) => ({
    S: { objects, now: 100, altercations: [{ exchanges: [{ action: 'throw_at', actor: 'tomas', target: 'jonas', hit: true, at: 100 }] }] }, ms,
    objectPos: new Map([...objects.values()].filter((o) => o.roomId).map((o) => [o.id, { o, x: 200, y: 200, sprite, roomId: 'tavern' }])),
    people: new Map(Object.entries(people)), hide: new Set(), ents: [], emit: (k) => emitted.push(k), inView: () => true, dropShadow: () => {}, target: { blit: () => {} }, X: (x) => x, Y: (y) => y, z: 1,
  });
  const people = { tomas: { x: 100, y: 200 }, jonas: { x: 200, y: 200 } };
  let F = mkF(0, new Map([['b', { id: 'b', typeId: 'bottle', holderId: 'tomas', roomId: null, state: 'full', data: {} }]]), people);
  layer.ground(F); layer.entities(F);
  F = mkF(16, new Map([['b', { id: 'b', typeId: 'bottle', holderId: null, roomId: 'tavern', state: 'broken', data: {} }]]), people);
  layer.ground(F);
  ok(F.hide.has('b') && F.ents.some((e) => String(e.id).startsWith('flight-b')), 'a thrown bottle flies (hidden where it lands until it gets there)');
  F = mkF(600, new Map([['b', { id: 'b', typeId: 'bottle', holderId: null, roomId: 'tavern', state: 'broken', data: {} }]]), people);
  layer.ground(F);
  ok(!F.hide.has('b') && emitted.includes('shards'), `it lands in glass shards (${[...new Set(emitted)].join(', ')})`);
  // a door gets a table pushed against it: the table slides there and stays
  const door = { id: 'd', typeId: 'door', roomId: 'tavern', state: 'closed', data: {} };
  const table1 = { id: 't', typeId: 'table', roomId: 'tavern', state: 'standing', data: {} };
  const posF = (ms, tableData, tx) => {
    const objects = new Map([['d', door], ['t', { ...table1, data: tableData }]]);
    const f = mkF(ms, objects, people);
    f.objectPos.set('d', { o: door, x: 400, y: 100, sprite, roomId: 'tavern', wall: true });
    f.objectPos.set('t', { o: objects.get('t'), x: tx, y: 300, sprite, roomId: 'tavern' });
    return f;
  };
  F = posF(1000, {}, 300); layer.ground(F);
  F = posF(1016, { barricade: 'd' }, 300); layer.ground(F);
  const mid = { ...F.objectPos.get('t') };
  F = posF(3000, { barricade: 'd' }, 300); layer.ground(F);
  const end = F.objectPos.get('t');
  ok(mid.x < 400 && end.x === 400 && end.y > 100, `pushed against the door it slides there and stays (${Math.round(mid.x)} → ${end.x},${Math.round(end.y)})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
