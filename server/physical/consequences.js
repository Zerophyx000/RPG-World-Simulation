// Step 10 §5–§6: consequences that stick. Acts shape what comes after; nobody beats someone up and then switches to
// "oh, he's hurt, let me help" as if nothing happened.
//
//   deeds (c.deeds)      what the actor did, aggregated per victim and fight: WHAT YOU'VE DONE in every prompt for 6 game
//                        hours, 3 days (and pinned on their mind) when serious — killing, maiming, tying up, arson
//   intents (c.intents)  { otherId: { intent, at, altId } }: "You came at him to hurt him." until they change it
//   victim / witnesses   memories, relationship events with concrete reasons, fear and anger aimed at the attacker,
//                        lasting wariness (c.wary), village dread when it was bloody
//   aftermath            at a fight's end: adrenaline, then guilt / pride / fear of retaliation / shame by personality;
//                        a killer also fears discovery while the body lies unburied or witnesses live (c.discovery)
//   reversal (§5.3)      caring for someone you went at within the hour needs a reason; the victim perceives it with the
//                        attack still fresh; it never resets anything (at most a small separate event if believed)
//   welcomeness (§5.4)   caring touch from the target's side: affinity, trust, fear, anger, recent harm
//   crimes               every aggressive act, theft by force, restraint, arson and killing → a 'crime' event (law hook)
import { citizensIn } from '../world/rooms.js';
import { ref, plainRef } from '../memory/index.js';
import { pronouns } from '../world/citizens.js';
import { relativeTime } from '../world/time.js';
import { AGGRESSIVE } from './altercations.js';

const HOUR = 60;
const DAY = 1440;
const SHORT_DEED = 6 * HOUR;
const SERIOUS_DEED = 3 * DAY;
const INTENT_KEEP = 6 * HOUR;
const REMORSE = /sorry|didn'?t mean|never meant|too far|regret|wrong|forgive|mistake|shouldn'?t have|ashamed|guilt|my fault|enough|stop(ped)?|changed my mind|can'?t leave|let (him|her|them) die/i;
const MEAN = { scare: 'to scare', subdue: 'to subdue', hurt: 'to hurt', kill: 'to kill', defend: 'to defend yourself against', care: 'to help' };
const PAST = { shove: 'shoved', grab: 'grabbed', slap: 'slapped', punch: 'punched', kick: 'kicked', strike: 'hit', throw_at: 'threw something at', snatch: 'snatched from', pin_down: 'pinned down', choke: 'choked', tie_up: 'tied up', drag: 'dragged' };
const SEVERITY = { assault: 2, theft_by_force: 2, unlawful_restraint: 3, arson: 4, attempted_murder: 4, manslaughter: 4, murder: 5 };

const trait = (c, k) => c.persona?.traits?.[k] ?? 0.5;

export class Consequences {
  constructor(world) {
    this.world = world;
  }

  // ---------- intents ----------
  setIntent(c, t, intent, { inferred = false } = {}) {
    const prev = c.intents?.[t.id]?.intent ?? null;
    c.intents = { ...(c.intents ?? {}), [t.id]: { intent, at: this.world.now, altId: this.world.altercations?.of(c)?.id ?? null, ...(inferred ? { inferred: true } : {}) } };
    if (prev !== intent) this.world.logEvent('intent', { actorId: c.id, location: c.location, targetId: t.id, intent, from: prev, inferred });
  }

  intentToward(c, otherId) {
    const i = c.intents?.[otherId];
    if (!i) return null;
    return this.world.now - i.at <= INTENT_KEEP || this.world.altercations?.of(c) ? i : null;
  }

  // ---------- deeds ----------
  recentAggression(c, minutes = 60) {
    return (c.deeds ?? []).filter((d) => this.world.now - d.lastAt <= minutes);
  }

  #deed(c, t, alt) {
    c.deeds ??= [];
    let d = c.deeds.find((x) => x.victimId === t.id && x.altId === (alt?.id ?? null) && this.world.now - x.lastAt < 2 * HOUR);
    if (!d) {
      d = { id: `dd${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`, at: this.world.now, lastAt: this.world.now, victimId: t.id, altId: alt?.id ?? null, acts: {}, with: [], effects: [], parts: [], intent: 'hurt', serious: false, until: this.world.now + SHORT_DEED, place: c.location, pinned: false };
      c.deeds.push(d);
      if (c.deeds.length > 20) c.deeds.splice(0, c.deeds.length - 20);
    }
    return d;
  }

  onAct({ actor: c, target: t, action, intent, ex, alt, withObj }) {
    const w = this.world;
    if (!AGGRESSIVE.includes(action)) return;
    const d = this.#deed(c, t, alt);
    const first = Object.keys(d.acts).length === 0;
    d.lastAt = w.now;
    d.intent = intent;
    d.acts[action] = (d.acts[action] ?? 0) + (ex.hit ? 1 : 0.0001);
    if (withObj) d.with = [...new Set([...d.with, w.objects.type(withObj)?.name ?? 'something'])];
    const fx = ex.effects ?? [];
    d.effects = [...new Set([...d.effects, ...fx])];
    for (const x of ex.conditions ?? []) if (x.type === 'fracture' || x.severity >= 5) d.parts.push({ type: x.type, part: x.part });
    const serious = intent === 'kill' || fx.includes('dead') || fx.includes('bone broken') || fx.includes('tied') || (ex.conditions ?? []).some((x) => x.severity >= 6);
    if (serious && !d.serious) { d.serious = true; }
    d.until = w.now + (d.serious ? SERIOUS_DEED : SHORT_DEED);
    if (d.serious && !d.pinned) {
      d.pinned = true;
      w.memory.pushOnMind(c, { text: `What I did to ${plainRef(t)}${fx.includes('dead') ? ' — I killed them' : ''}.`, importance: 9, pinnedUntil: w.now + SERIOUS_DEED });
    }
    const witnesses = citizensIn(w.citizens, c.location).filter((o) => o.id !== c.id && o.id !== t.id && o.alive && !['sleeping', 'collapsed'].includes(o.activity.type));
    d.witnesses = [...new Set([...(d.witnesses ?? []), ...witnesses.map((o) => o.id)])];
    w.saveCitizen(c);

    // ---- the victim ----
    if (t.alive && ex.hit) {
      const hurt = fx.some((f) => ['bleeding', 'bone broken', 'unconscious', 'knocked down', 'choking'].includes(f)) || (ex.conditions ?? []).length > 0;
      w.emotions.bump(t, { type: 'fear', target: c.id, delta: hurt ? 2 : 1, cause: `${ref(c)} ${PAST[action] ?? 'attacked'} me`, source: 'violence', raw: true });
      w.emotions.bump(t, { type: 'anger', target: c.id, delta: trait(t, 'neuroticism') > 0.65 ? 0.8 : 1.5, cause: `${ref(c)} ${PAST[action] ?? 'attacked'} me`, source: 'violence', raw: true });
      t.wary = { ...(t.wary ?? {}), [c.id]: { since: t.wary?.[c.id]?.since ?? w.now, last: w.now, why: PAST[action] ?? 'attacked' } };
      if (!d.relDone) {
        d.relDone = true;
        const k = { scare: [-1, -1], subdue: [-1.5, -2], hurt: [-2.5, -2.5], kill: [-4, -4], defend: [-1, -1] }[intent] ?? [-2, -2];
        w.relationships.change(t.id, c.id, { affinity: k[0], trust: k[1] }, { reason: `${ref(c)} ${PAST[action] ?? 'attacked'} me${withObj ? ` with ${w.objects.surfaceText(withObj)}` : ''}${w.rooms.get(c.location) ? ` in ${w.rooms.get(c.location).name}` : ''}`, source: 'witness', evidence: { altercationId: alt?.id ?? null, act: action } });
        w.memory.add(t.id, { kind: 'episodic', text: `${ref(c)} ${PAST[action] ?? 'attacked'} me${withObj ? ` with ${w.objects.surfaceText(withObj)}` : ''}.`, importance: intent === 'kill' ? 9 : 8, about: [c.id], placeId: c.location, source: { altercationId: alt?.id ?? null } });
      }
      if (fx.includes('bone broken') && !d.toldBone) {
        d.toldBone = true;
        w.relationships.change(t.id, c.id, { affinity: -1, trust: -1 }, { reason: `${ref(c)} broke a bone of mine${withObj ? ` with ${w.objects.surfaceText(withObj)}` : ''}`, source: 'witness', evidence: { altercationId: alt?.id ?? null } });
      }
    }
    // ---- witnesses ----
    if (first || fx.includes('dead')) {
      for (const o of witnesses) {
        const likeVictim = w.memory.rel(o.id, t.id)?.affinity ?? 0;
        const likeActor = w.memory.rel(o.id, c.id)?.affinity ?? 0;
        const dA = likeVictim >= likeActor ? (fx.includes('dead') ? -3 : intent === 'kill' || withObj ? -1.5 : -0.7) : 0;
        const what = fx.includes('dead') ? `killed ${ref(t)}` : `${PAST[action] ?? 'attacked'} ${ref(t)}`;
        if (dA) w.relationships.change(o.id, c.id, { affinity: dA, trust: dA / 2 }, { reason: `${ref(c)} ${what}${withObj ? ` with ${w.objects.surfaceText(withObj)}` : ''} in ${w.rooms.get(c.location)?.name ?? 'front of me'}`, source: 'witness', evidence: { altercationId: alt?.id ?? null } });
        w.memory.add(o.id, { kind: 'episodic', text: `I saw ${ref(c)} ${what}${withObj ? ` with ${w.objects.surfaceText(withObj)}` : ''}.`, importance: fx.includes('dead') ? 9 : 6, about: [c.id, t.id], placeId: c.location, source: { altercationId: alt?.id ?? null, witnessed: true } });
        if (likeVictim >= likeActor) w.emotions.bump(o, { type: 'fear', target: null, delta: fx.includes('dead') || withObj ? 1.5 : 0.7, cause: `${ref(c)} ${what}`, source: 'violence', raw: true });
      }
    }
    // ---- crime (law hook): one per kind per deed ----
    const kind = fx.includes('dead') ? 'murder' : intent === 'kill' ? 'attempted_murder' : action === 'snatch' ? null : 'assault';
    if (kind && !(d.crimes ?? []).includes(kind)) {
      d.crimes = [...(d.crimes ?? []), kind];
      this.crime(c, t, kind, SEVERITY[kind], { witnesses: d.witnesses, altercationId: alt?.id ?? null });
    }
    // ---- dread: violence that drew blood or a weapon ----
    if ((fx.includes('dead') || fx.includes('bone broken') || (withObj && ex.hit)) && !d.dread) {
      d.dread = true;
      const mapId = w.maps.mapOf?.(c.location);
      if (mapId && w.deaths) w.deaths.raiseDread(mapId, fx.includes('dead') ? 2 : 1, `violence in ${w.rooms.get(c.location)?.name ?? 'the village'}`);
    }
    if (fx.includes('dead')) this.#killed(c, t, d);
  }

  #killed(c, t, d) {
    const w = this.world;
    c.discovery = { deadId: t.id, since: w.now, witnesses: d.witnesses ?? [] };
    w.emotions.bump(c, { type: 'fear', target: null, delta: 3, cause: `what I did to ${plainRef(t)}, and being found out`, source: 'violence', raw: true });
    w.saveCitizen(c);
  }

/** Someone died: if a living person struck them within the day, the death is theirs (also when the wounds took time). */
  onDeath(dead) {
    const w = this.world;
    for (const c of w.citizens.values()) {
      if (!c.alive || c.id === dead.id) continue;
      const d = (c.deeds ?? []).filter((x) => x.victimId === dead.id && w.now - x.lastAt < DAY && Object.values(x.acts).some((n) => n >= 1)).at(-1);
      if (!d || d.effects.includes('dead')) continue;
      d.effects = [...d.effects, 'dead'];
      d.serious = true;
      d.until = w.now + SERIOUS_DEED;
      if (!d.pinned) { d.pinned = true; w.memory.pushOnMind(c, { text: `What I did to ${plainRef(dead)}.`, importance: 9, pinnedUntil: w.now + SERIOUS_DEED }); }
      const kind = d.intent === 'kill' ? 'murder' : 'manslaughter';
      if (!(d.crimes ?? []).includes(kind)) { d.crimes = [...(d.crimes ?? []), kind]; this.crime(c, dead, kind, kind === 'murder' ? 5 : 4, { witnesses: d.witnesses ?? [], altercationId: d.altId, cause: dead.diedCause ?? null }); }
      this.#killed(c, dead, d);
    }
  }

  crime(c, t, kind, severity, extra = {}) {
    const w = this.world;
    const witnesses = extra.witnesses ?? citizensIn(w.citizens, c.location).filter((o) => o.id !== c.id && o.id !== t?.id && o.alive && !['sleeping', 'collapsed'].includes(o.activity.type)).map((o) => o.id);
    w.logEvent('crime', { actorId: c.id, location: c.location, kind, victimId: t?.id ?? null, witnesses, severity: severity ?? SEVERITY[kind] ?? 2, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'witnesses')) });
  }

  // ---------- the end of a fight: aftermath appraisals ----------
  onAltercationEnd(alt) {
    const w = this.world;
    for (const p of alt.participants) {
      const c = w.citizens.get(p.id);
      if (!c?.alive) continue;
      const mine = alt.exchanges.filter((e) => e.actor === c.id && AGGRESSIVE.includes(e.action) && e.hit);
      if (!mine.length) continue;
      const victims = [...new Set(mine.map((e) => e.target))];
      const serious = (c.deeds ?? []).some((d) => d.altId === alt.id && d.serious);
      const killed = (c.deeds ?? []).some((d) => d.altId === alt.id && d.effects.includes('dead'));
      // adrenaline first
      w.emotions.bump(c, { type: 'fear', target: null, delta: 1.5, cause: 'the fight; your hands are still shaking', source: 'aftermath', raw: true });
      for (const vid of victims) {
        const v = w.citizens.get(vid);
        const aff = w.memory.rel(c.id, vid)?.affinity ?? 0;
        const kind = trait(c, 'agreeableness') >= 0.5 || trait(c, 'conscientiousness') >= 0.6 || aff >= 2;
        const hard = trait(c, 'agreeableness') < 0.35 || aff <= -3;
        if (kind) w.emotions.bump(c, { type: 'guilt', target: vid, delta: (serious ? 3 : 2) + (killed ? 2 : 0), cause: `what I did to ${v ? plainRef(v) : 'them'}`, source: 'aftermath', raw: true });
        if (hard && !kind) w.emotions.bump(c, { type: 'pride', target: null, delta: killed ? 1 : 2, cause: `I showed ${v ? plainRef(v) : 'them'}`, source: 'aftermath', raw: true });
        else if (hard) w.emotions.bump(c, { type: 'pride', target: null, delta: 1, cause: `I didn't back down from ${v ? plainRef(v) : 'them'}`, source: 'aftermath', raw: true });
        // fear of retaliation: the victim has people
        const friends = [...w.citizens.values()].filter((o) => o.alive && o.id !== vid && o.id !== c.id && v && (w.deaths?.closeness(o, v)?.close));
        if (friends.length) w.emotions.bump(c, { type: 'fear', target: null, delta: 1.5, cause: `${v ? plainRef(v) : 'their'}'s people may come for me`, source: 'aftermath', raw: true });
        // shame, if those who saw it side with the victim
        const disapprove = (c.deeds ?? []).find((d) => d.altId === alt.id && d.victimId === vid)?.witnesses?.some((oid) => (w.memory.rel(oid, vid)?.affinity ?? 0) > (w.memory.rel(oid, c.id)?.affinity ?? 0));
        if (disapprove) w.emotions.bump(c, { type: 'shame', target: null, delta: 1.5, cause: 'people saw what I did', source: 'aftermath', raw: true });
      }
      w.logEvent('aftermath', { actorId: c.id, location: alt.roomId, altercationId: alt.id, victims, serious, killed });
    }
    // everyone involved remembers how it ended
    const here = new Set([...alt.participants.map((p) => p.id)]);
    for (const id of here) {
      const c = w.citizens.get(id);
      if (!c?.alive) continue;
      const others = alt.participants.filter((p) => p.id !== id).map((p) => ref(w.citizens.get(p.id) ?? p.id));
      w.memory.add(id, { kind: 'episodic', text: `A fight with ${others.join(' and ')} in ${w.rooms.get(alt.roomId)?.name ?? 'the village'} — it ended ${{ fled: 'when one side ran', yielded: 'when one side gave up', unconscious: 'with someone senseless', dead: 'with someone dead', separated: 'when we were pulled apart', cooled: 'when the fighting stopped' }[alt.endReason] ?? 'at last'}.`, importance: 7, about: alt.participants.map((p) => p.id).filter((x) => x !== id), placeId: alt.roomId, source: { altercationId: alt.id } });
    }
    for (const c of w.citizens.values()) {
      for (const [oid, i] of Object.entries(c.intents ?? {})) if (i.altId === alt.id) i.endedAt = w.now;
    }
  }

  // ---------- caring touch ----------
  welcomeness(t, c) {
    const w = this.world;
    const rel = w.memory.rel(t.id, c.id);
    const aff = rel?.affinity ?? 0;
    const trust = rel?.trust ?? 0;
    const emo = (type) => Math.max(0, ...w.emotions.of(t).filter((e) => e.type === type && e.target === c.id).map((e) => e.intensity));
    const harmed = (c.deeds ?? []).some((d) => d.victimId === t.id && w.now - d.lastAt < DAY);
    const low = Math.max(0, ...w.emotions.of(t).filter((e) => (e.type === 'sadness' || e.type === 'fear') && e.target !== c.id).map((e) => e.intensity));
    const score = 0.5 * aff + 0.3 * trust - 0.6 * emo('fear') - 0.5 * emo('anger') - 0.4 * emo('disgust') - (harmed ? 6 : 0) + (low >= 5 && aff >= 0 ? 1 : 0) + (rel?.nameKnown ? 0.3 : -1);
    return { welcome: score >= 0, score: Math.round(score * 10) / 10, harmed };
  }

  onTouch(c, t, action, { welcome, harmed }) {
    const w = this.world;
    if (welcome) {
      for (const type of ['fear', 'sadness']) {
        for (const e of w.emotions.of(t).filter((x) => x.type === type && x.target !== c.id && x.intensity >= 1)) w.emotions.bump(t, { type, target: e.target, delta: action === 'embrace' ? -2 : -1, cause: `${ref(c)} was there for me`, source: 'comfort', raw: true });
      }
      w.emotions.bump(t, { type: 'affection', target: c.id, delta: 1, cause: `${ref(c)} ${action === 'embrace' ? 'held me' : 'was kind to me'}`, source: 'comfort', raw: true });
      w.relationships.change(t.id, c.id, { affinity: 0.4 }, { reason: `${ref(c)} ${action === 'embrace' ? 'held me' : action === 'hold_hand' ? 'held my hand' : 'comforted me'} when I needed it`, source: 'witness', aggregate: true });
    } else {
      const trust = w.memory.rel(t.id, c.id)?.trust ?? 0;
      w.emotions.bump(t, { type: harmed ? 'fear' : 'disgust', target: c.id, delta: harmed ? 1.5 : 1, cause: `${ref(c)} touched me when I didn't want it`, source: 'violence', raw: true });
      if (trust < 0 || harmed) w.relationships.change(t.id, c.id, { affinity: -0.5, trust: -0.5 }, { reason: `${ref(c)} put ${pronouns(c).poss} hands on me when I didn't want it`, source: 'witness' });
    }
    w.logEvent('touch', { actorId: c.id, location: c.location, targetId: t.id, act: action, welcome, harmed });
  }

  onUnwelcome(t, c) {
    // pulling away is seen; the toucher feels it
    this.world.emotions.bump(c, { type: 'shame', target: null, delta: 0.5, cause: `${ref(t)} pulled away from me`, source: 'appraisal', raw: true });
  }

  onHoldBack(c, t, alt, won) {
    const w = this.world;
    if (!won) return;
    w.relationships.change(t.id, c.id, { trust: -0.3 }, { reason: `${ref(c)} held me back from the fight`, source: 'witness' });
    for (const p of alt.participants) {
      if (p.id === t.id || p.id === c.id) continue;
      if (alt.participants.find((q) => q.id === t.id)?.side === p.side) continue;
      w.relationships.change(p.id, c.id, { affinity: 0.3 }, { reason: `${ref(c)} pulled ${ref(t)} off me`, source: 'witness' });
    }
  }

  // ---------- reversal: help from the one who hurt you ----------
  /** After a caring act (act_on) or help (treat, give, carry_person, feed, tell_news): the victim perceives it with the attack fresh. */
  onCare(c, t, action, reason) {
    const w = this.world;
    const deed = this.recentAggression(c, 60).find((d) => d.victimId === t.id);
    if (!deed) return;
    const mins = Math.max(1, Math.round(w.now - deed.lastAt));
    const what = Object.keys(deed.acts).length > 1 || (deed.acts.strike ?? 0) + (deed.acts.punch ?? 0) >= 2 ? 'beat you' : `${PAST[Object.keys(deed.acts)[0]] ?? 'attacked'} you`;
    const verb = { treat: 'kneels to tend you', give: 'holds something out to you', carry_person: 'tries to lift you', feed: 'tries to feed you', help_up: 'reaches to help you up', embrace: 'puts an arm around you', comfort: 'lays a hand on your shoulder', hold_hand: 'takes your hand', support: 'offers you an arm', free: 'unties you' }[action] ?? 'turns to help you';
    if (t.alive && !['sleeping', 'collapsed'].includes(t.activity.type)) {
      w.perceive([t.id], { kind: 'action', text: `${ref(c)}, who ${what} ${relativeTime(mins)}, ${verb}${reason ? `: "${reason}"` : '.'}`, importance: 8, sourceId: c.id, roomId: c.location, data: { reversal: true, interrupt: true, wake: true, altercation: deed.altId, role: 'target' } });
      const trust = w.memory.rel(t.id, c.id)?.trust ?? 0;
      if (trust < 1) w.emotions.bump(t, { type: 'fear', target: c.id, delta: 0.5, cause: `${ref(c)} is near me again`, source: 'violence', raw: true });
    }
    c.reversals = [...(c.reversals ?? []), { at: w.now, victimId: t.id, action, reason }].slice(-10);
    w.logEvent('coherence', { actorId: c.id, location: c.location, kind: 'reversal', action, victimId: t.id, reason: reason ?? null, minutesSince: mins, intent: deed.intent });
  }

  /** The victim accepted help and the reason sounds like remorse: a small, separate event (nothing is reset). */
  onAcceptedHelp(t, c) {
    const w = this.world;
    const r = (c.reversals ?? []).filter((x) => x.victimId === t.id && w.now - x.at < 60).at(-1);
    if (!r || !REMORSE.test(r.reason ?? '')) return;
    w.relationships.change(t.id, c.id, { affinity: 0.5 }, { reason: `${ref(c)} seemed sorry for what ${pronouns(c).subj} did, and helped me`, source: 'witness' });
  }

  /** §5.3 plausibility guard (think.js): switching from hurting to caring with no remorse and no change of mind. */
  coherenceCheck(c, call) {
    const w = this.world;
    const caringActs = ['embrace', 'hold_hand', 'comfort', 'help_up', 'support', 'free'];
    const helpTools = ['treat', 'give', 'carry_person', 'feed'];
    const name = call?.name;
    const args = call?.arguments ?? {};
    if (!(name === 'act_on' && caringActs.includes(args.action)) && !helpTools.includes(name)) return null;
    const present = citizensIn(w.citizens, c.location, { exceptId: c.id });
    const label = args.person ?? args.to ?? args.who ?? null;
    const labels = w.memory.labelsFor(c, present);
    let victim = label ? (present.find((o) => o.name.toLowerCase() === String(label).toLowerCase()) ?? labels.get(label)) : null;
    if (!victim && name === 'treat') {
      const m = /\[w(\d+)\]/.exec(String(args.wound ?? ''));
      victim = m ? present.find((o) => w.body.conditionById(o.id, m[1])) : null;
    }
    if (!victim) return null;
    const deed = this.recentAggression(c, 60).find((d) => d.victimId === victim.id && ['hurt', 'kill'].includes(d.intent));
    if (!deed) return null;
    const feel = args.feeling && typeof args.feeling === 'object' ? args.feeling : null;
    const remorseFelt = feel && ['guilt', 'shame', 'sadness'].includes(String(feel.emotion)) && feel.direction !== 'weaker';
    const changed = REMORSE.test(String(args.reason ?? '')) || REMORSE.test(String(args.inner_thought ?? ''));
    if (remorseFelt || changed) return null;
    return `You meant to ${deed.intent === 'kill' ? 'kill' : 'hurt'} ${pronouns(victim).obj} ${Math.max(1, Math.round(w.now - deed.lastAt))} minutes ago. If you've changed your mind, say why (reason).`;
  }

  // ---------- the prompt ----------
  /** WHAT YOU'VE DONE lines (already in the viewer's own words; names as ref tokens). */
  deedLines(c) {
    const w = this.world;
    const now = w.now;
    const out = [];
    for (const d of (c.deeds ?? []).filter((x) => x.until > now).slice(-4)) {
      const v = w.citizens.get(d.victimId);
      if (!v) continue;
      const P = pronouns(v);
      const acts = Object.entries(d.acts).filter(([, n]) => n >= 1);
      if (!acts.length) {
        out.push(`- ${relativeTime(now - d.lastAt)} you went at ${ref(v)}, meaning ${MEAN[d.intent] ?? 'to hurt'} ${P.obj}, and missed.`);
        continue;
      }
      const blows = (d.acts.strike ?? 0) + (d.acts.punch ?? 0) + (d.acts.kick ?? 0);
      const verb = blows >= 2 ? 'beat' : PAST[acts.sort((a, b) => b[1] - a[1])[0][0]] ?? 'attacked';
      const withText = d.with.length ? ` with ${d.with.map((n) => `your ${n}`).join(' and ')}` : '';
      let line = `- ${relativeTime(now - d.lastAt)} you ${verb} ${ref(v)}${withText}, meaning ${MEAN[d.intent] ?? 'to hurt'} ${P.obj}.`;
      const res = [];
      const bone = d.parts.find((x) => x.type === 'fracture');
      if (bone) res.push(`You broke ${P.poss} ${w.body?.content?.partLabel?.(bone.part) ?? 'bone'}`);
      if (d.effects.includes('tied')) res.push(`You tied ${P.obj} up`);
      const dead = !v.alive && (w.deaths?.knows(c, v.id) ?? true);
      if (dead) res.push(`${P.subj[0].toUpperCase()}${P.subj.slice(1)} is dead`);
      else if (v.location === c.location) {
        const st = (w.altercations?.stateWords(v) ?? []).filter((s) => ['bleeding', 'on the floor', 'senseless', 'tied up', 'choking'].includes(s));
        if (st.length) res.push(`${P.subj}'s ${st.join(', ')}`.replace(/^./, (x) => x.toUpperCase()));
      } else if (d.effects.includes('bleeding')) res.push(`When you last saw ${P.obj}, ${P.subj} was bleeding`);
      if (res.length) line += ` ${res.join('; ')}.`;
      if (d.serious) line += ' It stays with you.';
      out.push(line);
    }
    if (c.discovery) {
      const dead = w.citizens.get(c.discovery.deadId);
      if (dead) out.push(`- Nobody must find out what you did to ${plainRef(dead)}.`);
    }
    return out;
  }

  intentLine(c, otherId) {
    const i = this.intentToward(c, otherId);
    if (!i || i.endedAt) return null;
    const o = this.world.citizens.get(otherId);
    if (!o) return null;
    return `You came at ${ref(o)} ${MEAN[i.intent] ?? 'to hurt'} ${pronouns(o).obj}${i.intent === 'defend' ? '' : ''}.`.replace(/to defend yourself against (\w+) \w+\./, 'to defend yourself against $1.');
  }

  // ---------- every game minute ----------
  tick() {
    const w = this.world;
    for (const c of w.citizens.values()) {
      if (!c.alive) continue;
      if (c.deeds?.length) c.deeds = c.deeds.filter((d) => d.until > w.now - DAY);
      for (const [oid, i] of Object.entries(c.intents ?? {})) if (w.now - i.at > INTENT_KEEP && (!i.altId || i.endedAt)) delete c.intents[oid];
      // a killer's fear of discovery stays up while the body lies unburied or witnesses live
      if (c.discovery) {
        const corpse = w.objects.get(`body_${c.discovery.deadId}`);
        const witnessesLive = (c.discovery.witnesses ?? []).some((id) => w.citizens.get(id)?.alive);
        if (!corpse && !witnessesLive && w.now - c.discovery.since > 3 * DAY) c.discovery = null;
        else {
          const fear = w.emotions.of(c).find((e) => e.type === 'fear' && !e.target);
          if (!fear || fear.intensity < 4) w.emotions.bump(c, { type: 'fear', target: null, delta: 4 - (fear?.intensity ?? 0), cause: 'being found out', source: 'aftermath', raw: true });
        }
      }
    }
  }
}
