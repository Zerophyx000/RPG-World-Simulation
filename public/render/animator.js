// Step 9: the behaviour animator. STUB (keeps the step-8 behaviour): the task "animator" implements idle life,
// conversation behaviour, activity poses, body language and secondary motion here. Client-side, no LLM, never sent back.
// The scene calls update(F) once per frame after positions are known, then of(id) for each person it draws.
// Anim = { pose, frame, dir, dx, dy (world px), sortDy?, mods (character mods, see character.js frame()), held? }
import { hash32 } from '../art/rand.js';

export function createAnimator(_ctx) {
  const anims = new Map();
  return {
    update(F) {
      for (const p of F.people.values()) {
        const c = p.c;
        const pose = poseOf(c, p, F.S);
        let dir = p.dir ?? 'down';
        if (!p.moving) {
          const partner = F.S.faceOf?.get(c.id);
          const pp = partner && F.people.get(partner);
          if (pp && Math.abs(pp.x - p.x) > 6) dir = pp.x > p.x ? 'right' : 'left';
          else if (pp && pp.y < p.y - 8) dir = 'up';
          else if (pp) dir = 'down';
          else dir = dir === 'up' ? 'down' : dir;
        }
        const frame = pose === 'walk' || pose === 'carry' || pose === 'crawl' ? Math.floor(p.dist / (pose === 'crawl' ? 5 : 7))
          : pose === 'work' || pose === 'idle' ? Math.floor(F.ms / (pose === 'idle' ? 700 : 280)) + (hash32(c.id) & 1) : 0;
        anims.set(c.id, { pose, frame, dir, dx: 0, dy: 0, mods: null });
      }
    },
    of(id) { return anims.get(id) ?? null; },
    /** A walking speed factor for a citizen (body language: slower when sad); the scene multiplies the mover speed. */
    speedOf(_id) { return 1; },
  };
}

function poseOf(c, p, S) {
  if (c.alive === false) return 'lie';
  const a = c.activity ?? {};
  const status = c.body?.status ?? [];
  if (a.type === 'sleeping' || a.type === 'collapsed' || status.includes('unconscious')) return 'lie';
  if (status.some((s) => /crawling|can't move|paralyzed|in shock|dying/.test(s))) return p.moving ? 'crawl' : 'lie';
  if (!p.moving && p.legBroken) return 'lie';
  if (p.moving) return S.holding?.has(c.id) ? 'carry' : 'walk';
  if (a.type === 'doing') {
    const k = a.detail?.kind ?? '';
    if (/eat|drink|sit|rest/.test(k)) return 'sit';
    if (/work|bake|forge|hammer|repair|mend|clean|cook|treat|craft/.test(k + (a.detail?.description ?? ''))) return 'work';
  }
  return 'idle';
}
