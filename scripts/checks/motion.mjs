// Step 9 check: character poses and modifiers, the behaviour animator, particles. No world, no LLM.
const [,, root = process.cwd()] = process.argv;
const imp = (p) => import(`file:///${root}/${p}`);
const { makePalette } = await imp('public/art/palette.js');
const { characterSprite, POSES, portrait, turnVia } = await imp('public/art/character.js');
const { createAnimator } = await imp('public/render/animator.js');
const { createParticles } = await imp('public/render/particles.js');
const { createQuality } = await imp('public/render/quality.js');
const { ImgTarget } = await imp('public/art/target.js');
const { artContent } = await imp('server/world/maps.js');
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) pass++; else fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };
const art = artContent();
const pal = makePalette(art.palette);
const spec = { id: 'x', build: 'average', look: { skin: 'skin_light', hair: { style: 'short', color: 'hair_brown' }, facial: 'none' }, garments: [], wounds: [], missing: [], aids: [] };

console.log('\n--- character poses and modifiers');
const spr = characterSprite(pal, spec);
let empty = 0; let total = 0;
for (const b of ['average', 'slim', 'broad', 'short']) {
  const s = characterSprite(pal, { ...spec, id: `b${b}`, build: b });
  for (const d of ['down', 'up', 'left', 'right']) for (const [p, n] of Object.entries(POSES)) for (let i = 0; i < n; i++) { total++; const f = s.frame(d, p, i); if (!f.img.data.some((v, k) => k % 4 === 3 && v)) empty++; }
}
ok(empty === 0, `every build, direction, pose and frame draws (${total} frames)`);
ok(POSES.walk === 8 && POSES.run === 8 && ['kneel', 'crouch', 'hammer', 'knead', 'sweep', 'eat', 'read', 'talk', 'push', 'sitHigh'].every((p) => POSES[p]), 'walk and run have 8 frames; the working poses exist');
const same = (a, b) => a.data.length === b.data.length && a.data.every((v, i) => v === b.data[i]);
const base = spr.frame('down', 'idle', 0);
for (const m of [{ blink: true }, { look: 1 }, { headDy: 2 }, { slump: 1 }, { crossArms: true }, { fists: true }, { tilt: 1 }, { held: 'bowl' }, { held: 'broom' }]) ok(!same(spr.frame('down', 'idle', 0, 'neutral', m).img, base.img), `modifier ${JSON.stringify(m)} changes the picture`);
ok(spr.frame('down', 'idle', 0, 'neutral', { blink: true }) === spr.frame('down', 'idle', 0, 'neutral', { blink: true }), 'frames with modifiers are cached');
ok(spr.frame('down', 'nonsense', 0) === spr.frame('down', 'idle', 0), 'an unknown pose falls back to idle');
ok(portrait(pal, spec, 'happy', 2).w >= 60, 'portrait() draws a bigger head and shoulders');
ok(turnVia('left', 'right') === 'down' && turnVia('down', 'left') === null, 'turnVia gives the middle direction of a half turn');

console.log('\n--- the animator');
const quality = createQuality('high');
const person = (id, extra = {}) => ({ c: { id, name: id, alive: true, activity: { type: 'idle' }, body: { status: [] }, look: { traits: { extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.3, conscientiousness: 0.5 } }, ...extra.c }, x: extra.x ?? 100, y: extra.y ?? 100, dir: 'down', moving: false, roomId: 'smithy', inBed: false, dist: 0, legBroken: false, ...extra.p });
function run(people, S, frames, opts = {}) {
  const an = createAnimator({ quality: opts.quality ?? quality, art: { activityPoses: art.activityPoses } });
  let emits = 0; const seen = new Map();
  for (let i = 0; i < frames; i++) {
    const F = { S: { bubbles: new Map(), objects: new Map(), holding: new Set(), social: null, ...S }, ms: 1000 + i * 16, dt: 0.016, people: new Map(people.map((p) => [p.c.id, p])), objectPos: new Map(), layout: { geom: () => ({ room: { kind: 'building', doors: [{ tile: [5, 5] }] } }) }, wind: { x: 0 }, emit: () => { emits++; } };
    an.update(F);
    for (const p of people) { const a = an.of(p.c.id); const l = seen.get(p.c.id) ?? []; l.push(JSON.parse(JSON.stringify(a))); seen.set(p.c.id, l); }
  }
  return { emits, seen, an };
}
const anvil = { id: 'anv', typeId: 'anvil', tags: [] };
let r = run([person('smith', { c: { activity: { type: 'doing', detail: { description: 'hammering a horseshoe', targetId: 'anv' } } } })], { objects: new Map([['anv', anvil]]) }, 150);
ok(r.seen.get('smith').at(-1).pose === 'hammer' && r.emits > 0, `hammering at the anvil: pose hammer, sparks emitted (${r.emits})`);
r = run([person('baker', { c: { activity: { type: 'doing', detail: { description: 'kneading the dough' } } } })], {}, 10);
ok(r.seen.get('baker').at(-1).pose === 'knead', 'kneading the dough -> knead');
r = run([person('busy', { c: { activity: { type: 'doing', detail: { description: 'doing the thing' } } } })], {}, 5);
ok(r.seen.get('busy').at(-1).pose === 'work', 'an unknown do -> busy hands');
r = run([person('eater', { c: { activity: { type: 'doing', detail: { kind: 'eat', description: 'eating' } } } })], {}, 5);
ok(r.seen.get('eater').at(-1).pose === 'eat' && r.seen.get('eater').at(-1).mods?.held === 'bowl', 'eating -> eat with a bowl');
r = run([person('sleeper', { c: { activity: { type: 'sleeping' } } })], {}, 700);
ok(r.seen.get('sleeper').every((a) => a.pose === 'lie' && !a.mods?.blink), 'a sleeper lies and never blinks');
r = run([person('idler')], {}, 700);
ok(r.seen.get('idler').some((a) => a.mods?.blink), 'over 10 s an idle citizen blinks');
const a1 = run([person('calm', { c: { look: { traits: { extraversion: 0.1, neuroticism: 0.1, conscientiousness: 0.9, agreeableness: 0.5 } } } })], {}, 900).seen.get('calm').map((a) => `${a.dx},${a.dy},${a.dir}`).join('|');
const a2 = run([person('jumpy', { c: { look: { traits: { extraversion: 0.9, neuroticism: 0.9, conscientiousness: 0.2, agreeableness: 0.5 } } } })], {}, 900).seen.get('jumpy').map((a) => `${a.dx},${a.dy},${a.dir}`).join('|');
ok(a1 !== a2, 'different personalities idle differently');
const conv = (id, extra = {}) => person(id, { c: { conversationId: 'cv1', ...extra.c }, x: extra.x, p: extra.p });
const bub = new Map([['spk', { text: 'Listen.', born: 900, volume: 'normal', toId: 'fan', conversationId: 'cv1' }]]);
r = run([conv('spk', { x: 100 }), conv('fan', { x: 140, c: { look: { traits: { agreeableness: 0.9 } } } }), conv('foe', { x: 60 })], { bubbles: bub, social: { pairs: [{ from: 'foe', to: 'spk', trust: -3, affinity: -1, anger: 0 }] } }, 400);
ok(r.seen.get('fan').some((a) => a.mods?.headDy === 1) && r.seen.get('fan').some((a) => a.dir === 'left'), 'an agreeable listener faces the speaker and nods');
ok(r.seen.get('foe').some((a) => a.mods?.crossArms), 'a distrustful listener crosses the arms');
ok(r.seen.get('spk').some((a) => a.pose === 'talk'), 'the speaker gestures while the line is shown');
const wb = new Map([['spk', { text: 'psst', born: 1000, volume: 'whisper', toId: 'fan', conversationId: 'cv1' }]]);
r = run([conv('spk', { x: 100 }), conv('fan', { x: 130 })], { bubbles: wb }, 30);
ok(r.seen.get('spk').at(-1).mods?.tilt === 1 && r.seen.get('fan').at(-1).mods?.tilt === -1, 'a whisper: both lean in toward each other');
r = run([person('sad')], { social: { citizens: { sad: { emotions: [{ type: 'sadness', intensity: 7, target: null }] } } } }, 10);
ok(r.seen.get('sad').at(-1).mods?.headDy >= 1 && r.seen.get('sad').at(-1).mods?.slump, 'sadness: head down, shoulders slumped');
r = run([person('scared')], { social: { citizens: { scared: { emotions: [{ type: 'fear', intensity: 7, target: null }] } } } }, 30);
ok(new Set(r.seen.get('scared').map((a) => a.dx)).size > 1, 'fear: trembling');
r = run([person('angry')], { social: { citizens: { angry: { emotions: [{ type: 'anger', intensity: 7, target: null }] } } } }, 10);
ok(r.seen.get('angry').at(-1).mods?.fists && r.seen.get('angry').at(-1).mods?.lean === 1, 'anger: leaning in, fists');
// turning: a left-walker turns right
{
  const an = createAnimator({ quality, art: { activityPoses: art.activityPoses } });
  const p = person('turner', { p: { dir: 'left', moving: true } });
  const F = (ms) => ({ S: { bubbles: new Map(), objects: new Map(), holding: new Set() }, ms, dt: 0.016, people: new Map([['turner', p]]), objectPos: new Map(), layout: { geom: () => null }, wind: { x: 0 }, emit: () => {} });
  an.update(F(1000)); p.dir = 'right'; an.update(F(1016));
  ok(an.of('turner').dir === 'down', 'a half turn passes the middle direction');
}
r = run([person('idler2')], {}, 700, { quality: (() => { const q = createQuality('low'); q.toggle('idle', false); return q; })() });
ok(!r.seen.get('idler2').some((a) => a.mods?.blink), 'idle life off: no blinking');

console.log('\n--- particles');
const P = createParticles({ pal, quality });
const t = new ImgTarget(120, 120);
const PF = (ms) => ({ target: t, X: (x) => x, Y: (y) => y, z: 1, inView: () => true, lod: false, dt: 0.016, ms, wind: { x: 0 } });
for (let i = 0; i < 10; i++) P.emit('spark', 60, 60);
const before = t.img.data.slice();
P.overEntities(PF(0));
ok(P.count() > 0 && t.img.data.some((v, i) => v !== before[i]), `sparks are drawn (${P.count()})`);
for (let i = 1; i < 70; i++) P.overEntities(PF(i * 16));
ok(P.count() === 0, 'and gone after a second');
for (let i = 0; i < 2000; i++) P.emit('flour', 50, 50);
ok(P.count() <= quality.budget('particles'), `the budget caps them (${P.count()})`);
const PL = createParticles({ pal, quality: createQuality('low') });
PL.emit('spark', 1, 1);
ok(PL.count() === 0, 'low quality: no particles');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
