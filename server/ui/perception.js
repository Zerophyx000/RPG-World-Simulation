// Step 9: GET /api/citizens/:id/perception. STUB: the task "server-perception" implements it.
// What the prompt builder selected for this citizen right now (people, objects, emphasis), so the subjective camera shows
// exactly what the LLM sees. Read-only, no LLM call.
export function perceptionOf(world, citizenId) {
  const c = world.citizens.get(citizenId);
  if (!c) { const e = new Error(`unknown citizen "${citizenId}"`); e.status = 404; throw e; }
  return { citizenId, roomId: c.location, senses: { blind: false, deaf: false, concussed: false, unconscious: false, asleep: false }, people: [], objects: [], emphasis: { dominant: null, highlights: [] } };
}
