// Step 9: the subjective camera ("see through their eyes"). STUB: the task "subjective" implements it.
// Active when F.S.subjective = { id, perception } (perception from GET /api/citizens/:id/perception). In update(F) it fills
// F.fade / F.hide / F.nameOf / F.muted; in screen(F) it draws vignettes, darkness, voice markers, jitter.
export function createSubjective(_ctx) {
  return { id: 'subjective' };
}
