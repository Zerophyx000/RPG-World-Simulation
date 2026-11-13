// Step 9: GET /api/replay?from=&to=. STUB: the task "server-replay" implements it.
export function replay(world, { from, to } = {}) {
  return { from: Number(from) || 0, to: Number(to) || world.now, initial: { citizens: {}, objects: {}, rooms: {} }, events: [] };
}
