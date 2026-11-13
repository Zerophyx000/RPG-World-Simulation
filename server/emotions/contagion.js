// Emotional contagion (step 6, §5.3). Per room with 2+ awake citizens, every 10 game minutes:
// each expresser A with expressed intensity >= 4 of a contagious type nudges every other awake citizen B:
//
//   Δ = rate[type] × (expressed − 3) × susceptibility(B) × closeness(B→A) × crowd
//   susceptibility(B) = 0.5 + 0.5·agreeableness + 0.5·neuroticism − 0.3·composure(B)   (0.2..1.2)
//   closeness(B→A)    = 0.6 + 0.1 · max(0, affinity(B→A))
//   crowd             = 1 + 0.25 · (expressers of the same type − 1)                    (max 2)
//
// If A's feeling is aimed at T and B knows T, B's is aimed at T too (a mob forming); otherwise it is diffuse.
// Caps: +2 per type per citizen per game hour from contagion, never above 7 from contagion alone.
// A stimulus only when it crosses a band boundary (4 or 7).
import { ref } from '../memory/index.js';

const EXPRESS_MIN = 4;
const HOURLY_CAP = 2;
const CONTAGION_MAX = 7;

const WORDS = {
  fear: ['The fear in the room is getting to you.', 'The panic in the room has hold of you now.'],
  anger: ['The anger in the room is getting to you.', 'The fury in the room has swept you up.'],
  joy: ['The good cheer in the room is catching.', 'You are swept up in the general delight.'],
  sadness: ['The sorrow in the room weighs on you too.', 'The grief in the room has become your own.'],
  disgust: ['You find your own lip curling along with the others.', 'The revulsion in the room has become your own.'],
};

export function runContagion(world, emo) {
  const now = world.now;
  const byRoom = new Map();
  for (const c of world.citizens.values()) {
    if (!c.alive || !c.location || c.activity.type === 'sleeping' || c.activity.type === 'collapsed') continue;
    byRoom.set(c.location, [...(byRoom.get(c.location) ?? []), c]);
  }
  for (const [roomId, list] of byRoom) {
    if (list.length < 2) continue;
    // who is showing what
    const shows = [];
    for (const a of list) {
      for (const e of emo.of(a)) {
        const rate = emo.types[e.type]?.contagion ?? 0;
        if (!rate) continue;
        const x = emo.expressed(a, e);
        if (x >= EXPRESS_MIN) shows.push({ a, e, x, rate });
      }
    }
    if (!shows.length) continue;
    const count = new Map();
    for (const s of shows) count.set(s.e.type, new Set([...(count.get(s.e.type) ?? []), s.a.id]));

    for (const b of list) {
      const t = b.persona?.traits ?? {};
      const susceptibility = clamp(0.5 + 0.5 * (t.agreeableness ?? 0.5) + 0.5 * (t.neuroticism ?? 0.5) - 0.3 * emo.composure(b), 0.2, 1.2);
      const got = new Map(); // `${type}|${target}` -> { delta, type, target, from }
      for (const s of shows) {
        if (s.a.id === b.id) continue;
        const closeness = 0.6 + 0.1 * Math.max(0, world.memory.rel(b.id, s.a.id)?.affinity ?? 0);
        const crowd = Math.min(2, 1 + 0.25 * ((count.get(s.e.type)?.size ?? 1) - 1));
        const delta = s.rate * (s.x - 3) * susceptibility * closeness * crowd;
        // aimed contagion: only if B knows who it is about (and it isn't B)
        const target = s.e.target && s.e.target !== b.id && world.memory.rel(b.id, s.e.target) ? s.e.target : null;
        if (s.e.target === b.id) continue; // being the object of someone's anger is not "catching" it
        const key = `${s.e.type}|${target ?? ''}`;
        const cur = got.get(key);
        if (!cur || delta > cur.delta) got.set(key, { delta, type: s.e.type, target, from: s.a.id });
      }
      for (const g of got.values()) applyContagion(world, emo, b, g, roomId, now);
    }
  }
}

function applyContagion(world, emo, b, { delta, type, target, from }, roomId, now) {
  // hourly cap per type
  b.contagionLog ??= {};
  const log = (b.contagionLog[type] ?? []).filter((x) => now - x[0] < 60);
  const used = log.reduce((s, x) => s + x[1], 0);
  let d = Math.min(delta, HOURLY_CAP - used);
  const current = emo.get(b, type, target)?.intensity ?? 0;
  if (current >= CONTAGION_MAX || d <= 0.02) return;
  if (emo.types[type]?.aimed === 'required' && !target) return;
  const src = world.citizens.get(from);
  const cause = target ? `Everyone around me is turning on ${ref(target)}.` : src ? `${ref(src)}'s ${type} is catching.` : `The ${type} in the room is catching.`;
  const r = emo.bump(b, { type, target, delta: d, cause, source: 'contagion', raw: true, cap: CONTAGION_MAX });
  if (!r) return;
  b.contagionLog[type] = [...log, [now, r.applied]];
  for (const edge of [4, 7]) {
    if (r.before < edge && r.after >= edge) {
      world.perceive([b.id], {
        kind: 'emotion', text: WORDS[type]?.[edge === 4 ? 0 : 1] ?? `The ${type} in the room is getting to you.`,
        importance: edge === 4 ? 5 : 7, roomId, data: { contagion: true, emotion: type, personal: true },
      });
      world.logEvent('emotion', { actorId: b.id, location: roomId, emotion: type, contagion: true, from, otherId: target, intensity: Math.round(r.after * 10) / 10, band: edge });
      emo.glow(roomId, type);
    }
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
