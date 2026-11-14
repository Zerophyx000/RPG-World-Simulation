// Step 10: fire on the map, visual only. Burning objects (o.data.burning) throw flames, embers and smoke; burnt ones a
// thin trail of smoke for a while; a room on fire (its 'fire' room effect) adds embers across the room. Rates follow
// the graphics quality (particles off: nothing).
export function createFire(ctx) {
  const last = new Map(); // object id -> ms of the last emit
  return {
    id: 'fire',
    // after the objects are placed (F.objectPos), before people are drawn
    entities(F) {
      if (ctx.quality?.get?.('particles') === false) return;
      const S = F.S;
      const ms = F.ms;
      for (const [id, e] of F.objectPos ?? []) {
        const o = e.o;
        const burning = o.data?.burning;
        const smoking = !burning && o.data?.burnt && (S.now - (o.updatedAt ?? 0)) < 120;
        if (!burning && !smoking) continue;
        if (!F.inView(e.x, e.y)) continue;
        const every = burning ? 90 : 500;
        if (ms - (last.get(id) ?? 0) < every) continue;
        last.set(id, ms);
        const h = e.sprite?.h ?? 12;
        if (burning) {
          F.emit('flame', e.x + (Math.random() * 10 - 5), e.y - h * 0.5);
          if (Math.random() < 0.4) F.emit('ember', e.x, e.y - h * 0.7);
          if (Math.random() < 0.5) F.emit('smoke', e.x, e.y - h);
        } else F.emit('smoke', e.x, e.y - h * 0.5);
      }
    },
  };
}
