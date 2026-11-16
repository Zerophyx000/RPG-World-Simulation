// Step 11 §0 / step 11.5 (A5): the persona traits the long game reads, stored in persona — honesty (1–10: how readily
// they lie, how much it costs them), cunning (1–10: how well they plan, keep stories straight, hide tells), grudge (1–10:
// how long and how hard they hold on to a wrong), 1–2 flaws ({ flaw, serious }: a serious flaw can lead to harming
// someone) and a one-line worst self ("When he's humiliated, he doesn't rest until…").
//
// One call per citizen reads the persona text: `persona_traits` (everything) for a new citizen, `persona_flaws` (flaws,
// worst self, grudge only — honesty and cunning are kept) for one that already had traits (migration 017 sets
// data.needsFlaws). It makes explicit what the text already says; it doesn't change who they are. The cast context
// (how many already have a serious flaw) keeps the village near one in five. Without a model: a code estimate from the
// Big Five. Never shown as numbers: traitWords() and flawWords() put them in words.
import { chatForTool } from '../llm.js';
import { trait } from './common.js';

const RETRY_MINUTES = 120;
const SERIOUS_EXAMPLES = 'vindictive, greedy, envious, cruel when drunk, cowardly and treacherous, proud to the point of violence, petty, controlling';
const ORDINARY_EXAMPLES = 'impatient, vain, lazy, a sharp tongue, stubborn, nosy, quick to sulk';

export function traitWords(c) {
  const h = trait(c, 'honesty');
  const k = trait(c, 'cunning');
  const g = c.persona?.traits?.grudge;
  const out = [];
  if (h >= 8) out.push("Lying doesn't come easily to you; you've never been good at it, and it gnaws at you when you do.");
  else if (h <= 3) out.push("You've always found it easy to say what suits you, true or not.");
  if (k >= 7) out.push("You're good at telling people what they want to hear and at keeping your stories straight.");
  else if (k <= 3) out.push("You're no schemer: you say things plainly and you'd trip over a story of your own making.");
  if (g != null && g >= 8) out.push("You never forget a wrong; you carry it for years and you mean to see it paid.");
  else if (g != null && g >= 6) out.push('A wrong stays with you a long time.');
  else if (g != null && g <= 3) out.push("You don't hold grudges; a wrong fades from you quickly.");
  return out;
}

/** "Your faults: …" and "At your worst: …" (or nothing before they exist). */
export function flawWords(c) {
  const p = c.persona ?? {};
  const out = [];
  const flaws = (p.flaws ?? []).map((f) => (typeof f === 'string' ? f : f?.flaw)).filter(Boolean);
  if (flaws.length) out.push(`Your faults: ${flaws.join('; ')}.`);
  if (p.worstSelf) out.push(`At your worst: ${p.worstSelf}`);
  return out;
}

/** A code estimate when no model is up: agreeable, conscientious people are honest; open, low-agreeable ones cunning;
 *  touchy, disagreeable ones hold grudges. Flaws from the weakest side; never a serious one by guesswork. */
export function estimateTraits(c) {
  const t = c.persona?.traits ?? {};
  const a = t.agreeableness ?? 0.5; const co = t.conscientiousness ?? 0.5; const o = t.openness ?? 0.5; const n = t.neuroticism ?? 0.5; const e = t.extraversion ?? 0.5;
  const ordinary = a < 0.35 ? 'quick to take offence' : co < 0.35 ? 'lazy and careless' : n > 0.65 ? 'anxious and quick to sulk' : e > 0.7 ? 'vain and loud' : 'stubborn';
  return {
    honesty: Math.max(1, Math.min(10, Math.round(3 + 4 * a + 3 * co - 1 * o))),
    cunning: Math.max(1, Math.min(10, Math.round(2 + 4 * o + 3 * (1 - a) - 1 * n + 1.5 * co))),
    grudge: Math.max(1, Math.min(10, Math.round(2 + 5 * (1 - a) + 3 * n))),
    flaws: [{ flaw: ordinary, serious: false }],
    worst_self: `When things go wrong, ${c.persona?.sex === 'female' ? 'she' : c.persona?.sex === 'male' ? 'he' : 'they'} turns ${ordinary}.`,
    reason: 'estimated from personality (no model available)',
  };
}

export class Traits {
  constructor(world) {
    this.world = world;
    this.busy = new Set();
    this.lastTry = new Map();
  }

  needsCore(c) { const t = c.persona?.traits ?? {}; return t.honesty == null || t.cunning == null; }
  needsFlaws(c) { const p = c.persona ?? {}; return Boolean(c.needsFlaws) || !Array.isArray(p.flaws) || !p.flaws.length || !p.worstSelf || p.traits?.grudge == null; }
  needs(c) { return c.alive && c.kind === 'citizen' && (this.needsCore(c) || this.needsFlaws(c)); }

  /** How many of the others already carry a serious flaw (for the cast context). */
  castLine(c) {
    const others = [...this.world.citizens.values()].filter((o) => o.id !== c.id && o.alive && o.kind === 'citizen');
    const known = others.filter((o) => Array.isArray(o.persona?.flaws) && o.persona.flaws.length);
    const serious = known.filter((o) => o.persona.flaws.some((f) => f?.serious));
    return `Across a village, about one in five people has a serious flaw; the rest have ordinary ones. ${known.length ? `So far ${serious.length} of the ${known.length} others whose faults are known here have a serious one.` : ''}`.trim();
  }

  /** The call (also used by tests): { purpose, messages, tools, core } */
  buildCall(c) {
    const p = c.persona ?? {};
    const core = this.needsCore(c);
    const user = [
      `# THE PERSON\n${c.name}${p.age ? `, ${p.age}` : ''}${p.occupation ? `, ${p.occupation}` : ''}. ${p.personality ?? ''}\n${p.backstory ?? ''}`,
      `# WHAT NOW\nYou are reading this person the way an author knows a character, including their worst sides. Make explicit what the text already says about them; don't change who they are and don't invent a darker or kinder person.${core ? '\n- honesty 1–10 (10 = would hardly ever lie and it would eat at them; 1 = lies easily, without a second thought)\n- cunning 1–10 (10 = plans ahead, keeps stories straight, hides what they feel; 1 = says things plainly)' : ''}
- grudge 1–10: how long and how hard they hold on to a wrong (10 = never forgets and means to see it paid; 1 = it fades by the next morning)
- 1 or 2 real flaws, each marked serious or not. A serious flaw is one that can lead them to harm someone (${SERIOUS_EXAMPLES}…); ordinary ones are ${ORDINARY_EXAMPLES}… ${this.castLine(c)} A genuinely gentle person keeps ordinary flaws.
- worst self: one line, what they become at their worst ("When he's humiliated, he doesn't rest until the other man is lower than him.")
Give one short reason. Call set_traits once.`,
    ].join('\n\n');
    const props = {
      ...(core ? { honesty: { type: 'integer', minimum: 1, maximum: 10 }, cunning: { type: 'integer', minimum: 1, maximum: 10 } } : {}),
      grudge: { type: 'integer', minimum: 1, maximum: 10 },
      flaws: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'object', properties: { flaw: { type: 'string' }, serious: { type: 'boolean' } }, required: ['flaw', 'serious'] } },
      worst_self: { type: 'string' }, reason: { type: 'string' },
    };
    const tools = [{ type: 'function', function: { name: 'set_traits', description: 'Who this person is, made explicit.', parameters: { type: 'object', properties: props, required: [...(core ? ['honesty', 'cunning'] : []), 'grudge', 'flaws', 'worst_self'] } } }];
    return { purpose: core ? 'persona_traits' : 'persona_flaws', messages: [{ role: 'user', content: user }], tools, core };
  }

  /** Store (the only write path). `a`: { honesty?, cunning?, grudge?, flaws?, worst_self?, reason } */
  set(c, a, origin = 'model') {
    const clamp = (v, d) => Math.max(1, Math.min(10, Math.round(Number(v)) || d));
    const t = c.persona.traits ?? {};
    const core = a.honesty != null || a.cunning != null;
    c.persona.traits = { ...t, honesty: clamp(a.honesty ?? t.honesty, 6), cunning: clamp(a.cunning ?? t.cunning, 4), ...(a.grudge != null || t.grudge != null ? { grudge: clamp(a.grudge ?? t.grudge, 5) } : {}) };
    const flaws = (Array.isArray(a.flaws) ? a.flaws : []).map((f) => (typeof f === 'string' ? { flaw: f, serious: false } : { flaw: String(f?.flaw ?? '').trim().slice(0, 120), serious: Boolean(f?.serious) })).filter((f) => f.flaw).slice(0, 2);
    if (flaws.length) c.persona.flaws = flaws;
    if (String(a.worst_self ?? a.worstSelf ?? '').trim()) c.persona.worstSelf = String(a.worst_self ?? a.worstSelf).trim().slice(0, 240);
    c.needsTraits = false;
    if (flaws.length && c.persona.worstSelf && c.persona.traits.grudge != null) c.needsFlaws = false;
    if (core || a.reason) c.traitsReason = String(a.reason ?? '').slice(0, 200) || c.traitsReason || null;
    this.world.saveCitizen(c);
    this.world.logEvent(core ? 'persona_traits' : 'persona_flaws', { actorId: c.id, honesty: c.persona.traits.honesty, cunning: c.persona.traits.cunning, grudge: c.persona.traits.grudge ?? null, flaws: c.persona.flaws ?? [], worstSelf: c.persona.worstSelf ?? null, reason: a.reason ?? null, origin });
    this.world.bus.emit('scheming', { what: 'traits', citizenId: c.id });
  }

  async generate(c) {
    const w = this.world;
    if (this.busy.has(c.id)) return;
    this.busy.add(c.id);
    this.lastTry.set(c.id, w.now);
    try {
      const call = this.buildCall(c);
      let a = null;
      try {
        const r = await chatForTool(w.llm, { purpose: call.purpose, tier: 'light', citizenId: c.id, tools: call.tools, messages: call.messages }, 'set_traits');
        a = r.toolCalls?.find((x) => x.name === 'set_traits')?.arguments;
      } catch (err) {
        if (err.code !== 'unavailable') w.logEvent('error', { actorId: c.id, message: `${call.purpose} failed: ${String(err.message).slice(0, 160)}` });
      }
      if (!c.alive || w.citizens.get(c.id) !== c) return;
      const ok = a && (!call.core || (a.honesty != null && a.cunning != null)) && Array.isArray(a.flaws) && a.flaws.length;
      if (ok) this.set(c, call.core ? a : { ...a, honesty: undefined, cunning: undefined }, 'model');
      else { const e = estimateTraits(c); this.set(c, call.core ? e : { grudge: e.grudge, flaws: e.flaws, worst_self: e.worst_self, reason: e.reason }, 'estimate'); }
    } finally {
      this.busy.delete(c.id);
    }
  }

  /** A few at a time, while the clock runs. */
  ensure() {
    const w = this.world;
    if (!w.clock.running) return;
    for (const c of w.citizens.values()) {
      if (!this.needs(c) || this.busy.has(c.id)) continue;
      if (this.busy.size >= 2) break;
      if (w.now - (this.lastTry.get(c.id) ?? -Infinity) < RETRY_MINUTES) continue;
      this.generate(c).catch(() => {});
    }
  }
}
