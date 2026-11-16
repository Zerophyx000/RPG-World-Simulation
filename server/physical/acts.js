// Step 10 §1–§2, §5.4: physical acts between people, through ONE tool, act_on(person, action, with?, aim?, intent?,
// reason?, words?). Code offers only what the body and the situation allow (enums), resolves every act as a contest
// through combatProfile() / weaponProfile(), and hands every wound to world.body.damage(). Nothing here chooses an act.
//
//   aggressive  shove grab slap punch kick strike throw_at snatch pin_down choke tie_up drag
//   defensive   dodge block break_free yield plead pull_away
//   caring      embrace hold_hand comfort help_up support hold_back free
//   + get_up (its own tool, only while prone)
//
// Status (c.phys): prone, dazedUntil, windedUntil, guardUntil (dodging/blocking), restraint { kind: held|pinned|tied, by,
// since, cordId? }, holding (whom they hold), asphyxia (choking steps; smoke adds its own), chokedBy, chokeDeathAt,
// touchedBy { id, kind, until, welcome }, yielded.
import { combatProfile, weaponProfile, BARE_HANDS, isDark } from './profile.js';
import { AGGRESSIVE, DEFENSIVE, CARING } from './altercations.js';
import { phys, damageObject } from './props.js';
import { citizensIn } from '../world/rooms.js';
import { ref } from '../memory/index.js';
import { pronouns } from '../world/citizens.js';

export const ACTIONS = [...AGGRESSIVE, ...DEFENSIVE, ...CARING];
export const INTENTS = ['scare', 'subdue', 'hurt', 'kill', 'defend', 'care'];
export const AIMS = ['head', 'torso', 'left_arm', 'right_arm', 'left_leg', 'right_leg', 'neck'];
const HAND_ACTS = new Set(['grab', 'slap', 'punch', 'strike', 'throw_at', 'snatch', 'choke', 'tie_up', 'embrace', 'hold_hand', 'comfort', 'help_up', 'hold_back', 'free', 'drag']);
const RESTRAINED_OK = new Set(['break_free', 'plead', 'yield']);
const PRONE_OK = new Set(['break_free', 'plead', 'yield', 'grab', 'kick', 'block', 'pull_away']);

// game minutes (normal world time)
export const MINUTES = {
  shove: 0.15, slap: 0.1, punch: 0.15, kick: 0.15, strike: 0.2, throw_at: 0.15, dodge: 0.1, block: 0.1,
  grab: 0.25, snatch: 0.25, break_free: 0.25, help_up: 0.3, pin_down: 0.5, drag: 0.5, choke: 0.5, tie_up: 2,
  embrace: 5, hold_hand: 10, comfort: 3, support: 10, hold_back: 0.5, yield: 0.1, plead: 0.2, pull_away: 0.1, free: 1,
};
const DIFF = { slap: 1.1, punch: 1, kick: 0.9, shove: 1.05, throw_at: 0.8, choke: 0.7, pin_down: 0.7, grab: 0.95, hold_back: 0.95, drag: 1 };
const AIM_PENALTY = { head: 0.7, neck: 0.5, torso: 0.95, left_arm: 0.85, right_arm: 0.85, left_leg: 0.85, right_leg: 0.85 };
const INTENT_DAMAGE = { scare: 0.4, subdue: 0.6, hurt: 1, kill: 1.3, defend: 0.8, care: 0 };
const BASE = { slap: [{ type: 'blunt', base: 2 }], punch: [{ type: 'blunt', base: 5 }], kick: [{ type: 'blunt', base: 7 }], shove: [{ type: 'blunt', base: 0 }] };
const PART_OF_AIM = { head: 'head', neck: 'neck', torso: 'torso', left_arm: 'left_arm', right_arm: 'right_arm', left_leg: 'left_leg', right_leg: 'right_leg' };

const VERB = {
  shove: ['shove', 'shoves'], grab: ['grab', 'grabs'], slap: ['slap', 'slaps'], punch: ['punch', 'punches'], kick: ['kick', 'kicks'],
  strike: ['hit', 'hits'], throw_at: ['throw', 'throws'], snatch: ['snatch', 'snatches'], pin_down: ['pin', 'pins'], choke: ['choke', 'chokes'],
  tie_up: ['tie up', 'ties up'], drag: ['drag', 'drags'], embrace: ['put your arms around', 'puts their arms around'], hold_hand: ['take the hand of', 'takes the hand of'],
  comfort: ['lay a hand on the shoulder of', 'lays a hand on the shoulder of'], help_up: ['help up', 'helps up'], support: ['support', 'supports'],
  hold_back: ['hold back', 'holds back'], free: ['untie', 'unties'],
};

const rnd = (world, a, b) => a + (world.physical?.rng ?? Math.random)() * (b - a);
const roll = (world) => (world.physical?.rng ?? Math.random)();
export const isDown = (c) => !c?.alive || ['collapsed', 'unconscious'].includes(c.activity.type) || (c.body?.status ?? []).includes('unconscious');
const asleep = (c) => c.activity.type === 'sleeping';
export const helpless = (c) => isDown(c) || asleep(c) || ['tied', 'pinned'].includes(c.phys?.restraint?.kind);
const ph = (c) => (c.phys ??= {});
const hands = (c) => Math.max(c.body?.capacities?.manipulationLeft ?? 1, c.body?.capacities?.manipulationRight ?? 1) >= 0.2;
const partWord = (world, part) => world.body?.content?.partLabel?.(part) ?? String(part ?? 'body').replace(/_/g, ' ');

// ---------- the tool ----------
/** act_on (and get_up) for this citizen right now, or [] when nothing physical is possible. */
export function actOnTools(world, c, fn, INNER) {
  if (!c.location || ['sleeping', 'collapsed', 'unconscious'].includes(c.activity.type) || isDown(c)) return [];
  const out = [];
  const me = ph(c);
  if (me.prone && me.restraint?.kind !== 'pinned' && me.restraint?.kind !== 'tied') {
    out.push(fn('get_up', "Get back on your feet (a moment). Lying on the floor, you can do little else but defend yourself.", { inner_thought: INNER }, []));
  }
  const present = citizensIn(world.citizens, c.location, { exceptId: c.id }).filter((o) => o.alive);
  if (!present.length) return out;
  const labels = world.memory.labelsFor(c, present);
  const restrained = me.restraint && ['held', 'pinned', 'tied'].includes(me.restraint.kind);
  const handsFree = hands(c) && me.restraint?.kind !== 'tied';
  const held = world.objects.carriedBy(c.id);
  let acts;
  if (restrained) acts = new Set(['break_free', 'plead', 'yield']);
  else {
    acts = new Set(ACTIONS);
    if (me.prone) for (const a of [...acts]) if (!PRONE_OK.has(a)) acts.delete(a);
  }
  if (!handsFree) for (const a of [...acts]) if (HAND_ACTS.has(a)) acts.delete(a);
  const someone = (pred) => present.some(pred);
  if (!held.length) { acts.delete('strike'); acts.delete('throw_at'); }
  if (!held.some((o) => phys(world, o).throwable || (world.objects.type(o)?.size ?? 1) <= 1)) acts.delete('throw_at');
  if (!someone((o) => world.objects.carriedBy(o.id).length)) acts.delete('snatch');
  if (!someone((o) => helpless(o) || o.phys?.prone || o.phys?.restraint?.by === c.id)) { acts.delete('choke'); acts.delete('pin_down'); }
  if (!held.some((o) => phys(world, o).cord) || !someone((o) => helpless(o) || o.phys?.restraint?.by === c.id)) acts.delete('tie_up');
  if (!someone((o) => helpless(o) || o.phys?.restraint?.by === c.id)) acts.delete('drag');
  if (!restrained) acts.delete('break_free');
  if (!someone((o) => o.phys?.prone)) acts.delete('help_up');
  if (!someone((o) => o.phys?.restraint?.kind === 'tied')) acts.delete('free');
  if (!someone((o) => world.altercations?.of(o))) acts.delete('hold_back');
  if (!someone((o) => me.touchedBy?.id === o.id || (me.restraint && me.restraint.by === o.id))) acts.delete('pull_away');
  if (!restrained && !world.altercations?.of(c) && !someone((o) => (o.intents?.[c.id]?.at ?? -Infinity) > world.now - 30)) { acts.delete('dodge'); acts.delete('block'); acts.delete('yield'); acts.delete('plead'); }
  if (!acts.size) return out;
  const order = ACTIONS.filter((a) => acts.has(a));
  const deeds = world.physical?.consequences.recentAggression(c, 60) ?? [];
  const props = {
    person: { type: 'string', enum: [...labels.keys()], description: 'Who.' },
    action: { type: 'string', enum: order, description: 'What you do. Rough: shove, grab, slap, punch, kick, strike (with what you hold), throw_at (throw what you hold at them), snatch (what they hold), pin_down, choke, tie_up (with a cord), drag. Guarding yourself: dodge, block, break_free, yield, plead, pull_away. Kind: embrace, hold_hand, comfort, help_up, support (walk with them), hold_back (stop a friend from fighting), free (untie).' },
    with: { type: 'string', enum: [...held.map((o) => world.objects.alias(o)), 'bare_hands'], description: 'Optional: what you use, by its [handle] (strike, throw_at, tie_up, block), or bare_hands.' },
    aim: { type: 'string', enum: AIMS, description: 'Optional: where you aim. Harder to land, but it lands where you mean it (neck only to choke or strike to kill).' },
    intent: { type: 'string', enum: INTENTS, description: 'What you mean by it: scare, subdue, hurt, kill, defend, care. Say it the first time you go at someone; it stays until you change it.' },
    words: { type: 'string', description: 'Optional: what you say or shout as you do it.' },
    reason: { type: 'string', description: deeds.length ? `Required if you now help or comfort someone you went at in the last hour (${deeds.map((d) => world.memory.nameFor(c, d.victimId)).join(', ')}): why you are doing this now.` : 'Optional: why.' },
    inner_thought: INNER,
  };
  out.push(fn('act_on', "Do something physical to someone here: rough, defending yourself, or kind. It happens now, in front of whoever is here, and what it does to them and to you stays.", props, ['person', 'action']));
  return out;
}

// ---------- the act ----------
export function actOn(world, c, call, h) {
  const a = call.arguments ?? {};
  const action = String(a.action ?? '');
  const here = citizensIn(world.citizens, c.location, { exceptId: c.id }).filter((o) => o.alive);
  const t = h.findPerson(world, c, here, a.person);
  if (!t) return h.stale(world, c, call, 'They are not here any more.');
  if (!ACTIONS.includes(action)) return h.stale(world, c, call, 'You hesitate.');
  const me = ph(c);
  const them = ph(t);
  if (me.restraint && ['held', 'pinned', 'tied'].includes(me.restraint.kind) && !RESTRAINED_OK.has(action)) {
    return h.stale(world, c, call, `You can't: ${me.restraint.kind === 'tied' ? 'your hands are tied' : `${ref(world.citizens.get(me.restraint.by) ?? me.restraint.by)} has you ${me.restraint.kind === 'pinned' ? 'pinned down' : 'held fast'}`}.`);
  }
  if (me.prone && !PRONE_OK.has(action)) return h.stale(world, c, call, 'You are on the floor; you would have to get up first.');
  if (HAND_ACTS.has(action) && !hands(c)) return h.stale(world, c, call, "Your hands won't do it.");
  const C = world.physical.consequences;
  // §5.3: turning to care for someone you attacked within the hour needs a reason
  if (CARING.includes(action) && action !== 'hold_back') {
    const deed = C.recentAggression(c, 60).find((d) => d.victimId === t.id);
    if (deed && !String(a.reason ?? '').trim()) {
      world.logEvent('coherence', { actorId: c.id, location: c.location, kind: 'reversal_without_reason', action, victimId: t.id });
      return h.stale(world, c, call, `You went at ${ref(t)} ${Math.max(1, Math.round(world.now - deed.at))} minutes ago, meaning to ${deed.intent === 'kill' ? 'kill' : deed.intent === 'subdue' ? 'subdue' : deed.intent === 'scare' ? 'scare' : 'hurt'} ${pronouns(t).obj}. If you mean to help now, say why (reason).`);
    }
  }
  const withObj = a.with && a.with !== 'bare_hands' ? world.objects.resolve(a.with) : null;
  if (withObj && withObj.holderId !== c.id) return h.stale(world, c, call, "You don't have that in your hands any more.");
  const minutes = MINUTES[action] ?? 0.2;
  h.logAction(world, c, call, { targetId: t.id, act: action });
  const ctx = { world, c, t, action, a, withObj, h, C };
  let res;
  if (AGGRESSIVE.includes(action)) res = aggressive(ctx);
  else if (DEFENSIVE.includes(action)) res = defensive(ctx);
  else res = caring(ctx);
  if (res?.stale) return h.stale(world, c, call, res.stale);
  // the actor is busy for the act's length (ongoing touches and holds longer); the result already happened
  if (!['sleeping', 'collapsed'].includes(c.activity.type) && c.alive && !isDown(c)) {
    world.setActivity(c, { type: 'doing', until: world.now + (res?.minutes ?? minutes), detail: { kind: 'act', act: action, targetId: t.id, description: res?.doing ?? `${VERB[action]?.[0] ?? action.replace('_', ' ')}ing ${t.name}`.replace('eing', 'ing'), minutes: res?.minutes ?? minutes, ...(res?.extraDetail ?? {}) } });
  }
  them.lastActedOnAt = world.now;
  h.remember(world, c, res?.memory ?? `You ${(VERB[action]?.[0] ?? action)} ${ref(t)}.`);
  return { ok: true };
}

/** Kael sees Tomas coming before the blow lands (unless surprised: asleep, or already beside him). */
export function comingAt(world, c, t, action) {
  if (!AGGRESSIVE.includes(action) || asleep(t) || isDown(t)) return;
  world.perceive([t.id], { kind: 'action', text: `${ref(c)} comes at you.`, importance: 8, sourceId: c.id, roomId: c.location, data: { interrupt: true, wake: true, altercation: 'coming', role: 'target' } });
  const others = citizensIn(world.citizens, c.location, { exceptId: c.id }).filter((o) => o.id !== t.id);
  world.perceive(others.map((o) => o.id), { kind: 'action', text: `${ref(c)} goes for ${ref(t)}.`, importance: 7, sourceId: c.id, roomId: c.location, data: { altercation: 'coming', role: 'bystander' } });
}

// ---------- contest ----------
function contest(world, A, T, { action, aim, weapon, defending = false, surprise = 1 }) {
  if (helpless(T)) return { hit: true, auto: true };
  const opp = { opponentId: T.id, weapon };
  const pa = combatProfile(world, A, opp);
  const pt = combatProfile(world, T, { opponentId: A.id });
  // a slow, heavy weapon is easier to see coming, but most of a blow's chance is the one who swings it
  const diff = action === 'strike' ? 0.85 + 0.15 * (weapon?.speed ?? 1) : DIFF[action] ?? 1;
  const attack = pa.precision * diff * (aim ? AIM_PENALTY[aim] ?? 1 : 1) * surprise * rnd(world, 0.75, 1.25);
  const tp = T.phys ?? {};
  let state = 1;
  if (tp.prone) state *= 0.4;
  if (tp.restraint?.kind === 'held') state *= 0.5;
  if (T.conversationId && T.conversationId !== A.conversationId) state *= 0.7; // distracted
  const guard = (tp.guardUntil ?? -Infinity) > world.now ? 1.5 : 1;
  const defense = pt.evasion * (defending ? 1.5 : guard) * state * rnd(world, 0.75, 1.25);
  return { hit: attack > defense, attack, defense, pa, pt };
}

function grapple(world, A, T, mult = 1) {
  if (helpless(T)) return { won: true, auto: true };
  const pa = combatProfile(world, A, { opponentId: T.id });
  const pt = combatProfile(world, T, { opponentId: A.id });
  const a = (pa.force + pa.grip) * mult * rnd(world, 0.75, 1.25);
  const d = (pt.toughness + pt.grip) * (T.phys?.prone ? 0.7 : 1) * rnd(world, 0.75, 1.25);
  return { won: a > d, a, d };
}

// ---------- aggressive ----------
function aggressive({ world, c, t, action, a, withObj, h, C }) {
  const alts = world.altercations;
  const prevIntent = c.intents?.[t.id]?.intent ?? null;
  const intent = a.intent && INTENTS.includes(a.intent) ? a.intent : prevIntent ?? inferIntent(world, c, t, action);
  C.setIntent(c, t, intent, { inferred: !a.intent && !prevIntent });
  const wasAsleep = asleep(t);
  const alt = alts.aggression(c, t, { intent });
  const words = String(a.words ?? '').trim().slice(0, 160) || null;
  const weapon = action === 'strike' || action === 'throw_at' ? weaponProfile(world, withObj ?? world.objects.carriedBy(c.id)[0] ?? null) : BARE_HANDS;
  const aim = a.aim && AIMS.includes(a.aim) && (a.aim !== 'neck' || action === 'choke' || (action === 'strike' && intent === 'kill')) ? a.aim : null;
  const ex = { actor: c.id, action, target: t.id, aim, hit: false, effects: [], conditions: [], with: withObj ? world.objects.alias(withObj) : null, words, intent };
  const fx = [];
  let conds = [];

  switch (action) {
    case 'grab': case 'pin_down': case 'drag': {
      const need = action === 'pin_down' && !(helpless(t) || t.phys?.prone || t.phys?.restraint?.by === c.id);
      if (need) return { stale: `${ref(t)} is on ${pronouns(t).poss} feet; you would have to get hold of ${pronouns(t).obj} or bring ${pronouns(t).obj} down first.` };
      if (action === 'drag' && !(helpless(t) || t.phys?.restraint?.by === c.id)) return { stale: `You can't drag ${ref(t)} while ${pronouns(t).subj} can fight you off.` };
      const g = grapple(world, c, t, action === 'pin_down' ? 0.9 : 1);
      ex.hit = g.won;
      if (g.won) {
        if (action === 'grab') { restrain(world, t, c, 'held'); fx.push('held'); }
        else if (action === 'pin_down') { restrain(world, t, c, 'pinned'); ph(t).prone = true; fx.push('pinned'); }
        else {
          const door = world.maps.doorSpot?.(c.location);
          const to = door && door !== t.spot ? door : c.spot;
          t.spot = to; c.spot = to; fx.push('dragged');
          world.hooks.onTrip?.(t, { kind: 'spot', fromRoom: c.location, fromSpot: t.spot, toRoom: c.location, toSpot: to });
        }
      }
      break;
    }
    case 'choke': {
      const holding = t.phys?.restraint?.by === c.id || helpless(t) || (c.activity.detail?.act === 'choke' && c.activity.detail.targetId === t.id) || t.phys?.chokedBy === c.id;
      const g = holding ? { won: true } : grapple(world, c, t, 0.8);
      ex.hit = g.won;
      if (g.won) {
        const tp = ph(t);
        tp.chokedBy = c.id;
        tp.asphyxia = Math.round(((tp.asphyxia ?? 0) + 1) * 10) / 10;
        tp.chokeDeathAt ??= 6 + Math.floor(roll(world) * 3);
        tp.lastChokedAt = world.now;
        conds = world.body.damage(t.id, { damageType: 'blunt', part: 'neck', amount: 2, cause: `${c.name}'s hands at the throat`, sourceId: c.id })?.conditions ?? [];
        world.body.recompute(t);
        fx.push('choking');
        if (tp.asphyxia >= tp.chokeDeathAt && t.alive) {
          world.body.die(t, { cause: `strangled by ${c.name}`, reason: 'injury' });
          fx.push('dead');
        } else if (tp.asphyxia >= 3) fx.push('unconscious');
      }
      break;
    }
    case 'snatch': {
      const theirs = world.objects.carriedBy(t.id);
      const want = withObj && theirs.includes(withObj) ? withObj : theirs[0];
      if (!want) return { stale: `${ref(t)} has nothing in ${pronouns(t).poss} hands.` };
      const pa = combatProfile(world, c, { opponentId: t.id });
      const pt = combatProfile(world, t, { opponentId: c.id });
      ex.hit = helpless(t) || pa.grip * rnd(world, 0.75, 1.25) > pt.grip * rnd(world, 0.75, 1.25);
      if (ex.hit) {
        const free = world.objects.freeSlots?.(c.id) ?? 1;
        if (free >= (world.objects.type(want)?.size ?? 1)) world.objects.change(want.id, { holderId: c.id }, { actorId: c.id, action: 'take', notify: false });
        else world.objects.change(want.id, { roomId: c.location, placement: { relation: 'floor', of: null } }, { actorId: c.id, action: 'move', notify: false });
        ex.object = world.objects.alias(want);
        fx.push('snatched');
        C.crime(c, t, 'theft_by_force', 2, { objectId: want.id });
      }
      break;
    }
    case 'tie_up': {
      const cord = withObj && phys(world, withObj).cord ? withObj : world.objects.carriedBy(c.id).find((o) => phys(world, o).cord);
      if (!cord) return { stale: 'You have nothing to tie with.' };
      if (!(helpless(t) || t.phys?.restraint?.by === c.id)) return { stale: `${ref(t)} would never hold still for that.` };
      // takes two minutes; the knot is made when the time is up (finishTie), if they are still helpless
      ex.hit = true;
      alts.record(alt, ex);
      announce(world, c, t, alt, { ...ex, effects: ['tying'] }, { serious: true, quietToTarget: asleep(t) }); // a careful knot needn't wake a sleeper
      return { minutes: MINUTES.tie_up, doing: `tying up ${t.name}`, memory: `You began tying up ${ref(t)}.`, extraDetail: { cordId: cord.id } };
    }
    default: {
      // shove, slap, punch, kick, strike, throw_at
      const surprise = wasAsleep ? 1.5 : (t.activity.type === 'talking' && t.conversationId !== c.conversationId ? 1.2 : 1);
      const r = contest(world, c, t, { action, aim, weapon, surprise });
      ex.hit = r.hit;
      if (action === 'throw_at') {
        const o = withObj ?? world.objects.carriedBy(c.id)[0];
        if (o) {
          world.objects.change(o.id, { roomId: c.location, placement: { relation: 'floor', of: null }, data: { ...o.data, spot: t.spot } }, { actorId: c.id, action: 'move', notify: false });
          ex.object = world.objects.alias(o);
          if (phys(world, o).breakable && r.hit) damageObject(world, o, 12, { actorId: c.id, cause: 'thrown' });
        }
      }
      if (r.hit) {
        if (action === 'shove') {
          const pa = combatProfile(world, c, { opponentId: t.id });
          const pt = combatProfile(world, t, { opponentId: c.id });
          if (helpless(t) || roll(world) < Math.min(0.85, 0.45 * pa.force / Math.max(0.3, pt.toughness))) { knockDown(world, t, c); fx.push('knocked down'); }
          else fx.push('staggered');
        } else {
          const blow = damageFor(world, c, t, { action, weapon, intent, aim });
          const out = world.body.damage(t.id, { damageType: blow.type, part: blow.part, amount: blow.amount, cause: blow.cause, sourceId: c.id });
          conds = out?.conditions ?? [];
          ex.part = out?.parts?.[0] ?? blow.part;
          fx.push(...effectsOf(world, c, t, { action, blow, part: ex.part, weapon, conds, withObj }));
          if (withObj && action === 'strike') {
            const wr = damageObject(world, withObj, Math.max(0.5, 3 * (1 - (weapon.quality ?? 0.5))) + (phys(world, withObj).breakable ? 6 : 0), { actorId: c.id, cause: 'a blow' });
            if (wr.broke) fx.push('weapon broke');
          }
          // a small catharsis, once a fight: anger doesn't vanish by hitting
          if (!alt.catharsis?.[c.id]) {
            alt.catharsis = { ...(alt.catharsis ?? {}), [c.id]: true };
            const anger = world.emotions.of(c).find((e) => e.type === 'anger' && e.target === t.id);
            if (anger) world.emotions.bump(c, { type: 'anger', target: t.id, delta: -1, cause: 'the blow landed', source: 'violence', raw: true });
          }
        }
        if (wasAsleep && t.alive) fx.push('woken');
      }
    }
  }
  ex.effects = fx;
  ex.conditions = conds.map((x) => ({ id: x.id, type: x.type, part: x.partId, severity: x.severity }));
  alts.record(alt, ex);
  announce(world, c, t, alt, ex, { serious: ex.hit && (conds.some((x) => x.severity >= 4 || x.type === 'fracture') || fx.some((f) => ['knocked down', 'choking', 'unconscious', 'dead'].includes(f)) || Boolean(withObj)) });
  C.onAct({ actor: c, target: t, action, intent, ex, alt, weapon: withObj ? weapon : null, withObj });
  if (fx.includes('choking')) return { minutes: MINUTES.choke, doing: `choking ${t.name}`, memory: `You choked ${ref(t)}.` };
  if (fx.includes('pinned')) return { minutes: 30, doing: `pinning ${t.name} down`, memory: `You pinned ${ref(t)} down.` };
  if (fx.includes('held')) return { minutes: 10, doing: `holding ${t.name}`, memory: `You grabbed hold of ${ref(t)}.` };
  return null;
}

function inferIntent(world, c, t, action) {
  if (['grab', 'pin_down', 'tie_up', 'drag', 'snatch'].includes(action)) return 'subdue';
  if (['shove', 'slap'].includes(action)) return 'scare';
  return 'hurt';
}

/** The amount, type and part of a blow — weapon profile × force × quality × intent. */
export function damageFor(world, A, T, { action, weapon, intent, aim }) {
  const w = action === 'strike' || action === 'throw_at' ? weapon : { ...BARE_HANDS, damage: BASE[action] ?? BARE_HANDS.damage };
  const sharp = w.damage.filter((d) => d.type === 'cut' || d.type === 'pierce');
  const pick = intent === 'kill' && sharp.length ? sharp.find((d) => d.type === 'pierce') ?? sharp[0] : w.damage[Math.floor(roll(world) * w.damage.length)] ?? w.damage[0];
  const pa = combatProfile(world, A, { opponentId: T.id, weapon: w });
  const pt = combatProfile(world, T, { opponentId: A.id });
  const quality = 0.7 + 0.6 * (w.quality ?? 0.5);
  const thrown = action === 'throw_at' ? 0.8 : 1;
  const amount = Math.max(0.5, (pick.base ?? 4) * pa.force * quality * (INTENT_DAMAGE[intent] ?? 1) * thrown * rnd(world, 0.8, 1.2) / Math.sqrt(Math.max(0.5, pt.toughness)));
  let part = aim ? PART_OF_AIM[aim] : null;
  if (!part) {
    const r = roll(world);
    if (intent === 'subdue' || intent === 'scare') part = r < 0.5 ? 'torso' : ['left_arm', 'right_arm', 'left_leg', 'right_leg'][Math.floor(roll(world) * 4)];
    else if (intent === 'kill') part = r < 0.45 ? 'head' : r < 0.6 ? 'neck' : 'torso';
    else if (action === 'kick') part = r < 0.5 ? 'torso' : r < 0.85 ? (roll(world) < 0.5 ? 'left_leg' : 'right_leg') : 'head';
    else part = 'random';
  }
  const cause = action === 'strike' || action === 'throw_at' ? `${A.name}'s blow with ${w.label ?? 'something'}` : `${A.name}'s ${action.replace('_', ' ')}`;
  return { type: pick.type, amount: Math.round(amount * 10) / 10, part, cause, weapon: w };
}

function effectsOf(world, A, T, { action, blow, part, weapon, conds }) {
  const fx = [];
  const region = world.body?.content?.parts?.get(part)?.region ?? part;
  const isHead = region === 'head';
  const isTorso = region === 'torso' || ['torso', 'chest', 'abdomen'].includes(part);
  const isLeg = /leg|thigh|shin|foot/.test(String(region)) || /thigh|shin|foot/.test(String(part));
  const isArm = /arm|hand|fingers/.test(String(region)) || /arm|hand|fingers/.test(String(part));
  const tp = ph(T);
  if (blow.type === 'blunt' && isHead && blow.amount >= 4) { tp.dazedUntil = world.now + rnd(world, 3, 6); fx.push('dazed'); }
  if (blow.type === 'blunt' && isTorso && blow.amount >= 4) { tp.windedUntil = world.now + rnd(world, 1, 2); fx.push('winded'); }
  const heavy = blow.type === 'blunt' && blow.amount >= 12 && (isLeg || isHead);
  if (T.alive && !tp.prone && (heavy || (action === 'kick' && roll(world) < 0.35))) { knockDown(world, T, A); fx.push('knocked down'); }
  if (isArm && (action === 'strike' || action === 'kick') && roll(world) < 0.5) {
    const held = world.objects.carriedBy(T.id)[0];
    if (held) {
      world.objects.change(held.id, { roomId: T.location, placement: { relation: 'floor', of: null }, data: { ...held.data, spot: T.spot } }, { actorId: A.id, action: 'move', notify: false });
      fx.push('disarmed');
    }
  }
  if (conds.some((x) => (x.bleeding ?? 0) > 0.3 || x.type === 'cut' || x.type === 'puncture')) fx.push('bleeding');
  if (conds.some((x) => x.type === 'fracture')) fx.push('bone broken');
  if (!T.alive) fx.push('dead');
  else if (isDown(T)) fx.push('unconscious');
  return fx;
}

export function knockDown(world, T, by = null) {
  const tp = ph(T);
  if (tp.prone) return;
  tp.prone = true;
  tp.proneSince = world.now;
  // a hard floor: a chance of a knock to the head as they go down
  if (roll(world) < 0.1 && T.alive) world.body.damage(T.id, { damageType: 'blunt', part: 'head', amount: 6, cause: 'hitting the floor', sourceId: by?.id ?? null });
  // a lit lantern or candle at that spot can go over
  for (const o of world.objects.inRoom(T.location)) {
    const p = phys(world, o);
    if (!p.spills || !p.lit) continue;
    if (world.maps.objectSpot(o) !== T.spot) continue;
    if (roll(world) < 0.3) world.physical?.fire.knockedOver(o, by ?? T);
  }
}

export function restrain(world, T, by, kind, extra = {}) {
  ph(T).restraint = { kind, by: by.id, since: world.now, ...extra };
  ph(by).holding = T.id;
}

export function release(world, T, why = 'released') {
  const r = T.phys?.restraint;
  if (!r) return;
  const by = world.citizens.get(r.by);
  if (by?.phys?.holding === T.id) by.phys.holding = null;
  T.phys.restraint = null;
  world.logEvent('restraint_end', { actorId: T.id, location: T.location, by: r.by, kind: r.kind, why });
}

// ---------- defensive ----------
function defensive({ world, c, t, action, a, h, C }) {
  const alts = world.altercations;
  const alt = alts.of(c) ?? alts.of(t);
  const words = String(a.words ?? '').trim().slice(0, 160) || null;
  const ex = { actor: c.id, action, target: t.id, hit: true, effects: [], words };
  const me = ph(c);
  switch (action) {
    case 'dodge': case 'block': me.guardUntil = world.now + 0.6; ex.effects.push('on guard'); break;
    case 'break_free': {
      const r = me.restraint;
      if (!r) return { stale: 'Nobody is holding you.' };
      const holder = world.citizens.get(r.by);
      const mult = r.kind === 'tied' ? 0.15 : r.kind === 'pinned' ? 0.7 : 1;
      const g = !holder || holder.location !== c.location || isDown(holder) ? { won: true } : grapple(world, c, holder, mult);
      if (r.kind === 'tied') g.won = roll(world) < 0.1 * combatProfile(world, c).force;
      ex.hit = g.won;
      if (g.won) { release(world, c, 'broke free'); if (r.kind === 'tied' && r.cordId) dropCord(world, c, r.cordId); ex.effects.push('broke free'); }
      break;
    }
    case 'pull_away': {
      if (me.touchedBy?.id === t.id) { me.touchedBy = null; endTouch(world, t, c); ex.effects.push('pulled away'); }
      if (me.restraint?.by === t.id && me.restraint.kind === 'held') {
        const g = grapple(world, c, t, 1.2);
        if (g.won) { release(world, c, 'pulled away'); ex.effects.push('broke free'); } else ex.hit = false;
      }
      C.onUnwelcome?.(c, t, 'pulled away');
      break;
    }
    case 'yield': me.yielded = world.now; alts.yielded(c); ex.effects.push('yielded'); break;
    case 'plead': ex.effects.push('pleading'); break;
    default: break;
  }
  if (alt) alts.record(alt, ex);
  announce(world, c, t, alt, ex, { serious: action === 'yield' });
  return null;
}

// ---------- caring ----------
function caring({ world, c, t, action, a, h, C }) {
  const alts = world.altercations;
  const words = String(a.words ?? '').trim().slice(0, 160) || null;
  const reason = String(a.reason ?? '').trim().slice(0, 200) || null;
  const ex = { actor: c.id, action, target: t.id, hit: true, effects: [], words, reason };
  const tp = ph(t);
  let res = null;
  switch (action) {
    case 'help_up':
      if (!tp.prone) return { stale: `${ref(t)} is already on ${pronouns(t).poss} feet.` };
      if (tp.restraint?.kind === 'pinned' || tp.restraint?.kind === 'tied') return { stale: `${ref(t)} can't get up like that.` };
      if (!isDown(t)) { tp.prone = false; ex.effects.push('on their feet'); }
      break;
    case 'free': {
      if (tp.restraint?.kind !== 'tied') return { stale: `${ref(t)} isn't tied.` };
      res = { minutes: MINUTES.free, doing: `untying ${t.name}`, memory: `You untied ${ref(t)}.` };
      const cord = tp.restraint.cordId;
      release(world, t, 'freed');
      if (cord) dropCord(world, t, cord);
      ex.effects.push('freed');
      break;
    }
    case 'hold_back': {
      const alt = alts.of(t);
      if (!alt) return { stale: `${ref(t)} isn't fighting anyone.` };
      const g = grapple(world, c, t, 1.3); // from behind, while they are busy with someone else
      ex.hit = g.won;
      alts.joinSide(c, alt, alt.participants.find((p) => p.id !== t.id && alt.participants.find((q) => q.id === t.id)?.side !== p.side)?.id ?? t.id, 'holder');
      if (g.won) { restrain(world, t, c, 'held', { caring: true }); ex.effects.push('held back'); res = { minutes: 5, doing: `holding ${t.name} back`, memory: `You held ${ref(t)} back.` }; }
      alts.record(alt, ex);
      C.onHoldBack(c, t, alt, g.won);
      break;
    }
    default: {
      // embrace, hold_hand, comfort, support: welcome or not, from the target's side
      const welcome = C.welcomeness(t, c);
      ex.welcome = welcome.welcome;
      const minutes = MINUTES[action];
      tp.touchedBy = { id: c.id, kind: action, until: world.now + minutes, welcome: welcome.welcome };
      if (action === 'support' && welcome.welcome && !isDown(t)) t.following = { id: c.id, since: world.now, support: true };
      res = { minutes, doing: `${VERB[action][0].replace('the shoulder of', '')} ${t.name}`.replace(/\s+/g, ' ').trim(), memory: `You ${VERB[action][0]} ${ref(t)}.` };
      ex.effects.push(welcome.welcome ? 'welcome' : 'unwelcome');
      C.onTouch(c, t, action, welcome);
    }
  }
  const alt = alts.of(t) ?? alts.of(c);
  if (alt && action !== 'hold_back') { alts.joinSide(c, alt, t.id, 'joined'); alts.record(alt, ex); }
  announce(world, c, t, alt, ex, {});
  C.onCare(c, t, action, reason, ex);
  return res;
}

export function endTouch(world, toucher, touched) {
  if (toucher?.activity.type === 'doing' && toucher.activity.detail?.kind === 'act' && toucher.activity.detail.targetId === touched.id) world.setActivity(toucher, { type: 'idle' });
}

function dropCord(world, c, cordId) {
  const cord = world.objects.get(cordId);
  if (cord && c.location) world.objects.change(cord.id, { roomId: c.location, placement: { relation: 'floor', of: null }, data: { ...cord.data, spot: c.spot } }, { actorId: 'code', action: 'move', notify: false });
}

/** tie_up's two minutes are over: if they are still helpless, they are tied (the cord goes on them). */
export function finishAct(world, c, a) {
  const d = a.detail ?? {};
  world.setActivity(c, { type: 'idle' });
  if (d.act !== 'tie_up') { world.scheduler.poke(); return; }
  const t = world.citizens.get(d.targetId);
  const cord = world.objects.get(d.cordId);
  if (!t || t.location !== c.location || !cord || cord.holderId !== c.id) {
    world.perceive([c.id], { kind: 'timer', text: 'You never got the knots tied.', importance: 6, roomId: c.location, data: { altercation: world.altercations.of(c)?.id ?? null, role: 'aggressor' } });
    return;
  }
  if (!(helpless(t) || t.phys?.restraint?.by === c.id)) {
    world.perceive([c.id], { kind: 'timer', text: `${ref(t)} twisted away before you could tie the knots.`, importance: 7, roomId: c.location, data: { altercation: world.altercations.of(c)?.id ?? null, role: 'aggressor' } });
    return;
  }
  world.objects.change(cord.id, { holderId: t.id, placement: { relation: 'worn', of: null } }, { actorId: c.id, action: 'give', notify: false });
  if (c.phys?.holding === t.id) c.phys.holding = null;
  restrain(world, t, c, 'tied', { cordId: cord.id });
  c.phys.holding = null;
  const alt = world.altercations.of(c) ?? world.altercations.of(t);
  const ex = { actor: c.id, action: 'tie_up', target: t.id, hit: true, effects: ['tied'] };
  if (alt) world.altercations.record(alt, ex);
  announce(world, c, t, alt, ex, { serious: true });
  const tieIntent = c.intents?.[t.id]?.intent ?? 'subdue';
  world.physical.consequences.onAct({ actor: c, target: t, action: 'tie_up', intent: tieIntent, ex, alt, weapon: null });
  const law = world.physical.consequences.crimeFor(c, t, tieIntent, alt); // step 11.5 (C1)
  if (law.crime) world.physical.consequences.crime(c, t, 'unlawful_restraint', 3, { intent: tieIntent, ...(law.claimed ? { claimed: law.claimed } : {}) });
}

// ---------- what everyone perceives ----------
const OBJ = (world, viewer, t) => (viewer.id === t.id ? 'you' : ref(t));
function describe(world, viewer, c, t, ex) {
  const you = viewer.id === c.id;
  const S = you ? 'You' : ref(c);
  const v = VERB[ex.action] ?? [ex.action, `${ex.action}s`];
  const verb = you ? v[0] : v[1];
  const tgt = OBJ(world, viewer, t);
  const tPoss = viewer.id === t.id ? 'your' : `${ref(t)}'s`;
  const part = ex.part ? partWord(world, ex.part) : null;
  const withO = ex.with ? world.objects.resolve(ex.with) : null;
  const withText = withO ? ` with ${world.objects.surfaceText(withO)}` : '';
  const said = ex.words ? ` "${ex.words}"` : '';
  const fx = ex.effects ?? [];
  const tSubj = viewer.id === t.id ? 'you' : pronouns(t).subj;
  const after = [];
  if (fx.includes('knocked down')) after.push(viewer.id === t.id ? 'You go down.' : `${ref(t)} goes down.`);
  if (fx.includes('dazed')) after.push(viewer.id === t.id ? 'Your head rings; the room swims.' : `${ref(t)} reels, dazed.`);
  if (fx.includes('winded')) after.push(viewer.id === t.id ? 'The breath goes out of you.' : `${ref(t)} doubles over, winded.`);
  if (fx.includes('disarmed')) after.push(viewer.id === t.id ? 'What you held falls from your hand.' : `${ref(t)} drops what ${tSubj} was holding.`);
  if (fx.includes('bone broken')) after.push(viewer.id === t.id ? `Something in your ${part ?? 'body'} gives with a crack.` : `There is a crack of bone.`);
  if (fx.includes('bleeding')) after.push(viewer.id === t.id ? `Blood runs from your ${part ?? 'wound'}.` : `Blood runs from ${tPoss} ${part ?? 'wound'}.`);
  if (fx.includes('weapon broke')) after.push(withO ? `${world.objects.surfaceText(withO)} breaks.`.replace(/^./, (x) => x.toUpperCase()) : 'The weapon breaks.');
  if (fx.includes('dead')) after.push(viewer.id === t.id ? '' : `${ref(t)} goes still.`);
  else if (fx.includes('unconscious')) after.push(viewer.id === t.id ? 'Everything goes dark.' : `${ref(t)} goes limp.`);
  let main;
  switch (ex.action) {
    case 'strike': main = ex.hit ? `${S} ${verb} ${tgt}${part && part !== 'random' ? ` on the ${part}` : ''}${withText}.` : `${S} ${you ? 'swing' : 'swings'} at ${tgt}${withText} and ${you ? 'miss' : 'misses'}.`; break;
    case 'throw_at': main = ex.hit ? `${S} ${verb} ${withO ? world.objects.surfaceText(withO) : 'something'} at ${tgt}; it hits${part ? ` ${viewer.id === t.id ? 'your' : pronouns(t).poss} ${part}` : ''}.` : `${S} ${verb} ${withO ? world.objects.surfaceText(withO) : 'something'} at ${tgt} and ${you ? 'miss' : 'misses'}.`; break;
    case 'grab': main = ex.hit ? `${S} ${verb} ${tgt} and ${you ? 'hold' : 'holds'} on.` : `${S} ${you ? 'try' : 'tries'} to grab ${tgt}, but ${viewer.id === t.id ? 'you twist' : `${tSubj} twists`} away.`; break;
    case 'pin_down': main = ex.hit ? `${S} ${verb} ${tgt} to the floor.` : `${S} ${you ? 'try' : 'tries'} to pin ${tgt} down and ${you ? 'fail' : 'fails'}.`; break;
    case 'choke': main = ex.hit ? `${S} ${you ? 'have' : 'has'} ${viewer.id === t.id ? 'you' : ref(t)} by the throat, squeezing.${viewer.id === t.id ? ' You cannot breathe.' : ''}` : `${S} ${you ? 'grab' : 'grabs'} for ${viewer.id === t.id ? 'your' : `${ref(t)}'s`} throat and ${you ? 'miss' : 'misses'}.`; break;
    case 'snatch': main = ex.hit ? `${S} ${verb} something from ${viewer.id === t.id ? 'your hands' : `${ref(t)}'s hands`}.` : `${S} ${you ? 'grab' : 'grabs'} at what ${viewer.id === t.id ? 'you hold' : `${ref(t)} holds`}, but ${viewer.id === t.id ? 'you keep' : `${tSubj} keeps`} it.`; break;
    case 'tie_up': main = fx.includes('tied') ? `${S} ${you ? 'have' : 'has'} ${tgt} tied up.` : `${S} ${you ? 'start' : 'starts'} tying ${tgt} up.`; break;
    case 'drag': main = ex.hit ? `${S} ${verb} ${tgt} across the floor.` : `${S} ${you ? 'try' : 'tries'} to drag ${tgt} and can't.`; break;
    case 'shove': main = ex.hit ? `${S} ${verb} ${tgt}${fx.includes('staggered') ? (viewer.id === t.id ? '; you stagger back' : `; ${tSubj} staggers back`) : ''}.` : `${S} ${you ? 'try' : 'tries'} to shove ${tgt}, but ${viewer.id === t.id ? 'you keep' : `${tSubj} keeps`} ${viewer.id === t.id ? 'your' : pronouns(t).poss} footing.`; break;
    case 'dodge': main = `${S} ${you ? 'are' : 'is'} ready to dodge.`; break;
    case 'block': main = `${S} ${you ? 'raise' : 'raises'} ${you ? 'your' : pronouns(c).poss} guard.`; break;
    case 'break_free': main = ex.hit ? `${S} ${you ? 'break' : 'breaks'} free.` : `${S} ${you ? 'struggle' : 'struggles'} but can't get free.`; break;
    case 'pull_away': main = `${S} ${you ? 'pull' : 'pulls'} away from ${tgt}.`; break;
    case 'yield': main = `${S} ${you ? 'raise' : 'raises'} ${you ? 'your' : pronouns(c).poss} hands: ${you ? 'you give' : `${pronouns(c).subj} gives`} up.`; break;
    case 'plead': main = `${S} ${you ? 'beg' : 'begs'} ${tgt} to stop.`; break;
    case 'help_up': main = `${S} ${verb} ${tgt}.`; break;
    case 'free': main = `${S} ${verb} ${tgt}.`; break;
    case 'hold_back': main = ex.hit ? `${S} ${verb} ${tgt}, arms locked around ${viewer.id === t.id ? 'you' : pronouns(t).obj}.` : `${S} ${you ? 'try' : 'tries'} to hold ${tgt} back and ${you ? 'are' : 'is'} shaken off.`; break;
    case 'embrace': case 'hold_hand': case 'comfort': case 'support': {
      const verbText = you ? v[0] : v[1].replace('their', pronouns(c).poss);
      main = `${S} ${verbText} ${tgt}.`;
      if (viewer.id === t.id && ex.welcome === false) main += " You don't want it.";
      break;
    }
    default: main = ex.hit ? `${S} ${verb} ${tgt}${part && part !== 'random' ? ` in the ${part}` : ''}.` : `${S} ${you ? 'swing' : 'swings'} at ${tgt} and ${you ? 'miss' : 'misses'}.`;
  }
  return `${main}${said ? ` ${you ? 'You say' : `${pronouns(c).subj[0].toUpperCase()}${pronouns(c).subj.slice(1)} says`}:${said}` : ''} ${after.filter(Boolean).join(' ')}`.trim();
}

export function announce(world, c, t, alt, ex, { serious = false, quietToTarget = false } = {}) {
  const room = c.location;
  const everyone = citizensIn(world.citizens, room).filter((o) => o.alive);
  const aggressive = AGGRESSIVE.includes(ex.action);
  const firstBlow = alt && alt.exchanges.filter((e) => AGGRESSIVE.includes(e.action)).length <= 1;
  const bloody = (ex.effects ?? []).some((f) => ['bleeding', 'bone broken', 'knocked down', 'choking', 'unconscious', 'dead'].includes(f));
  const weaponDrawn = Boolean(ex.with);
  world.perceive(everyone.map((o) => o.id), (o) => {
    const text = describe(world, o, c, t, ex);
    if (o.id === t.id) return { kind: 'action', text, importance: quietToTarget ? 6 : aggressive ? 9 : ex.action === 'yield' || ex.action === 'plead' ? 8 : 7, sourceId: c.id, roomId: room, data: { interrupt: aggressive || ex.welcome === false, wake: true, altercation: alt?.id ?? null, role: 'target', act: ex.action, welcome: ex.welcome ?? null } };
    if (o.id === c.id) return { kind: 'action', text, importance: aggressive ? 8 : 6, sourceId: c.id, roomId: room, data: { altercation: alt?.id ?? null, role: aggressive ? 'aggressor' : 'self', act: ex.action } };
    const imp = aggressive ? (firstBlow || bloody || weaponDrawn || serious ? 8 : 5) : ex.action === 'yield' ? 8 : 4;
    return { kind: 'action', text, importance: imp, sourceId: c.id, roomId: room, data: { altercation: alt?.id ?? null, role: 'bystander', act: ex.action, interrupt: imp >= 8 } };
  });
  world.logEvent('physical', { actorId: c.id, location: room, targetId: t.id, act: ex.action, hit: ex.hit, aim: ex.aim ?? null, part: ex.part ?? null, effects: ex.effects ?? [], conditions: ex.conditions ?? [], with: ex.with ?? null, intent: ex.intent ?? null, altercationId: alt?.id ?? null, words: ex.words ?? null, reason: ex.reason ?? null });
}

// ---------- every tick: holds, chokes, posture ----------
export function tickBodies(world, elapsed) {
  for (const c of world.citizens.values()) {
    const p = c.phys;
    if (!p || !c.alive) continue;
    // a hold lasts while the holder is here, awake and still holding
    const r = p.restraint;
    if (r && r.kind !== 'tied') {
      const by = world.citizens.get(r.by);
      if (!by || !by.alive || by.location !== c.location || isDown(by) || (by.phys?.holding && by.phys.holding !== c.id)) release(world, c, 'let go');
      else if (by.activity.type === 'doing' && by.activity.detail?.kind === 'act' && by.activity.detail.targetId !== c.id && !['strike', 'punch', 'slap', 'kick'].includes(by.activity.detail.act)) release(world, c, 'let go');
      // busy with anything else (work, a wait, a walk, sleep): the hold is gone — talking keeps it (a GLM run held someone 47 minutes)
      else if (['sleeping', 'moving'].includes(by.activity.type) || ((by.activity.type === 'doing' || by.activity.type === 'waiting') && by.activity.detail?.kind !== 'act')) release(world, c, 'let go');
    }
    if (r?.kind === 'tied' && c.location == null) { /* stays tied, wherever they are */ }
    // choking eases once the hands are gone
    if ((p.asphyxia ?? 0) > 0 && (world.now - (p.lastChokedAt ?? -Infinity) > 0.6)) {
      const before = p.asphyxia;
      p.asphyxia = Math.max(0, Math.round((p.asphyxia - 0.5 * elapsed) * 100) / 100);
      if (p.asphyxia === 0) { p.chokedBy = null; p.chokeDeathAt = null; }
      if (Math.floor(before) !== Math.floor(p.asphyxia)) world.body.recompute(c);
    }
    if (p.touchedBy && p.touchedBy.until <= world.now) p.touchedBy = null;
    if (p.prone && (isDown(c) || c.activity.type === 'sleeping')) { /* lying anyway */ }
  }
}

/** get_up: back on their feet. */
export function getUp(world, c, call, h) {
  const p = ph(c);
  if (!p.prone) return h.stale(world, c, call, 'You are already on your feet.');
  if (p.restraint && ['pinned', 'tied'].includes(p.restraint.kind)) return h.stale(world, c, call, p.restraint.kind === 'tied' ? 'Tied as you are, you cannot get up.' : 'You are pinned; you would have to break free first.');
  if ((c.body?.capacities?.moving ?? 1) < 0.1) return h.stale(world, c, call, "Your legs won't hold you.");
  h.logAction(world, c, call, {});
  p.prone = false;
  world.setActivity(c, { type: 'doing', until: world.now + 0.2, detail: { kind: 'act', act: 'get_up', description: 'getting up', minutes: 0.2 } });
  const others = citizensIn(world.citizens, c.location, { exceptId: c.id });
  world.perceive(others.map((o) => o.id), { kind: 'action', text: `${ref(c)} gets back on ${pronouns(c).poss} feet.`, importance: world.altercations.of(c) ? 7 : 4, sourceId: c.id, roomId: c.location, data: { altercation: world.altercations.of(c)?.id ?? null, role: 'bystander' } });
  h.remember(world, c, 'You got back on your feet.');
  return { ok: true };
}

export { isDark };
