// Step 11: ambitions, schemes and deception — world.scheming, the facade World, the action layer, prompts and tools call.
//
//   traits / ambitions / schemes / lies / leak   the parts (see each file's header)
//   tick()                 one-time jobs (traits, ambitions), due scheme steps, late contradictions
//   onSpeech(c, …)         a line was spoken: a lie (deceive), claims to judge, tells, retellings, confiding,
//                          confessing, and the leak check
//   onObjectAct(c, …)      put / give / handle with `deceive` (planting, framing): a lie row; object_history keeps the
//                          true actor; the surface view shows only where the thing is
//   afterDecision(c, call) the decision-level fields: scheme, proposal, trust_claim
//   promptBlocks(c, tier)  YOUR AMBITIONS, YOUR PLAN, YOUR STORIES
//   toolFields(c)          the optional fields offered right now (never shown as rules, always optional)
// Cost rule: planning only at reflection and sleep consolidation; ordinary decisions see short blocks only.
import { Traits, traitWords } from './traits.js';
import { Ambitions } from './ambitions.js';
import { Schemes } from './schemes.js';
import { Lies, LIE_KINDS } from './lies.js';
import { LeakCheck } from './leakcheck.js';
import { trait } from './common.js';

export { traitWords };

/** The compact decision field ({ id, step, outcome, text, status, reason }) → applyDecision's shape (the old one passes). */
export function schemeField(f) {
  if (!f || typeof f !== 'object') return f;
  const out = { ...f };
  if (f.step && f.outcome === 'done') out.step_done = f.step;
  if (f.step && f.outcome === 'failed') out.step_failed = f.step;
  if (f.step && f.outcome === 'rewrite' && f.text) out.revise = { replace_step: f.step, with: { text: f.text } };
  if (['pause', 'resume', 'abandon'].includes(f.status)) out[f.status] = true;
  return out;
}

export class Scheming {
  constructor(world) {
    this.world = world;
    this.traits = new Traits(world);
    this.ambitions = new Ambitions(world);
    this.schemes = new Schemes(world);
    this.lies = new Lies(world);
    this.leak = new LeakCheck(world);
  }

  tick() {
    this.traits.ensure();
    this.ambitions.ensure();
    this.schemes.tick();
    this.lies.tick();
  }

  // ---------- speech ----------
  onSpeech(c, { text, args = {}, addressee = null, hearers = [], eventId = null }) {
    const w = this.world;
    let lie = null;
    if (args.deceive && typeof args.deceive === 'object') lie = this.lies.record(c, { said: text, deceive: args.deceive, hearers, addressee, eventId });
    this.lies.noteClaims(c, text, hearers, addressee, lie);
    const fear = Math.max(0, ...w.emotions.of(c).filter((e) => e.type === 'fear').map((e) => e.intensity));
    this.lies.tells(c, hearers, { lie, nervous: !lie && fear >= 6 });
    if (!lie) this.lies.onSpeech(c, text, hearers);
    if (args.confide) this.schemes.confide(c, args.confide, { addressee, hearers });
    if (args.confess != null) this.lies.confess(c, args.confess, hearers);
    this.leak.check(c, text, hearers, { skip: Boolean(args.confide || args.confess != null || lie) }).catch(() => {});
  }

  onObjectAct(c, { call, objectId, description, witnesses = [] }) {
    const d = call.arguments?.deceive;
    if (!d || typeof d !== 'object') return null;
    return this.lies.record(c, { said: description, deceive: d, hearers: [], act: { tool: call.name, objectId, witnessedBy: witnesses.map((o) => o.id) } });
  }

  afterDecision(c, call) {
    const a = call?.arguments ?? {};
    if (a.scheme) this.schemes.applyDecision(c, schemeField(a.scheme));
    if (a.proposal) this.schemes.answer(c, a.proposal);
    if (a.trust_claim) this.lies.verdict(c, a.trust_claim);
  }

  onReflection(c) {
    this.schemes.onReflection(c);
  }

  // ---------- consolidation (rides on the existing call) ----------
  consolidationBlock(c) { return this.ambitions.consolidationBlock(c); }
  consolidationSchema(c) { return this.ambitions.changesSchema(c); }
  applyConsolidation(c, ch) {
    const out = this.ambitions.applyChanges(c, ch);
    const added = out.find((x) => x.op === 'add' && x.intensity >= Number(process.env.SCHEME_MIN_INTENSITY ?? 6));
    if (added) this.schemes.maybePlan(c, { trigger: 'consolidation', ambition: this.ambitions.get(added.id) });
    return out;
  }

  // ---------- prompts ----------
  promptBlocks(c, tier) {
    const w = this.world;
    const stories = this.lies.storyLines(c, tier);
    return {
      ambitions: this.ambitions.promptBlock(c, tier),
      plan: this.schemes.promptBlock(c, tier),
      stories: stories.length ? w.memory.resolveNames(c, tier === 'full' ? stories.join('\n') : stories[0]) : null,
      claims: this.lies.claimsFor(c).length ? 'Anything you were told in the last hour you may believe, doubt or disbelieve (trust_claim) — whether it was true or not, you cannot know for certain.' : null,
    };
  }

  // ---------- tools ----------
  /** Optional fields: { all: {...}, say: {...}, object: {...} } (object = put / give / handle) */
  toolFields(c) {
    const w = this.world;
    const all = {};
    const owned = this.schemes.ownedBy(c).filter((s) => s.status === 'active' || s.status === 'paused');
    if (owned.length) {
      const stepIds = [...new Set(owned.flatMap((s) => s.steps.filter((st) => st.status === 'pending').map((st) => st.id)))];
      // compact on purpose: it rides on every tool (step 11 cost rule)
      all.scheme = { type: 'object', description: 'Optional, your own plan: a step done, failed or rewritten (text), or pause / resume / abandon it (reason).', properties: {
        id: { type: 'integer', enum: owned.map((s) => s.id) },
        ...(stepIds.length ? { step: { type: 'string', enum: stepIds }, outcome: { type: 'string', enum: ['done', 'failed', 'rewrite'] }, text: { type: 'string' } } : {}),
        status: { type: 'string', enum: ['pause', 'resume', 'abandon'] }, reason: { type: 'string' },
      }, required: ['id'] };
    }
    const proposals = (c.proposals ?? []).filter((p) => w.now - p.at < 1440);
    if (proposals.length) {
      all.proposal = { type: 'object', description: 'Optional: your answer to being asked to join (or keep quiet about) someone\'s plan.', properties: {
        scheme: { type: 'integer', enum: proposals.map((p) => p.scheme) }, answer: { type: 'string', enum: ['join', 'refuse', 'think_about_it'] }, reason: { type: 'string' },
      }, required: ['scheme', 'answer'] };
    }
    const claims = this.lies.claimsFor(c);
    if (claims.length) {
      const labels = w.memory.labelsFor(c, [...new Set(claims.map((x) => x.from))].map((id) => w.citizens.get(id)).filter(Boolean));
      // static text on purpose: tools sit at the front of the prompt, and words that change with every line heard
      // would cost the server its prefix cache on every conversation turn
      all.trust_claim = { type: 'object', description: "Optional: once you believe, doubt or don't believe what someone told you in the last hour, say so here — your words alone don't settle it for you.", properties: {
        from: { type: 'string', enum: [...labels.keys()] }, verdict: { type: 'string', enum: ['believe', 'doubt', 'disbelieve'] }, why: { type: 'string' },
      }, required: ['from', 'verdict'] };
    }
    const deceive = { type: 'object', description: "Optional, private (nobody sees it): if what you say or do here isn't true, or is meant to mislead, note the truth. Being vague or keeping quiet needs nothing.", properties: {
      truth: { type: 'string' }, kind: { type: 'string', enum: LIE_KINDS, description: 'fact, self (about you), cover (for someone), accuse (blaming someone falsely), frame (making someone look guilty), other' },
      why: { type: 'string' }, check: { type: 'object', description: 'Optional, when your words say where someone was: in your own words, whom they are about, the place your words claim, and the time ("me", "at home", "last night").', properties: { who: { type: 'string', description: 'Whom your words are about ("me" for yourself).' }, where: { type: 'string', description: 'The place your words CLAIM they were, the false one — not where they really were.' }, when: { type: 'string', description: 'The time your words are about.' } } },
    }, required: ['truth', 'why'] };
    const say = { deceive };
    if (owned.length) say.confide = { type: 'object', description: 'Optional: you are letting the one you speak to in on your secret plan (your words say what you share).', properties: { scheme: { type: 'integer', enum: owned.map((s) => s.id) }, reveal: { type: 'string', enum: ['partial', 'full'] }, ask: { type: 'string', enum: ['join', 'keep_quiet', 'none'] } }, required: ['scheme', 'reveal', 'ask'] };
    const standing = this.lies.standingOf(c, 10);
    if (standing.length) say.confess = { type: 'integer', enum: standing.map((l) => l.id), description: `Optional: you are owning up to a lie you told (${standing.slice(0, 4).map((l) => `${l.id}: "${l.said.slice(0, 40)}"`).join('; ')}).` };
    return { all, say, object: { deceive } };
  }

  /** The persona's honesty and cunning in words (system prompt). */
  traitWords(c) { return traitWords(c); }
  trait(c, k) { return trait(c, k); }
}
