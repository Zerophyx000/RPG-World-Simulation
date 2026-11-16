// Step 9: graphics quality. Everything step 9 adds is visual only, so it is switchable: a level (low / medium / high)
// sets defaults for each feature, and each feature can be toggled on its own in the settings panel. Stored per viewer
// (localStorage, wrapped: Node and private windows fall back to the defaults). Layers ask quality.get(feature).
export const FEATURES = {
  particles: 'sparks, flour, z, dust, fireflies',
  castShadows: 'shadows that follow the sun (otherwise only drop shadows)',
  ao: 'ambient occlusion along walls and under furniture',
  wear: 'worn paths',
  clutter: 'room clutter',
  ambient: 'birds, cats, chickens, fireflies, dust motes',
  idle: 'idle life: blinking, breathing, glancing',
  secondary: 'cloak and hair sway, wind in trees',
  flicker: 'flickering firelight, banded light falloff, lit windows',
  decals: 'soot, puddles, bloodstains',
  overlays: 'story lines and event pins (god view)',
};
const LEVELS = {
  low: { particles: false, castShadows: false, ao: false, wear: false, clutter: true, ambient: false, idle: true, secondary: false, flicker: false, decals: true, overlays: true },
  medium: { particles: true, castShadows: true, ao: true, wear: true, clutter: true, ambient: true, idle: true, secondary: true, flicker: true, decals: true, overlays: true },
  high: { particles: true, castShadows: true, ao: true, wear: true, clutter: true, ambient: true, idle: true, secondary: true, flicker: true, decals: true, overlays: true },
};
// how much of each the levels allow (layers scale counts with these)
const BUDGET = { low: { particles: 0, ambient: 0 }, medium: { particles: 250, ambient: 12 }, high: { particles: 600, ambient: 30 } };

const store = (() => {
  try { return globalThis.localStorage ?? null; } catch { return null; }
})();
const read = (k, d) => { try { const v = store?.getItem(`aw.gfx.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } };
const save = (k, v) => { try { store?.setItem(`aw.gfx.${k}`, JSON.stringify(v)); } catch { /* ignore */ } };

export function createQuality(initial = null) {
  let level = initial ?? read('level', 'medium');
  if (!LEVELS[level]) level = 'medium';
  let overrides = initial ? {} : read('overrides', {});
  const subs = new Set();
  const changed = () => { for (const fn of subs) { try { fn(); } catch { /* ignore */ } } };
  return {
    LEVELS: Object.keys(LEVELS),
    get level() { return level; },
    /** Is a feature on? (the level's default unless toggled) */
    get(feature) { return feature in overrides ? Boolean(overrides[feature]) : Boolean(LEVELS[level][feature]); },
    /** A number budget for the level ('particles', 'ambient'). */
    budget(name) { return BUDGET[level]?.[name] ?? 0; },
    setLevel(l) { if (!LEVELS[l]) return; level = l; overrides = {}; if (!initial) { save('level', l); save('overrides', overrides); } changed(); },
    toggle(feature, on) { overrides = { ...overrides, [feature]: Boolean(on) }; if (!initial) save('overrides', overrides); changed(); },
    all() { return Object.fromEntries(Object.keys(FEATURES).map((f) => [f, this.get(f)])); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

/** The viewer's quality (browser: remembered; Node: medium). */
export const quality = createQuality();
