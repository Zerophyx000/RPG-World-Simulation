// Step 8: what a citizen LOOKS like, for the renderer only. Read-only: it reads the body (conditions, garments, aids),
// the persona `look` and the expressed emotion and returns plain data. Nothing here feeds a prompt or changes state.
// Principle: the picture shows only what a person standing next to them could see (internal conditions never appear),
// and it shows the EXPRESSED emotion (masking and composure applied), not the hidden one.
import { deriveLook } from '../../public/art/character.js';
import { wornGarments } from '../body/garments.js';

const EXPRESSION = {
  joy: 'happy', pride: 'happy', affection: 'happy', gratitude: 'happy',
  sadness: 'sad', anger: 'angry', envy: 'angry', jealousy: 'angry',
  fear: 'afraid', disgust: 'disgusted', shame: 'ashamed', guilt: 'ashamed',
};
const COLORS = ['linen', 'red', 'blue', 'green', 'ochre', 'brown', 'purple', 'grey'];
const WOUND_KIND = { cut: 'cut', puncture: 'puncture', bruise: 'bruise', burn: 'burn', crush: 'crush', scar: 'scar', fracture: 'fracture', dislocation: 'fracture' };

const hashOf = (s) => [...String(s)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

/** The colour ramp of a garment: content `data.color` wins, otherwise a stable pick by owner and type. */
function garmentColor(g, c) {
  if (g.data?.color) return g.data.color;
  if (g.typeId === 'boots' || g.typeId === 'gloves') return 'leather';
  if (g.typeId === 'cloak' || g.typeId === 'hood') return COLORS[3 + (hashOf(`${c.id}|cloak`) % 4)];
  return COLORS[hashOf(`${c.id}|${g.typeId}`) % COLORS.length];
}

export function expressionOf(world, c) {
  if (!c.alive || !world.emotions) return 'neutral';
  let best = null;
  for (const e of world.emotions.of(c)) {
    const x = world.emotions.expressed(c, e);
    if (x >= 3 && EXPRESSION[e.type] && (!best || x > best.x)) best = { x, type: e.type };
  }
  return best ? EXPRESSION[best.type] : 'neutral';
}

export function appearance(world, c) {
  const body = world.body;
  const garments = wornGarments(world, c.id).map((g) => {
    const t = world.objects.type(g);
    return { type: g.typeId, state: g.state, bloodied: Boolean(g.data?.bloodied), color: garmentColor(g, c), pattern: g.data?.pattern ?? null, covers: t?.covers ?? [] };
  });
  const wounds = [];
  const missing = [];
  let pallor = 0; let flush = 0;
  if (body && c.body) {
    const bleeding = new Map((c.body.bleedWounds ?? []).map((w) => [w.id ?? w.conditionId, w.rate ?? w.pct ?? 0]));
    for (const cond of body.active(c.id)) {
      if (cond.type === 'severed' && cond.partId) { missing.push(cond.partId); continue; }
      if (cond.type === 'fever' && cond.severity >= 3) flush = Math.max(flush, Math.min(1, cond.severity / 8));
      const kind = WOUND_KIND[cond.type];
      if (!kind || !cond.partId || cond.visible === false || cond.geometry?.internal) continue;
      const f = cond.flags ?? {};
      wounds.push({
        part: cond.partId, kind, severity: Math.round(cond.severity * 10) / 10,
        bleed: Math.round(Math.min(100, (cond.bleeding ?? 0) > 0 ? Number(bleeding.get(cond.id) ?? cond.bleeding * 10) : 0)),
        bandaged: Boolean(f.bandaged || f.packed), wrapped: Boolean(f.wrapped), splinted: Boolean(f.splinted), stitched: Boolean(f.stitched),
      });
    }
    const blood = c.body.blood ?? 100;
    pallor = blood >= 85 ? 0 : Math.min(1, (85 - blood) / 40);
  }
  const aids = [];
  for (const o of world.objects.wornBy(c.id)) if (world.objects.type(o)?.tags?.includes('aid')) aids.push(o.typeId);
  for (const o of world.objects.carriedBy(c.id)) if (o.typeId === 'crutch') aids.push('crutch');
  const look = deriveLook(c);
  const status = c.body?.status ?? [];
  return {
    id: c.id, build: look.build, look: { skin: look.skin, hair: look.hair, facial: look.facial, eyes: look.eyes },
    garments, wounds, missing: [...new Set(missing)], aids, pallor, flush,
    expression: expressionOf(world, c), dead: !c.alive,
    asleep: c.activity?.type === 'sleeping', unconscious: status.includes('unconscious') || c.activity?.type === 'collapsed',
  };
}
