// Step 9: the behaviour animator. Per citizen and frame it decides what the scene draws: pose, frame, direction,
// small whole-body offsets (dx, dy) and character modifiers (blink, look, headDy, slump, lean, fists, crossArms, sway,
// tilt, held). Everything comes from simulation state the map already has (activity, conversation bubbles, expressed
// emotions, relationships in S.social, body status, personality traits); nothing is sent back, no LLM.
//   1. pose:      dead / asleep > moving (crawl only when the body status says they can't walk; otherwise walk, run,
//                 carry, limping with a bad leg) > down on the floor when still (can't walk, dying, broken leg; in shock:
//                 sitting) > the activity (object type, then keywords from content/art/activity-poses.json, then busy
//                 hands) > talking gestures > idle
//   2. facing:    the walk direction; in a conversation the current speaker (the speaker faces the addressee);
//                 strong feelings override (face the beloved, stare at the rival, look away in shame)
//   3. idle life: blinks, breathing, weight shifts, glances at arrivals and speakers, personality flavour
//   4. body language from the EXPRESSED emotion: readable at zoom 0.5 through whole-body offsets
//   5. secondary motion: capes and hair trailing, the wind outdoors; a 180-degree turn passes a middle direction
// Per-citizen randomness is seeded by the citizen id, so the same person always moves the same way.
import { hash32, mulberry } from '../art/rand.js';
import * as character from '../art/character.js';
import { TILE } from '../art/mapdata.js';

const DEFAULT_POSES = {
  objects: {
    anvil: { pose: 'hammer', particles: 'spark', held: 'hammer' }, forge: { pose: 'hammer', particles: 'spark', held: 'hammer' },
    oven: { pose: 'knead', particles: 'flour' }, bench: { pose: 'sitHigh' }, table: { pose: 'sit' }, bed: { pose: 'lie' },
  },
  keywords: [
    { match: 'hammer|forge|smith|anvil', pose: 'hammer', particles: 'spark', held: 'hammer' },
    { match: 'knead|dough|bake|bread', pose: 'knead', particles: 'flour' },
    { match: 'sweep|clean|tidy', pose: 'sweep', held: 'broom' },
    { match: 'eat|meal|soup|stew', pose: 'eat', held: 'bowl' },
    { match: 'drink|ale', pose: 'sit', held: 'cup' },
    { match: 'read|letter|ledger|write', pose: 'read', held: 'paper' },
    { match: 'search|rummage|look for|dig', pose: 'crouch' },
    { match: 'treat|bandage|tend|wound|splint', pose: 'kneel' },
    { match: 'sit|rest|wait', pose: 'sit' },
  ],
  fallback: { pose: 'work' },
};
const SEATED = new Set(['sit', 'sitHigh', 'eat', 'read']);
// step 10: physical acts onto the poses the character art has (push = an arm thrown out)
const ACT_POSE = {
  shove: 'push', slap: 'push', punch: 'push', kick: 'push', strike: 'hammer', throw_at: 'push', grab: 'push', snatch: 'push', hold_back: 'push',
  choke: 'push', pin_down: 'kneel', tie_up: 'kneel', drag: 'crouch', help_up: 'crouch', free: 'kneel', dodge: 'crouch', block: 'idle',
  break_free: 'work', pull_away: 'idle', yield: 'kneel', plead: 'kneel', embrace: 'idle', hold_hand: 'idle', comfort: 'idle', support: 'walk', get_up: 'kneel',
};
const BLOWS = new Set(['shove', 'slap', 'punch', 'kick', 'strike', 'throw_at']);
const HANDLE_POSE = { push: 'push', break: 'hammer', throw: 'push', pour: 'work', fill: 'crouch', ignite: 'crouch', light: 'work', douse: 'work', smother: 'work', open: 'work', close: 'work', lock: 'work', unlock: 'work', bar: 'work', unbar: 'work', put_in: 'crouch', take_out: 'crouch', sit_on: 'sitHigh', lie_on: 'lie', force: 'push' };
const HANDLE_FX = { break: 'debris', pour: 'splash', smother: 'smoke', ignite: 'ember', force: 'dust' };
// frame period (ms) of the looping work poses
const PERIOD = { hammer: 230, knead: 380, sweep: 420, eat: 650, crouch: 320, work: 300, talk: 380, idle: 900, kneel: 600 };
const IMPACT = { hammer: 2, knead: 1, sweep: 1, crouch: 1 };
const BUBBLE_MS = 4000;

const dirToward = (from, to) => {
  const dx = to.x - from.x; const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy) * 0.8) return dx >= 0 ? 'right' : 'left';
  return dy < 0 ? 'up' : 'down';
};
const awayFrom = (d) => ({ left: 'right', right: 'left', up: 'down', down: 'up' })[d] ?? 'down';
const sideSign = (d) => (d === 'right' ? 1 : d === 'left' ? -1 : 0);
const opposite = (a, b) => awayFrom(a) === b;

export function createAnimator(ctx) {
  const anims = new Map();
  const state = new Map();     // id -> per-citizen animation state
  const poseCache = new Map(); // description -> activity entry
  const table = () => ctx.art?.activityPoses ?? DEFAULT_POSES;
  const regex = new Map();
  const quality = ctx.quality;
  const seenExchanges = new Map(); // step 10: altId -> exchanges already seen

  function stateOf(id, ms) {
    let st = state.get(id);
    if (!st) {
      const rng = mulberry(hash32(`anim|${id}`));
      st = { rng, nextBlink: ms + 1000 + rng() * 4000, blinkUntil: 0, nextShift: ms + 4000 + rng() * 8000, shiftUntil: 0, shiftDx: 0, shiftDir: null,
        glanceUntil: 0, glanceTo: null, lastX: null, lastY: null, speed: 0, stopAt: 0, wasMoving: false, prevDir: 'down', turnVia: null, turnUntil: 0,
        convId: null, partner: null, leftAt: 0, awayUntil: 0, awayDone: true, lastImpact: -1, lastEmit: 0, lastZ: 0, nodUntil: 0, nextNod: ms + 1500 + rng() * 1500,
        pushUntil: 0, seenBubble: 0, nextFear: ms + 3000, fearLook: null, fearUntil: 0, roomId: null, talkPhase: Math.floor(rng() * 3) };
      state.set(id, st);
    }
    return st;
  }

  /** The activity entry for a doing: targeted object type / tags, then keywords, then the fallback. */
  function activityEntry(a, S) {
    const d = a.detail ?? {};
    if (d.kind === 'eat') return { pose: 'eat', held: 'bowl' };
    const t = table();
    const obj = d.targetId ? S.objects?.get(d.targetId) : null;
    if (obj) {
      const byType = t.objects?.[obj.typeId];
      if (byType) return byType;
      for (const tag of obj.tags ?? []) if (t.objects?.[`@${tag}`]) return t.objects[`@${tag}`];
    }
    const desc = String(d.description ?? d.kind ?? '').toLowerCase();
    if (poseCache.has(desc)) return poseCache.get(desc);
    let hit = null;
    for (const k of t.keywords ?? []) {
      let re = regex.get(k.match);
      if (!re) { re = new RegExp(`\\b(${k.match})`, 'i'); regex.set(k.match, re); }
      if (re.test(desc)) { hit = k; break; }
    }
    hit ??= t.fallback ?? { pose: 'work' };
    if (poseCache.size > 500) poseCache.clear();
    poseCache.set(desc, hit);
    return hit;
  }

  /** Expressed emotions of a citizen: [{ type, intensity, target }]. */
  function emotionsOf(c, S) {
    const e = S.social?.citizens?.[c.id]?.emotions;
    if (e) return e;
    const d = c.emotion?.dominant;
    return d ? [d] : [];
  }
  const strongest = (list, types, min) => {
    let best = null;
    for (const e of list) if (types.includes(e.type) && (e.intensity ?? 0) >= min && (!best || e.intensity > best.intensity)) best = e;
    return best;
  };

  return {
    update(F) {
      const { S, ms } = F;
      const dt = Math.max(0.001, F.dt);
      const idleOn = quality?.get('idle') !== false;
      const secondary = quality?.get('secondary') !== false;
      // relationships toward someone (from S.social pairs), once per frame
      const pairs = new Map();
      for (const p of S.social?.pairs ?? []) pairs.set(`${p.from}>${p.to}`, p);
      // what just happened in each room (a new speaker, an arrival): something to glance at
      const roomEvents = new Map();
      for (const [id, b] of S.bubbles ?? []) {
        const p = F.people.get(id);
        if (p && ms - b.born < 1500) roomEvents.set(p.roomId, { x: p.x, y: p.y - 20, id, at: b.born });
      }
      for (const p of F.people.values()) {
        const st = stateOf(p.c.id, ms);
        if (st.roomId && p.roomId !== st.roomId && !p.moving) roomEvents.set(p.roomId, { x: p.x, y: p.y - 20, id: p.c.id, at: ms });
        st.roomId = p.roomId;
      }
      // the current speaker of each conversation
      const speakerOf = new Map();
      for (const [id, b] of S.bubbles ?? []) {
        if (!b.conversationId || ms - b.born > BUBBLE_MS) continue;
        const cur = speakerOf.get(b.conversationId);
        if (!cur || b.born > cur.born) speakerOf.set(b.conversationId, { id, ...b });
      }

      // step 10: a new blow in any fight makes its target stagger (and bleed, when it drew blood)
      for (const alt of S.altercations ?? []) {
        const n = alt.exchanges?.length ?? 0;
        const seenN = seenExchanges.get(alt.id) ?? n;
        seenExchanges.set(alt.id, n);
        for (const e of (alt.exchanges ?? []).slice(Math.max(0, n - (n - seenN)))) {
          if (!e.hit || !BLOWS.has(e.action) && !['grab', 'choke', 'pin_down'].includes(e.action)) continue;
          const st = stateOf(e.target, ms); st.hitAt = ms; st.hitFrom = e.actor;
          const tp = F.people.get(e.target);
          if (tp && quality?.get?.('particles') !== false) { F.emit('dust', tp.x, tp.y - 14); if ((e.effects ?? []).includes('bleeding')) F.emit('blood', tp.x, tp.y - 16); }
        }
      }
      for (const p of F.people.values()) {
        const c = p.c; const id = c.id;
        const st = stateOf(id, ms);
        const a = c.activity ?? {};
        const status = c.body?.status ?? [];
        const traits = c.look?.traits ?? {};
        const emos = emotionsOf(c, S);
        // speed from the drawn movement (running is a visual choice: the mover sped up)
        if (st.lastX != null) { const v = Math.hypot(p.x - st.lastX, p.y - st.lastY) / dt; st.speed = st.speed * 0.8 + v * 0.2; }
        st.lastX = p.x; st.lastY = p.y;
        if (st.wasMoving && !p.moving) st.stopAt = ms;
        st.wasMoving = p.moving;

        const out = { pose: 'idle', frame: 0, dir: p.dir ?? 'down', dx: 0, dy: 0, sortDy: 0, mods: {} };
        const mods = out.mods;
        const fear = strongest(emos, ['fear'], 4);
        const anger = strongest(emos, ['anger'], 4);
        const sad = strongest(emos, ['sadness', 'grief'], 4);
        const joy = strongest(emos, ['joy', 'pride'], 4);
        const shame = strongest(emos, ['shame', 'guilt'], 4);
        const disgust = strongest(emos, ['disgust'], 4);
        const affection = strongest(emos, ['affection'], 5);
        const jealous = strongest(emos, ['jealousy', 'envy'], 4);
        const lying = c.alive === false || a.type === 'sleeping' || a.type === 'collapsed' || status.includes('unconscious');
        // Mobility comes from the body status the server derives from capacities: only someone who can't walk
        // crawls. Anyone else on the move walks (limping with a bad leg), whatever else is wrong with them.
        const cantWalk = status.some((s) => /crawling|can't move|paralyzed/.test(s));
        const limping = status.includes('limping') || p.legBroken;
        // standing still: the badly hurt lie on the floor, someone in shock sits down on the ground
        const downOnFloor = !p.moving && (cantWalk || status.includes('dying') || p.legBroken);
        const sitsDown = !p.moving && !downOnFloor && status.includes('in shock') && a.type !== 'doing';

        // ---- 1. pose
        let entry = null;
        // step 10: on the floor, pinned, tied, in the middle of an act
        const ph = c.phys ?? null;
        const act = a.type === 'doing' && a.detail?.kind === 'act' ? a.detail.act : null;
        const hnd = a.type === 'doing' && a.detail?.kind === 'handle' ? a.detail.handle : null;
        const actTarget = act && a.detail?.targetId ? F.people.get(a.detail.targetId) : null;
        const physDown = !p.moving && (ph?.prone || ph?.restraint === 'pinned');
        const tied = !p.moving && ph?.restraint === 'tied';
        if (lying) out.pose = 'lie';
        else if (p.moving && cantWalk) out.pose = 'crawl';
        else if (downOnFloor || physDown) out.pose = 'lie';
        else if (tied) { out.pose = 'sit'; mods.crossArms = true; }
        else if (sitsDown) out.pose = 'sit';
        st.fearRun = Boolean(p.moving && !limping && fear && fear.intensity >= 6);
        if (lying || downOnFloor || physDown || tied || sitsDown || out.pose === 'crawl') { /* chosen above */ }
        else if (act && !p.moving) {
          out.pose = ACT_POSE[act] ?? 'push';
          if (actTarget) {
            out.dir = dirToward(p, actTarget);
            const toward = Math.sign(actTarget.x - p.x) || 0;
            if (BLOWS.has(act)) { const t = ((ms - (st.actAt ?? ms)) % 600) / 600; out.dx += toward * Math.round(3 * Math.sin(Math.PI * t)); }
            else if (['embrace', 'hold_hand', 'comfort', 'hold_back', 'grab', 'choke'].includes(act)) out.dx += toward * Math.min(6, Math.max(0, Math.abs(actTarget.x - p.x) - 6));
          }
          if (act === 'dodge') out.dy += 1;
          if (st.lastAct !== act) { st.lastAct = act; st.actAt = ms; }
        }
        else if (hnd && !p.moving) {
          out.pose = HANDLE_POSE[hnd] ?? 'work';
          const fx = HANDLE_FX[hnd];
          if (fx && ms - (st.lastFx ?? 0) > 450) { st.lastFx = ms; F.emit(fx, p.x + 8 * (sideSign(out.dir) || 1), p.y - 10); }
        }
        else if (p.moving) out.pose = S.holding?.has(id) ? 'carry' : (st.speed > 160 || st.fearRun) ? 'run' : 'walk';
        else if (a.type === 'doing' && a.detail?.kind !== 'walk') { entry = activityEntry(a, S); out.pose = entry.pose ?? 'work'; }
        else if (a.type === 'waiting' && /sit|rest/.test(String(a.detail?.reason ?? ''))) out.pose = 'sit';
        const myBubble = S.bubbles?.get(id);
        const speaking = myBubble && ms - myBubble.born < BUBBLE_MS;
        if (out.pose === 'idle' && speaking) {
          if (myBubble.volume === 'shout' && ms - myBubble.born < 600) out.pose = 'push';
          else out.pose = 'talk';
        }
        // step 10: held or choked: a struggle; a fresh blow: a stagger away from the one who struck
        if (!lying && (ph?.restraint === 'held' || ph?.choking)) { mods.tilt = Math.floor(ms / 170) % 2 ? 1 : -1; out.dx += Math.floor(ms / 240) % 2 ? 1 : -1; }
        if (!lying && st.hitAt && ms - st.hitAt < 450) {
          const from = F.people.get(st.hitFrom);
          const away = from ? (Math.sign(p.x - from.x) || 1) : 1;
          const k = 1 - (ms - st.hitAt) / 450;
          out.dx += away * Math.round(4 * k); mods.tilt = away;
        }
        // leaving a conversation: turn away first, then walk
        if (c.conversationId) { st.convId = c.conversationId; st.partner = S.faceOf?.get(id) ?? st.partner; st.awayDone = false; }
        else if (st.convId) { st.convId = null; st.leftAt = ms; }
        if (p.moving && !st.awayDone && ms - st.leftAt < 1500 && st.partner) { st.awayUntil = ms + 250; st.awayDone = true; }

        // ---- frame index
        if (out.pose === 'walk' || out.pose === 'run' || out.pose === 'carry') {
          out.frame = Math.floor(p.dist / 6);
          if (limping) { const step = Math.floor(p.dist / 12) % 2; mods.tilt = step ? 1 : -1; out.dy += step; } // favouring one leg
        }
        else if (out.pose === 'crawl') out.frame = Math.floor(p.dist / 5);
        else if (out.pose === 'talk') { const per = 520 - 220 * (traits.extraversion ?? 0.5) - 60 * Math.min(1, (anger?.intensity ?? 0) / 10); out.frame = Math.floor(ms / per) + st.talkPhase; }
        else if (out.pose === 'idle') { const fast = (fear?.intensity ?? 0) >= 5 || status.includes('in shock') || ms - st.stopAt < 5000; out.frame = Math.floor(ms / (fast ? 350 : PERIOD.idle)) + (hash32(id) & 1); }
        else if (PERIOD[out.pose]) out.frame = Math.floor(ms / PERIOD[out.pose]);

        // particles on the impact frame of work
        if (entry?.particles && IMPACT[out.pose] != null) {
          const n = character.POSES?.[out.pose] ?? 2;
          const f = ((out.frame % n) + n) % n;
          if (f === IMPACT[out.pose] && st.lastImpact !== out.frame && ms - st.lastEmit > 280) {
            st.lastEmit = ms;
            F.emit(entry.particles, p.x + 7 * (sideSign(out.dir) || 1), p.y - (out.pose === 'hammer' ? 16 : 18));
          }
          st.lastImpact = out.frame;
        }
        if (a.type === 'sleeping' && !p.inBed && ms - st.lastZ > 1500) { st.lastZ = ms; F.emit('z', p.x + 6, p.y - 16); }
        else if (a.type === 'sleeping' && p.inBed && ms - st.lastZ > 1800) { st.lastZ = ms; F.emit('z', p.x + 6, p.y - 34); }
        if (entry?.held) mods.held = entry.held;

        // ---- 2. facing
        if (!p.moving && !lying) {
          const conv = c.conversationId ? speakerOf.get(c.conversationId) : null;
          let face = null;
          if (conv && conv.id !== id) face = F.people.get(conv.id);
          else if (conv && conv.id === id && conv.toId) face = F.people.get(conv.toId);
          else if (S.faceOf?.get(id)) face = F.people.get(S.faceOf.get(id));
          if (face) out.dir = dirToward(p, face);
          // strong feelings turn the body
          const target = (e) => (e?.target ? F.people.get(e.target) : null);
          const tAff = target(affection); const tJeal = target(jealous);
          if (tAff && tAff.roomId === p.roomId) out.dir = dirToward(p, tAff);
          if (tJeal && tJeal.roomId === p.roomId) out.dir = dirToward(p, tJeal); // staring while doing something else
          if (shame) {
            let near = null; let nd = Infinity;
            for (const q of F.people.values()) { if (q === p || q.roomId !== p.roomId) continue; const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < nd) { nd = d; near = q; } }
            if (near) out.dir = awayFrom(dirToward(p, near));
          }
          // seated on a bench, kneeling at a patient
          if (SEATED.has(out.pose)) {
            let seat = null; let sd = TILE * 1.1;
            for (const op of F.objectPos.values()) {
              if (op.roomId !== p.roomId || !['bench', 'chair', 'stool'].includes(op.o.typeId)) continue;
              const d = Math.hypot(op.x - p.x, op.y - p.y); if (d < sd) { sd = d; seat = op; }
            }
            if (seat) { out.pose = out.pose === 'sit' ? 'sitHigh' : out.pose; out.dx += Math.max(-12, Math.min(12, seat.x - p.x)); out.dy += Math.max(-10, Math.min(10, seat.y - 6 - p.y)); out.sortDy = seat.y + 1 - p.y; }
          }
          if (out.pose === 'kneel') {
            let pat = null; let pd = TILE * 1.4;
            for (const q of F.people.values()) {
              if (q === p) continue;
              const qa = q.c.activity ?? {}; const qs = q.c.body?.status ?? [];
              const down = q.c.alive === false || qa.type === 'collapsed' || qs.some((s) => /unconscious|crawling|can't move|dying/.test(s)) || q.legBroken;
              const d = Math.hypot(q.x - p.x, q.y - p.y); if (down && d < pd) { pd = d; pat = q; }
            }
            if (pat) out.dir = dirToward(p, pat);
          }
        }

        // ---- 3. idle life
        if (idleOn && !lying) {
          const ext = traits.extraversion ?? 0.5;
          if (ms > st.nextBlink) { st.blinkUntil = ms + 120; st.nextBlink = ms + 2000 + st.rng() * 4000; }
          if (ms < st.blinkUntil && a.type !== 'sleeping') mods.blink = true;
          if (out.pose === 'idle' && !c.conversationId) {
            if (ms > st.nextShift) {
              st.shiftUntil = ms + 1000 + st.rng() * 1000;
              if (st.rng() < 0.5) { st.shiftDx = st.rng() < 0.5 ? -1 : 1; st.shiftDir = null; } else { st.shiftDx = 0; st.shiftDir = st.rng() < 0.5 ? 'left' : 'right'; }
              st.nextShift = ms + (5000 + st.rng() * 10000) * (1.4 - ext * 0.8);
            }
            if (ms < st.shiftUntil) { out.dx += st.shiftDx; if (st.shiftDir) out.dir = st.shiftDir; }
          }
          // glance at what just happened in the room
          const ev = roomEvents.get(p.roomId);
          if (ev && ev.id !== id && ev.at > st.seenBubble && st.rng() < 0.6 + ext * 0.4) { st.seenBubble = ev.at; st.glanceTo = ev; st.glanceUntil = ms + 1000 + st.rng() * 1000; }
          if (ms < st.glanceUntil && st.glanceTo && !p.moving) {
            if (c.conversationId || SEATED.has(out.pose) || entry) mods.look = st.glanceTo.x > p.x ? 1 : -1;
            else out.dir = dirToward(p, st.glanceTo);
          }
          if ((traits.neuroticism ?? 0) > 0.6 && !p.moving && (ms % 1000) < 120) out.dx += ((ms / 1000) | 0) % 2 ? 1 : -1; // fidgeting
          if ((traits.conscientiousness ?? 0) > 0.7 && out.pose === 'idle') out.dy -= 1;                              // stands up straight
        }

        // ---- conversation behaviour (listening, whispers)
        if (c.conversationId && !lying) {
          const conv = speakerOf.get(c.conversationId);
          if (conv && conv.id !== id) {
            const rel = pairs.get(`${id}>${conv.id}`);
            const nods = (traits.agreeableness ?? 0.5) > 0.6 || (rel?.affinity ?? 0) > 2;
            const closed = (rel?.trust ?? 0) <= -2 || (rel?.anger ?? 0) >= 4;
            if (closed && out.pose === 'idle') mods.crossArms = true;
            else if (nods) { if (ms > st.nextNod) { st.nodUntil = ms + 200; st.nextNod = ms + 1500 + st.rng() * 1500; } if (ms < st.nodUntil) mods.headDy = 1; }
          }
          // a whisper: speaker and addressee lean in toward each other
          const wb = conv && conv.volume === 'whisper' ? conv : null;
          if (wb && (wb.id === id || wb.toId === id)) {
            const other = F.people.get(wb.id === id ? wb.toId : wb.id);
            if (other) { const s = other.x > p.x ? 1 : -1; mods.tilt = s; out.dx += s; }
          }
        }

        // ---- 4. body language (whole body, readable at zoom 0.5)
        if (!lying && !downOnFloor) {
          if (sad) { mods.headDy = Math.max(mods.headDy ?? 0, 1); mods.slump = 1; }
          if (anger) { mods.lean = 1; mods.fists = true; if (p.moving && out.frame % 4 === 0) out.dy += 1; }
          if (fear) {
            out.dx += (Math.floor(ms / 80) % 2) ? 1 : -1; // trembling
            const ft = fear.target ? F.people.get(fear.target) : null;
            if (ft && ft.roomId === p.roomId && Math.hypot(ft.x - p.x, ft.y - p.y) < TILE * 2) { out.dx += ft.x > p.x ? -2 : 2; out.dy += ft.y > p.y ? -2 : 2; }
            if (ms > st.nextFear) {
              st.nextFear = ms + 3000 + st.rng() * 3000;
              const door = F.layout?.geom(p.roomId)?.room?.doors?.[0];
              if (door) { st.fearLook = { x: door.tile[0] * TILE + TILE / 2, y: door.tile[1] * TILE + TILE / 2 }; st.fearUntil = ms + 700; }
            }
            if (ms < st.fearUntil && st.fearLook && !p.moving && !c.conversationId) out.dir = dirToward(p, st.fearLook);
          }
          if (joy && !sad) { if (out.pose === 'idle') out.dy -= 1; if (p.moving && out.frame % 4 === 2) out.dy -= 1; }
          if (shame) mods.headDy = 2;
          if (disgust) { mods.lean = -1; const dt_ = disgust.target ? F.people.get(disgust.target) : null; if (dt_) out.dx += dt_.x > p.x ? -1 : 1; }
        }

        // ---- 5. secondary motion and turning
        if (secondary && !lying) {
          let sway = 0;
          if (p.moving) sway -= sideSign(out.dir) * (out.pose === 'run' ? 2 : 1);
          if (F.layout?.geom(p.roomId)?.room?.kind === 'area') sway += Math.round(F.wind?.x ?? 0);
          if (sway) mods.sway = Math.max(-2, Math.min(2, sway));
        }
        if (ms < st.awayUntil && st.partner) { const q = F.people.get(st.partner); if (q) { out.dir = awayFrom(dirToward(p, q)); out.pose = 'idle'; out.frame = 0; } }
        if (out.dir !== st.prevDir) {
          if (opposite(out.dir, st.prevDir)) { st.turnVia = character.turnVia ? character.turnVia(st.prevDir, out.dir) : (sideSign(out.dir) ? 'down' : 'left'); st.turnUntil = ms + 90; }
          st.prevDir = out.dir;
        }
        if (ms < st.turnUntil && st.turnVia) out.dir = st.turnVia;
        if (!Object.keys(mods).length) out.mods = null;
        anims.set(id, out);
      }
      // forget people who left the map
      if (state.size > F.people.size + 20) for (const id of state.keys()) if (!F.people.has(id)) { state.delete(id); anims.delete(id); }
    },
    of(id) { return anims.get(id) ?? null; },
    /** Walking speed factor (body language): slower when sad, faster when angry, running when afraid. */
    speedOf(id) {
      const st = state.get(id);
      const an = anims.get(id);
      if (!st || !an) return 1;
      if (st.fearRun) return 1.6; // only fear makes them run faster (a catch-up run must not feed itself)
      if (an.mods?.slump) return 0.8;
      if (an.mods?.fists) return 1.15;
      return 1;
    },
  };
}
