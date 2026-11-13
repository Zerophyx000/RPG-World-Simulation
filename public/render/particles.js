// Step 9: particles. STUB: the task "particles" implements it.
// emit(kind, wx, wy, opts) adds particles in world pixels; overEntities(F) moves and draws them. Kinds: spark, flour, z,
// dust, smoke, splash, firefly, mote, soot. Respects quality.get('particles') and quality.budget('particles').
export function createParticles(_ctx) {
  return {
    id: 'particles',
    emit(_kind, _wx, _wy, _opts = {}) {},
    overEntities(_F) {},
  };
}
