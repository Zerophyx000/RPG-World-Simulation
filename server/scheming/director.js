// Step 11: the director's levers for the long game — give someone an ambition (and, if asked, a quiet moment to plan
// toward it, which the model is free to answer with no_plan) and set someone's honesty / cunning. Both go through the
// scheming write paths (ambitions.add / change, traits.set, schemes.maybePlan); nothing here makes anyone lie or plot.
// Used by POST /api/director/ambition, /api/director/traits and the test-day actions of the same names.
import { KINDS, SECRECY } from './ambitions.js';

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const need = (world, id) => {
  const c = world.citizens.get(id);
  if (!c) throw bad(`unknown citizen "${id}"`);
  return c;
};

/** { citizenId, text, kind, intensity, secrecy, targets: [ids], why, plan } */
export function directorAmbition(world, { citizenId, text, kind = 'other', intensity = 7, secrecy = 'private', targets = [], why = null, plan = false } = {}) {
  const c = need(world, citizenId);
  const A = world.scheming.ambitions;
  if (!String(text ?? '').trim()) throw bad('needs "text" (first person, one sentence)');
  if (!KINDS.includes(kind)) throw bad(`kind must be one of ${KINDS.join(', ')}`);
  if (!SECRECY.includes(secrecy)) throw bad(`secrecy must be one of ${SECRECY.join(', ')}`);
  const targetIds = (Array.isArray(targets) ? targets : [targets]).filter(Boolean).map((id) => need(world, id).id);
  // make room: the weakest active ambition is set aside (with a reason, like any change)
  const have = A.of(c.id);
  const max = Number(process.env.AMBITIONS_MAX ?? 3) || 3;
  if (have.length >= max) {
    const weakest = [...have].sort((x, y) => x.intensity - y.intensity)[0];
    A.change(weakest.id, { status: 'abandoned' }, { op: 'abandon', why: 'director: making room for a new ambition' });
  }
  c.needsAmbitions = false; // the director's ambition stands in for the generated ones still missing
  const a = A.add(c, { kind, text, targetIds, intensity, secrecy }, { origin: 'director', why: why ?? 'director' });
  if (!a) throw bad('could not add the ambition');
  if (plan) world.scheming.schemes.maybePlan(c, { trigger: 'director', ambition: a });
  return { ok: true, ambition: a };
}

/** { citizenId, honesty, cunning, reason } */
export function directorTraits(world, { citizenId, honesty, cunning, reason = null } = {}) {
  const c = need(world, citizenId);
  const t = c.persona?.traits ?? {};
  world.scheming.traits.set(c, { honesty: honesty ?? t.honesty, cunning: cunning ?? t.cunning, reason: reason ?? 'set by the director' }, 'director');
  return { ok: true, traits: { honesty: c.persona.traits.honesty, cunning: c.persona.traits.cunning } };
}
