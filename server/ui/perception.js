// Step 9: GET /api/citizens/:id/perception. What this citizen's prompt is built from right now, for the subjective
// camera ("see through their eyes"), computed with the SAME functions the prompt builder uses, so the picture can't
// drift from what the LLM sees:
//   people   the people present, labelled as the prompt names them (their name if known, else how they look), with
//            the emphasis whoIsHere() gives them: 'target' (the one a strong feeling is about, written in full) or
//            'faded' (shrunk to a name or a short line by anger or fear)
//   objects  the objects the surface view lists in WHAT'S HERE (world.objects.perceiveRoom)
//   senses   blind / deaf / concussed / unconscious / asleep (body status, as in the prompt)
//   emphasis the dominant emotion and what it makes stand out (the target, the beloved and the rival, the missed
//            person's things)
// Read-only, no LLM call.
import { whoIsHere } from '../emotions/present.js';
import { senses } from '../body/perceive.js';
import { citizensIn } from '../world/rooms.js';

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function perceptionOf(world, citizenId) {
  const c = world.citizens.get(citizenId);
  if (!c) { const e = new Error(`unknown citizen "${citizenId}"`); e.status = 404; throw e; }
  const room = c.location ? world.rooms.get(c.location) : null;
  const sn = senses(c);
  const mem = world.memory;
  const asleep = c.activity?.type === 'sleeping';
  const unconscious = sn.unconscious || c.activity?.type === 'collapsed';
  const out = {
    citizenId, roomId: c.location ?? null,
    senses: { blind: sn.blind, deaf: sn.deaf, concussed: sn.concussed, unconscious, asleep },
    people: [], objects: [], emphasis: { dominant: null, highlights: [] },
  };
  if (!room) return out;

  // people: labels as the prompt writes them; emphasis from the same whoIsHere() pass
  const others = citizensIn(world.citizens, room.id, { exceptId: c.id });
  const shown = new Map(); // id -> 'full' | 'short'
  if (!sn.blind && others.length) {
    try { whoIsHere(world, c, others, (o, opts = {}) => { shown.set(o.id, opts.short ? 'short' : 'full'); return ''; }); } catch { /* fall back: everyone plain */ }
  }
  const dom = world.emotions?.dominant?.(c) ?? null;
  const angryTarget = dom?.type === 'anger' ? dom.target : null;
  for (const o of others) {
    const rel = mem.rel(c.id, o.id);
    const known = Boolean(rel?.nameKnown && rel.nameConfidence >= 0.5);
    let label;
    if (sn.blind) label = known && rel.familiarity >= 0.5 ? o.name : 'someone';
    else label = known ? o.name : cap(mem.nameFor(c, o.id));
    const how = shown.get(o.id);
    let emphasis = null;
    if (!sn.blind && shown.size) {
      if (how === undefined || how === 'short') emphasis = 'faded';
      else if (o.id === angryTarget || (dom && dom.target === o.id && dom.intensity >= 4)) emphasis = 'target';
    }
    out.people.push({ id: o.id, label, known, emphasis });
  }

  // objects: exactly what WHAT'S HERE lists
  try { out.objects = world.objects.perceiveRoom(c).listed.map((it) => it.o.id); } catch { out.objects = []; }

  // the feeling and what it makes stand out
  if (dom) out.emphasis.dominant = { type: dom.type, intensity: Math.round(dom.intensity * 10) / 10, target: dom.target ?? null };
  const hi = new Set();
  for (const e of world.emotions?.of(c) ?? []) {
    if (e.intensity < 4) continue;
    if (['anger', 'fear', 'affection', 'envy', 'disgust'].includes(e.type) && e.target) hi.add(e.target);
    if (e.type === 'jealousy') { if (e.target) hi.add(e.target); if (e.about) hi.add(e.about); }
    if ((e.type === 'sadness' || e.type === 'grief') && e.target) {
      for (const id of out.objects) if (world.objects.get(id)?.ownerId === e.target) hi.add(id);
    }
  }
  out.emphasis.highlights = [...hi];
  return out;
}
