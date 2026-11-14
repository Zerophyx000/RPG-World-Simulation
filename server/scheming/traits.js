// Step 11 §0: two persona traits, stored in persona.traits — honesty (1–10: how readily they lie, how much it costs them)
// and cunning (1–10: how well they plan, keep stories straight, hide tells). One `persona_traits` call per citizen reads
// the persona text and returns both with a one-line reason; without a model, a code estimate from the Big Five. Until a
// citizen has them, honesty 6 and cunning 4. Never shown as numbers: traitWords() puts them in words.
import { chatForTool } from '../llm.js';
import { trait } from './common.js';

const RETRY_MINUTES = 120;

export function traitWords(c) {
  const h = trait(c, 'honesty');
  const k = trait(c, 'cunning');
  const out = [];
  if (h >= 8) out.push("Lying doesn't come easily to you; you've never been good at it, and it gnaws at you when you do.");
  else if (h <= 3) out.push("You've always found it easy to say what suits you, true or not.");
  if (k >= 7) out.push("You're good at telling people what they want to hear and at keeping your stories straight.");
  else if (k <= 3) out.push("You're no schemer: you say things plainly and you'd trip over a story of your own making.");
  return out;
}

/** A code estimate when no model is up: agreeable, conscientious people are honest; open, low-agreeable ones cunning. */
export function estimateTraits(c) {
  const t = c.persona?.traits ?? {};
  const a = t.agreeableness ?? 0.5; const co = t.conscientiousness ?? 0.5; const o = t.openness ?? 0.5; const n = t.neuroticism ?? 0.5;
  return {
    honesty: Math.max(1, Math.min(10, Math.round(3 + 4 * a + 3 * co - 1 * o))),
    cunning: Math.max(1, Math.min(10, Math.round(2 + 4 * o + 3 * (1 - a) - 1 * n + 1.5 * co))),
    reason: 'estimated from personality (no model available)',
  };
}

export class Traits {
  constructor(world) {
    this.world = world;
    this.busy = new Set();
    this.lastTry = new Map();
  }

  needs(c) {
    const t = c.persona?.traits ?? {};
    return c.alive && c.kind === 'citizen' && (t.honesty == null || t.cunning == null);
  }

  set(c, { honesty, cunning, reason }, origin = 'model') {
    const clamp = (v, d) => Math.max(1, Math.min(10, Math.round(Number(v)) || d));
    c.persona.traits = { ...(c.persona.traits ?? {}), honesty: clamp(honesty, 6), cunning: clamp(cunning, 4) };
    c.needsTraits = false;
    c.traitsReason = String(reason ?? '').slice(0, 200) || null;
    this.world.saveCitizen(c);
    this.world.logEvent('persona_traits', { actorId: c.id, honesty: c.persona.traits.honesty, cunning: c.persona.traits.cunning, reason: c.traitsReason, origin });
  }

  async generate(c) {
    const w = this.world;
    if (this.busy.has(c.id)) return;
    this.busy.add(c.id);
    this.lastTry.set(c.id, w.now);
    try {
      const p = c.persona ?? {};
      const user = [
        `# THE PERSON\n${c.name}${p.occupation ? `, ${p.occupation}` : ''}. ${p.personality ?? ''}\n${p.backstory ?? ''}`,
        '# WHAT NOW\nJudge two traits of this person from the text, each 1–10: honesty (10 = would hardly ever lie and it would eat at them; 1 = lies easily, without a second thought) and cunning (10 = plans ahead, keeps stories straight, hides what they feel; 1 = says things plainly, no talent for schemes). Give one short reason. Call set_traits once.',
      ].join('\n\n');
      const tools = [{ type: 'function', function: { name: 'set_traits', description: 'The two traits.', parameters: { type: 'object', properties: {
        honesty: { type: 'integer', minimum: 1, maximum: 10 }, cunning: { type: 'integer', minimum: 1, maximum: 10 }, reason: { type: 'string' },
      }, required: ['honesty', 'cunning'] } } }];
      let a = null;
      try {
        const r = await chatForTool(w.llm, { purpose: 'persona_traits', tier: 'light', citizenId: c.id, tools, messages: [{ role: 'user', content: user }] }, 'set_traits');
        a = r.toolCalls?.find((x) => x.name === 'set_traits')?.arguments;
      } catch (err) {
        if (err.code !== 'unavailable') w.logEvent('error', { actorId: c.id, message: `persona traits failed: ${String(err.message).slice(0, 160)}` });
      }
      if (!c.alive || w.citizens.get(c.id) !== c) return;
      if (a && a.honesty != null && a.cunning != null) this.set(c, a, 'model');
      else this.set(c, estimateTraits(c), 'estimate');
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
