// Step 10: what kind of motion an item makes (content/art/item-motions.json). DOM-free, shared by the animator and the
// items layer. motionOf(table, o) -> { class, material, held, cls: the class entry, mat: the material entry }.
const TAG_CLASS = [['blade', 'blade'], ['weapon', 'blade'], ['heavy', 'heavy'], ['blunt', 'light'], ['light', 'light_source'], ['water', 'vessel'], ['cloth', 'soft'], ['garment', 'soft']];
const FALLBACK = { classes: { none: { strike: 'swing', pose: 'push', speed: 1 } }, materials: { wood: { break: 'splinter', land: 'dust', hit: 'dust', burn: 'steady' } }, types: {} };

export function motionOf(table, o) {
  const T = table ?? FALLBACK;
  const typeId = o?.typeId ?? o?.type ?? String(o ?? '');
  const def = T.types?.[typeId] ?? {};
  const tags = o?.tags ?? [];
  const cls = def.class ?? TAG_CLASS.find(([t]) => tags.includes(t))?.[1] ?? 'none';
  const material = def.material ?? (tags.includes('cloth') || tags.includes('garment') ? 'cloth' : 'wood');
  return {
    typeId, class: cls, material, held: def.held ?? null,
    cls: T.classes?.[cls] ?? T.classes?.none ?? FALLBACK.classes.none,
    mat: T.materials?.[material] ?? T.materials?.wood ?? FALLBACK.materials.wood,
  };
}

/** The type id from an alias handle ("hammer#65su" -> "hammer"). */
export const typeOfAlias = (alias) => String(alias ?? '').split('#')[0];
