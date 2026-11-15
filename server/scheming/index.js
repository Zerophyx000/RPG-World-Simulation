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
import { Schemes, STEP_KINDS } from './schemes.js';
import { Lies, LIE_KINDS } from './lies.js';
import { LeakCheck } from './leakcheck.js';
import { trait } from './common.js';

export { traitWords };

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
    if (a.scheme) this.schemes.applyDecision(c, a.scheme);
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
      all.scheme = { type: 'object', description: 'Optional, only about your own secret plan: a step you just did or that failed, one step to change, or pausing / giving it up (with a reason).', properties: {
        id: { type: 'integer', enum: owned.map((s) => s.id) },
        ...(stepIds.length ? { step_done: { type: 'string', enum: stepIds }, step_failed: { type: 'string', enum: stepIds } } : {}),
        revise: { type: 'object', properties: { replace_step: { type: 'string', enum: stepIds.length ? stepIds : ['none'] }, with: { type: 'object', properties: { text: { type: 'string' }, kind: { type: 'string', enum: STEP_KINDS } }, required: ['text'] } } },
        pause: { type: 'boolean' }, resume: { type: 'boolean' }, abandon: { type: 'boolean' }, reason: { type: 'string' },
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
      const byId = new Map([...labels].map(([l, o]) => [o.id, l]));
      const heard = claims.slice(-3).map((x) => `${byId.get(x.from) ?? 'someone'}: "${x.text.slice(0, 70)}"`).join('; ');
      all.trust_claim = { type: 'object', description: `Optional: what you make of something you were told in the last hour (${heard}). Fill it once you believe it, doubt it or don't believe it — your words alone don't settle it for you.`, properties: {
        from: { type: 'string', enum: [...labels.keys()] }, verdict: { type: 'string', enum: ['believe', 'doubt', 'disbelieve'] }, why: { type: 'string' },
      }, required: ['from', 'verdict'] };
    }
    const deceive = { type: 'object', description: "Optional and private: you can lie, mislead or keep things to yourself, as your character would. If what you say (or do) here is something you know isn't true, or meant to make people believe something false, fill this so you remember the truth. Nobody else sees it. Keeping quiet or being vague needs nothing here.", properties: {
      truth: { type: 'string', description: 'What is really true.' }, kind: { type: 'string', enum: LIE_KINDS, description: 'fact (about the world), self (about yourself), cover (for someone), accuse (falsely blaming someone), frame (making someone look guilty), other.' },
      why: { type: 'string' }, check: { type: 'object', description: 'Optional: who the false claim is about, where and when you claim they (or you) were, in your own words ("Jonas", "at home", "last night").', properties: { who: { type: 'string' }, where: { type: 'string' }, when: { type: 'string' } } },
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
