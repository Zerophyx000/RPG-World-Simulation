// Step 9 check (client, Node): the scene layers (depth, lighting, traces, ambient, story, subjective), the director
// camera, replay, and the pure helpers of the on-map UI. Rendered with the software target; no browser, no world.
const [,, root = process.cwd()] = process.argv;
const imp = (p) => import(`file:///${root}/${p}`);
const { makePalette } = await imp('public/art/palette.js');
const { createScene } = await imp('public/art/scene.js');
const { ImgTarget } = await imp('public/art/target.js');
const { createQuality } = await imp('public/render/quality.js');
const { artContent, loadMapFiles } = await imp('server/world/maps.js');
const { TILE, buildGrid } = await imp('public/art/mapdata.js');
const { makeTiles } = await imp('public/art/tiles.js');
const { windAt, swayFor } = await imp('public/render/wind.js');
const { createDirectorCam, frameFocus } = await imp('public/render/directorcam.js');
const { createReplay } = await imp('public/render/replay.js');
const { sunAt } = await imp('public/render/lighting.js');
const ui = {
  conv: await imp('public/views/map-ui/convpanel.js'), hud: await imp('public/views/map-ui/hud.js'), toasts: await imp('public/views/map-ui/toasts.js'),
  watch: await imp('public/views/map-ui/watchlist.js'), search: await imp('public/views/map-ui/search.js'), settings: await imp('public/views/map-ui/settings.js'), replaybar: await imp('public/views/map-ui/replaybar.js'),
};
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) pass++; else fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const art = artContent(); const maps = loadMapFiles(); const pal = makePalette(art.palette);
const scene = (q = 'high') => createScene({ pal, recipes: art.recipes, maps, art, quality: createQuality(q) });
const cit = (id, location, spot, extra = {}) => ({ id, name: id[0].toUpperCase() + id.slice(1), alive: true, location, spot, activity: { type: 'idle' }, body: { status: [] }, look: { id, build: 'average', look: { skin: 'skin_light', hair: { style: 'short', color: 'hair_brown' }, facial: 'none' }, garments: [], wounds: [], missing: [], aids: [] }, ...extra });
const S0 = (extra = {}) => ({ now: 12 * 60, mapId: maps[0].id, rooms: new Map(), citizens: new Map(), objects: new Map(), objectsRev: 1, bubbles: new Map(), colorOf: () => [255, 220, 80, 255], god: true, roofMode: 'off', trueView: true, ...extra });
const shot = (sc, S, cam, frames = 3) => { const t = new ImgTarget(cam.w, cam.h); let r; for (let i = 0; i < frames; i++) r = sc.draw(t, cam, S, 1e7 + i * 50); return { t, r }; };
const sum = (img, x0 = 0, y0 = 0, w = img.w, h = img.h) => { let s = 0; for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * img.w + x) * 4; s += img.data[i] + img.data[i + 1] + img.data[i + 2]; } return s; };
const diff = (a, b) => { let n = 0; for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n++; return n; };

console.log('\n--- depth');
const grid = buildGrid(maps[0]); const tiles = makeTiles(pal);
const tav = maps[0].rooms.find((r) => r.roomId === 'tavern').footprint; // [x, y, w, h]
ok(tiles.isFrontWall(grid, tav[0] + 3, tav[1] + tav[3] - 1) && !tiles.isFrontWall(grid, tav[0] + 3, tav[1]), 'the south wall is a front wall, the north wall is not');
ok(tiles.wallFront(grid, tav[0] + 3, tav[1] + tav[3] - 1).img.h === 50, 'front walls are drawn 50 px tall');
const c1 = tiles.chunk(grid, 0, 1, 16, 0); const c2 = tiles.chunkWithWalls(grid, 0, 1, 16, 0);
ok(diff(c1, c2) > 0, 'chunks leave the front walls out (the preview keeps them)');
{
  // someone standing in the bottom row of the tavern is partly hidden by the wall in front
  // the tavern's cot spot runs along the bottom row: find someone who stands there, right behind the south wall
  const bottomRow = tav[1] + tav[3] - 2;
  let id = null; let sc = null; let S = null; let p = null;
  const cam = { x: (tav[0] + 2) * TILE, y: (bottomRow + 0.5) * TILE, zoom: 2, w: 260, h: 200 };
  for (const name of ['ann', 'bob', 'cid', 'dan', 'eve', 'fay', 'gus', 'hal']) {
    sc = scene(); S = S0({ citizens: new Map([[name, cit(name, 'tavern', 'cot')]]) });
    p = shot(sc, S, cam).r.people.get(name);
    if (p && Math.floor(p.y / TILE) === bottomRow) { id = name; break; }
  }
  ok(id && Math.floor(p.y / TILE) === bottomRow, `someone stands in the bottom row, right behind the wall (${id})`);
  const plainShot = shot(sc, S, cam).t;
  const selShot = shot(sc, { ...S, selectedId: id }, cam).t;
  ok(diff(plainShot.img, selShot.img) > 10, 'selected: an outline shows through the wall');
}

console.log('\n--- light and shadow');
ok(sunAt(7 * 60).dx < 0 && sunAt(18.5 * 60).dx > 0 && sunAt(12 * 60).len < sunAt(7 * 60).len && sunAt(2 * 60) === null, 'the sun: long shadows west in the morning, east in the evening, short at noon, none at night');
{
  const tree = (() => { for (let y = 2; y < grid.H - 2; y++) for (let x = 4; x < grid.W - 4; x++) if (grid.structure[y][x] === 'tree') return [x, y]; return null; })();
  const cam = { x: (tree[0] + 0.5) * TILE, y: (tree[1] + 0.5) * TILE, zoom: 1, w: 260, h: 160 };
  const sideDark = (q, hour) => { const { t } = shot(scene(q), S0({ now: hour * 60 }), cam); const L = sum(t.img, 40, 85, 80, 40); const R = sum(t.img, 140, 85, 80, 40); return L - R; };
  const am = sideDark('high', 7); const pm = sideDark('high', 18.5);
  ok(am < 0 && pm > 0, `a tree's shadow points west in the morning (${am}) and east in the evening (${pm})`);
  ok(Math.abs(sideDark('low', 7)) < Math.abs(am), 'low quality: no cast shadows');
}
{
  const lit = (state) => { const objects = new Map(); for (const o of JSON.parse(JSON.stringify(art.recipes)).slice(0, 0)) objects.set(o, o); objects.set('h', { id: 'h', typeId: 'hearth', roomId: 'house_greta', state, tags: [], placement: { relation: 'floor' } }); return objects; };
  const g = maps[0].rooms.find((r) => r.roomId === 'house_greta').footprint;
  const cam = { x: (g[0] + g[2] / 2) * TILE, y: (g[1] + g[3]) * TILE, zoom: 1, w: 260, h: 140 };
  const a = shot(scene(), S0({ now: 22 * 60, objects: lit('lit') }), cam).t; const b = shot(scene(), S0({ now: 22 * 60, objects: lit('cold') }), cam).t;
  ok(sum(a.img, 0, 50, 260, 40) > sum(b.img, 0, 50, 260, 40), 'at night a house with a lit hearth has glowing windows');
}

console.log('\n--- traces');
{
  const sc = scene();
  const cam = { x: 28 * TILE, y: 13 * TILE, zoom: 1, w: 320, h: 200 };
  const wear = { maps: [{ mapId: maps[0].id, w: grid.W, h: grid.H, wear: Array.from({ length: grid.W * grid.H }, (_, i) => (Math.floor(i / grid.W) === 13 ? 255 : 0)) }] };
  const a = shot(sc, S0({ wear }), cam).t; const b = shot(scene(), S0({ wear: null }), cam).t;
  ok(diff(a.img, b.img) > 500, 'worn paths appear where the wear map is high');
  const decals = ['soot', 'scorch', 'rubble', 'puddle', 'blood'].map((k, i) => ({ id: `d${i}`, mapId: maps[0].id, roomId: 'square', kind: k, x: (26 + i * 2) * TILE, y: 22 * TILE, r: 12, intensity: 1, surface: 'cobble' }));
  const cd = { x: 30 * TILE, y: 22 * TILE, zoom: 1, w: 400, h: 120 };
  ok(diff(shot(scene(), S0({ decals }), cd).t.img, shot(scene(), S0({ decals: [] }), cd).t.img) > 300, 'decals of every kind are drawn');
  const small = shot(scene(), S0({ decals: [{ ...decals[3], r: 5 }] }), cd).t; const big = shot(scene(), S0({ decals: [{ ...decals[3], r: 14 }] }), cd).t; const none = shot(scene(), S0({ decals: [] }), cd).t;
  ok(diff(small.img, none.img) < diff(big.img, none.img), 'a drying puddle is smaller');
  const rooms = new Map([['bakery', { id: 'bakery', effects: [] }]]);
  const cb = { x: 48 * TILE, y: 11 * TILE, zoom: 1, w: 320, h: 260 };
  const calm = shot(scene(), S0({ rooms }), cb).t;
  const boom = shot(scene(), S0({ rooms: new Map([['bakery', { id: 'bakery', effects: [{ id: 'fx', text: 'An explosion blew out the wall.', until: null }] }]]) }), cb).t;
  ok(diff(calm.img, boom.img) > 200, 'after a blast the clutter lies scattered and sooty');
  const tl = sc.layers.find((l) => l.id === 'traces');
  const F = { layout: sc.layout, objectPos: new Map(), S: S0() };
  const a1 = JSON.stringify(tl.clutterFor(F, 'bakery')); const a2 = JSON.stringify(createScene({ pal, recipes: art.recipes, maps, art, quality: createQuality('high') }).layers.find((l) => l.id === 'traces').clutterFor(F, 'bakery'));
  const g = sc.layout.geom('bakery');
  const spotTiles = new Set(g.room.spots.flatMap((s) => s.tiles.map(([x, y]) => `${x},${y}`)));
  ok(a1 === a2 && JSON.parse(a1).length > 0 && JSON.parse(a1).every((it) => !spotTiles.has(`${Math.floor(it.x / TILE)},${Math.floor(it.y / TILE)}`)), 'clutter: deterministic, never on a spot');
}

console.log('\n--- wind and ambient life');
const w1 = windAt('village', 0); const w2 = windAt('village', 45000);
ok(Math.abs(w1.x) <= 1 && Math.abs(w2.x) <= 1 && (w1.x !== w2.x || w1.strength !== w2.strength), 'the wind changes slowly and stays in bounds');
ok([0, 500, 1000, 1500].every((ms) => Math.abs(swayFor('tree', 3, 4, ms, { x: 1, strength: 1 })) <= 2) && swayFor('rock', 3, 4, 0, { x: 1, strength: 1 }) === 0, 'trees sway up to 2 px; rocks never');
{
  const sc = scene();
  const amb = sc.layers.find((l) => l.id === 'ambient');
  const cam = { x: 32 * TILE, y: 24 * TILE, zoom: 1, w: 640, h: 480 };
  const t = new ImgTarget(cam.w, cam.h);
  for (let i = 0; i < 100; i++) sc.draw(t, cam, S0(), 2e7 + i * 50);
  const cr = amb.creatures();
  ok(cr.some((c) => c.kind === 'bird') && cr.some((c) => c.kind === 'chicken'), `birds and chickens live in the village (${cr.length})`);
  const bird = cr.find((c) => c.kind === 'bird' && c.state !== 'flying');
  const before = amb.creatures().filter((c) => c.kind === 'bird' && c.state === 'flying').length;
  // someone walks right up to it (a fake frame with one person next to the bird)
  const F = { map: maps[0], grid, layout: sc.layout, people: new Map([['walker', { c: cit('walker', 'square', 'middle'), x: bird.x + 8, y: bird.y + 6, roomId: 'square' }]]), objectPos: new Map(), dt: 0.05, ms: 5e7, dayMin: 600, view: { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 }, inView: () => true, X: (x) => x, Y: (y) => y, z: 1, lod: false, target: t, ents: [], dropShadow() {} };
  for (let i = 0; i < 4; i++) { F.ms += 50; amb.entities(F); }
  ok(amb.creatures().filter((c) => c.kind === 'bird' && c.state === 'flying').length > before, 'a bird flies off when someone comes near');
  const low = createScene({ pal, recipes: art.recipes, maps, art, quality: createQuality('low') });
  for (let i = 0; i < 20; i++) low.draw(t, cam, S0(), 4e7 + i * 50);
  ok(low.layers.find((l) => l.id === 'ambient').creatures().length === 0, 'low quality: no ambient life');
}

console.log('\n--- story overlays and the subjective camera');
{
  const cams = { x: 31 * TILE, y: 22 * TILE, zoom: 1, w: 400, h: 220 };
  const people = new Map([['ann', cit('ann', 'square', 'west')], ['bob', cit('bob', 'square', 'east')], ['cat', cit('cat', 'square', 'south')]]);
  const social = { citizens: {}, pairs: [{ from: 'ann', to: 'bob', affinity: 0, trust: 0, anger: 6, fear: 0, affection: 0, envy: 0, jealousy: 0, beloved: null }], watching: [] };
  const god = shot(scene(), S0({ citizens: people, social }), cams).t; const plain = shot(scene(), S0({ citizens: people, social, god: false }), cams).t;
  const reddish = (img) => { let n = 0; for (let i = 0; i < img.data.length; i += 4) if (img.data[i] > 150 && img.data[i + 1] < 110 && img.data[i + 2] < 110) n++; return n; };
  ok(reddish(god.img) - reddish(plain.img) > 20, `a red tension line in god view only (${reddish(god.img) - reddish(plain.img)} px)`);
  const ev = [{ id: 1, gameTime: 12 * 60 - 60, type: 'death', actorId: 'bob', location: 'square', data: {} }, { id: 2, gameTime: 12 * 60 - 2880, type: 'death', actorId: 'cat', location: 'square', data: {} }];
  const { r } = shot(scene(), S0({ citizens: people, events: ev }), cams);
  ok(r.hits.filter((h) => h.type === 'pin').length === 2, 'event pins appear and can be clicked');
  // subjective: greta sees tomas, a stranger, one object
  const tavObj = { id: 'mug1', typeId: 'tankard', roomId: 'tavern', state: 'full', tags: [], placement: { relation: 'floor' } };
  const tavObj2 = { id: 'mug2', typeId: 'jug', roomId: 'tavern', state: 'full', tags: [], placement: { relation: 'floor' } };
  const ppl = new Map([['greta', cit('greta', 'tavern', 'table')], ['tomas', cit('tomas', 'tavern', 'counter')], ['lena', cit('lena', 'tavern', 'hearth')]]);
  const per = { citizenId: 'greta', roomId: 'tavern', senses: { blind: false, deaf: false, concussed: false, unconscious: false, asleep: false }, people: [{ id: 'tomas', label: 'Tomas', known: true, emphasis: null }, { id: 'lena', label: 'A tall thin woman', known: false, emphasis: null }], objects: ['mug1'], emphasis: { dominant: null, highlights: [] } };
  const sc = scene();
  const subj = sc.layers.find((l) => l.id === 'subjective');
  const F = { S: S0({ citizens: ppl, subjective: { id: 'greta', perception: per } }), objectPos: new Map([['mug1', { roomId: 'tavern' }], ['mug2', { roomId: 'tavern' }]]), fade: new Map(), hide: new Set(), nameOf: null, muted: null };
  subj.update(F);
  ok(F.hide.has('mug2') && !F.hide.has('mug1'), 'through her eyes: only what she perceives');
  ok(F.nameOf(ppl.get('lena')) === 'A tall thin woman' && F.nameOf(ppl.get('tomas')) === 'Tomas', 'strangers are named by how they look');
  const camt = { x: 11 * TILE, y: 18 * TILE, zoom: 1, w: 320, h: 240 };
  const objects = new Map([['mug1', tavObj], ['mug2', tavObj2]]);
  const normal = shot(scene(), S0({ citizens: ppl, objects }), camt).t;
  const blind = shot(scene(), S0({ citizens: ppl, objects, subjective: { id: 'greta', perception: { ...per, senses: { ...per.senses, blind: true } } } }), camt).t;
  ok(sum(blind.img) < sum(normal.img) * 0.25, 'blind: the screen goes nearly black');
  const out = shot(scene(), S0({ citizens: ppl, objects, subjective: { id: 'greta', perception: { ...per, senses: { ...per.senses, unconscious: true } } } }), camt).t;
  ok(sum(out.img) < sum(normal.img) * 0.05, 'unconscious: black');
  const angry = shot(scene(), S0({ citizens: ppl, objects, subjective: { id: 'greta', perception: { ...per, emphasis: { dominant: { type: 'anger', intensity: 8, target: 'tomas' }, highlights: ['tomas'] } } } }), camt).t;
  ok(sum(angry.img, 0, 0, 40, 40) < sum(normal.img, 0, 0, 40, 40) * 0.7, 'anger narrows the view (dark corners)');
  const none = shot(scene(), S0({ citizens: ppl, objects, subjective: null }), camt).t;
  ok(diff(none.img, normal.img) === 0, 'without a subjective camera nothing changes');
}

console.log('\n--- director camera');
{
  let t = 0; let focuses = [];
  const dc = createDirectorCam({ fetchJson: async () => ({ focuses }), now: () => t });
  const people = new Map([['a', { x: 100, y: 100 }], ['b', { x: 100 + 12 * TILE, y: 100 }], ['c', { x: 100 + 20 * TILE, y: 100 }]]);
  focuses = [{ kind: 'citizen', id: 'a', roomId: 'x', citizenIds: ['a'], score: 50, importance: 6, caption: 'A does a thing' }];
  dc.start(); await new Promise((r) => setTimeout(r, 5));
  let g = dc.update(0.016, {}, {}, people);
  ok(g && g.zoom === 2 && dc.caption === 'A does a thing', 'it frames the top focus with its caption');
  focuses = [{ kind: 'conversation', id: 'v', roomId: 'x', citizenIds: ['a', 'b'], score: 80, importance: 7, caption: 'A and B argue' }, focuses[0]];
  t = 4000; dc.update(0.016, {}, {}, people); await new Promise((r) => setTimeout(r, 5));
  g = dc.update(0.016, {}, {}, people);
  ok(dc.caption === 'A does a thing', 'it holds a focus 8 s');
  t = 9000; dc.update(0.016, {}, {}, people); await new Promise((r) => setTimeout(r, 5));
  g = dc.update(0.016, {}, {}, people);
  ok(dc.caption === 'A and B argue' && g.zoom === 1, 'then moves on, framing two people 12 tiles apart');
  focuses = [{ kind: 'citizen', id: 'c', roomId: 'x', citizenIds: ['c'], score: 120, importance: 10, caption: 'C is bleeding out' }, ...focuses];
  t = 12100; dc.update(0.016, {}, {}, people); await new Promise((r) => setTimeout(r, 5)); // the next poll (every 3 s), before the 8 s hold is over
  dc.update(0.016, {}, {}, people);
  ok(dc.caption === 'C is bleeding out', 'importance >= 9 cuts in at once');
  ok(frameFocus({ kind: 'conversation', citizenIds: ['a', 'c'] }, people).zoom === 0.5, 'far apart: zoom 0.5');
  dc.pause();
  ok(!dc.active && dc.update(0.016, {}, {}, people) === null, 'a manual pan pauses it');
}

console.log('\n--- replay');
{
  let clock = 0;
  const data = { from: 0, to: 20, initial: { citizens: { greta: { location: 'tavern', spot: 'table', activity: { type: 'idle' } } }, objects: { o1: { roomId: 'tavern', state: 'cold', holderId: null, placement: null } }, rooms: {} },
    events: [{ t: 10, type: 'position', citizenId: 'greta', kind: 'trip-start', fromRoom: 'tavern', toRoom: 'square', fromSpot: 'table', toSpot: 'west', minutes: 2 }, { t: 12, type: 'position', citizenId: 'greta', kind: 'trip-end', fromRoom: 'tavern', toRoom: 'square', fromSpot: 'table', toSpot: 'west' }, { t: 12.5, type: 'line', speakerId: 'greta', toId: null, text: 'Morning!', volume: 'normal' }, { t: 13, type: 'object', objectId: 'o1', after: { roomId: 'tavern', state: 'lit', holderId: null, placement: null } }] };
  const rp = createReplay({ fetchJson: async () => data, clock: () => clock });
  await rp.load(0, 20); rp.pause();
  const live = { citizens: new Map([['greta', { id: 'greta', name: 'Greta', location: 'bakery', spot: 'oven', activity: { type: 'sleeping' } }]]), objects: new Map([['o1', { id: 'o1', typeId: 'hearth', roomId: 'tavern', state: 'cold' }]]), rooms: new Map(), now: 999 };
  const at = (t) => { rp.seek(t); return rp.stateAt(live, 1000); };
  ok(at(9).citizens.get('greta').location === 'tavern', 'at 9 she is in the tavern');
  ok(at(11).citizens.get('greta').activity.type === 'moving', 'at 11 she is on the road');
  const s12 = at(12.6);
  ok(s12.citizens.get('greta').location === 'square' && s12.bubbles.get('greta')?.text === 'Morning!', 'at 12.6 she is in the square, saying her line');
  ok(at(13.5).objects.get('o1').state === 'lit', 'objects change on time');
  ok(at(9).objects.get('o1').state === 'cold' && live.citizens.get('greta').location === 'bakery', 'seeking back restores the past; the live state is untouched');
  rp.stop();
  ok(!rp.active, 'back to live');
}

console.log('\n--- on-map UI helpers');
{
  const place = ui.conv.panelPlacement({ x0: 300, y0: 200, x1: 360, y1: 260 }, { w: 300, h: 150 }, { w: 1000, h: 700 });
  const overlap = (p) => p.x < 360 && p.x + 300 > 300 && p.y < 260 && p.y + 150 > 140;
  ok(!overlap(place) && place.x >= 0 && place.y >= 0, 'the conversation panel sits beside the speakers, inside the stage');
  const right = ui.conv.panelPlacement({ x0: 900, y0: 300, x1: 960, y1: 360 }, { w: 300, h: 150 }, { w: 1000, h: 700 });
  ok(right.x + 300 <= 1000 && !(right.x < 960 && right.x + 300 > 900 && right.y < 360 && right.y + 150 > 240), 'near the right edge it moves to the left');
  const conv = { lines: [{ speakerId: 'a', toId: 'b', text: 'secret', thought: 'hm', volume: 'whisper' }, { speakerId: 'b', toId: 'a', text: 'ok', thought: 't2' }] };
  ok(ui.conv.visibleLines(conv, { god: false, selectedId: 'c' })[0].text === '…' && ui.conv.visibleLines(conv, { god: false, selectedId: 'a' })[0].text === 'secret', 'whispers are masked in plain view unless you take part');
  ok(ui.conv.visibleLines(conv, { god: false })[1].thought === null && ui.conv.visibleLines(conv, { god: true })[1].thought === 't2', 'thoughts only in god view');
  const store = { citizens: new Map([['g', { id: 'g', name: 'Greta' }]]), rooms: new Map([['r', { id: 'r', name: 'the bakery' }]]), objects: new Map([['o', { id: 'o', label: 'a flour sack', typeName: 'flour sack', roomId: 'r' }]]) };
  const hm = ui.hud.hudModel({ id: 'g', name: 'Greta', location: 'r', spot: 'oven', activity: { type: 'idle' }, needs: { hunger: 50, fatigue: 20 }, body: { vitality: 80, blood: 90, status: ['limping'], critical: 7 }, lastInnerThought: 'secret thought', emotion: { dominant: { type: 'anger', intensity: 5 } } }, store, { god: false });
  ok(hm.bars.hunger === 0.5 && hm.critical === 7 && hm.thought === null && hm.where.includes('the bakery'), 'HUD model: bars, the critical countdown, no thought in plain view');
  ok(ui.search.searchFind(ui.search.searchIndex(store), 'gre')[0]?.id === 'g' && ui.search.searchFind(ui.search.searchIndex(store), 'flour')[0]?.id === 'o', 'search finds people and things');
  ok(ui.toasts.toastFor({ type: 'walk' }, store) === null && ui.toasts.toastFor({ type: 'death', actorId: 'g', data: {} }, store)?.text.includes('Greta'), 'toasts: deaths yes, walking no');
  ok(ui.toasts.toastFor({ type: 'injury', data: { severity: 7 } }, store, { min: 9, off: [] }) === null, 'toasts respect the minimum importance');
  let list = []; for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'a']) list = ui.watch.watchAdd(list, id);
  ok(list.length === 6 && new Set(list).size === 6, 'the watch list holds 6, no duplicates');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
