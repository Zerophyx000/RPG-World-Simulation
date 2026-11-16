// Step 9: the scene's layers, in drawing order within each phase (see public/art/scene.js for the phases and F).
// Each module exports create<Name>(ctx) -> layer { id, update?, ground?, entities?, overEntities?, light?, screen?, ... }
// ctx = { pal, objs, tiles, layout, maps, quality, art }. A layer that throws is reported once and skipped.
import { createTraces } from './traces.js';
import { createLighting } from './lighting.js';
import { createDepth } from './depth.js';
import { createAmbient } from './ambient.js';
import { createParticles } from './particles.js';
import { createEffects } from './effects.js';
import { createStory } from './story.js';
import { createFire } from './fire.js'; // step 10
import { createItems } from './items.js'; // step 10: items in motion
import { createSubjective } from './subjective.js';

export function createLayers(ctx) {
  return [createSubjective(ctx), createTraces(ctx), createLighting(ctx), createDepth(ctx), createAmbient(ctx), createParticles(ctx), createItems(ctx), createFire(ctx), createEffects(ctx), createStory(ctx)];
}
