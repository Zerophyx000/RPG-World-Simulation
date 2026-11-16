// Step 9: map replay. load(from, to) fetches GET /api/replay (the state at `from` plus time-ordered position, line,
// object, effect and activity events) and plays it: the map draws stateAt(liveS) instead of the live state, while
// the live world runs on. Trips in progress become moving activities (so the movers walk them), spoken lines become
// speech bubbles of the right age. Speed is game minutes per real second (1 = one game minute a second, up to 60).
// Live data is never modified; seeking backwards rebuilds from the initial snapshot.
export function createReplay({ fetchJson, clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) } = {}) {
  let data = null;
  let cursor = 0;
  let state = null;     // { citizens: Map id -> { location, spot, activity }, objects: Map id -> {...}, rooms: Map id -> effects }
  let lines = [];       // recent lines (for bubbles)
  let lastReal = null;
  let objectsRev = 1;

  function reset() {
    cursor = 0; lines = []; objectsRev++;
    state = {
      citizens: new Map(Object.entries(data.initial?.citizens ?? {}).map(([id, v]) => [id, { ...v }])),
      objects: new Map(Object.entries(data.initial?.objects ?? {}).map(([id, v]) => [id, { ...v }])),
      rooms: new Map(Object.entries(data.initial?.rooms ?? {}).map(([id, v]) => [id, [...(v.effects ?? [])]])),
    };
  }

  function apply(e) {
    if (e.type === 'position') {
      const c = state.citizens.get(e.citizenId) ?? {};
      if (e.kind === 'trip-start') Object.assign(c, { location: e.fromRoom, spot: null, activity: { type: 'moving', since: e.t, until: e.t + (e.minutes ?? 1), detail: { from: e.fromRoom, to: e.toRoom, legStart: e.t, travelMinutes: e.minutes ?? 1, fromSpot: e.fromSpot } } });
      else if (e.kind === 'walk-start') Object.assign(c, { location: e.fromRoom, spot: e.fromSpot, activity: { type: 'doing', since: e.t, until: e.t + (e.minutes ?? 0.5), detail: { kind: 'walk', fromSpot: e.fromSpot, toSpot: e.toSpot, minutes: e.minutes ?? 0.5 } } });
      else Object.assign(c, { location: e.toRoom, spot: e.toSpot, activity: { type: 'idle', since: e.t, until: null, detail: null } });
      state.citizens.set(e.citizenId, c);
    } else if (e.type === 'activity') {
      const c = state.citizens.get(e.citizenId) ?? {};
      // a trip's own moving/doing state comes from the position events; other activities take over
      if (!(c.activity?.type === 'moving' && e.activity?.type === 'moving')) c.activity = e.activity;
      state.citizens.set(e.citizenId, c);
    } else if (e.type === 'object') { state.objects.set(e.objectId, { ...(state.objects.get(e.objectId) ?? {}), ...e.after }); objectsRev++; }
    else if (e.type === 'effect') {
      const list = state.rooms.get(e.roomId) ?? [];
      if (e.removed) state.rooms.set(e.roomId, list.filter((x) => x.id !== e.effect?.id));
      else state.rooms.set(e.roomId, [...list.filter((x) => x.id !== e.effect.id), e.effect]);
    } else if (e.type === 'line') lines.push(e);
  }

  function advanceTo(t) {
    if (!data) return;
    if (t < api.t) reset();
    const evs = data.events ?? [];
    if (t < api.t || cursor === 0) { cursor = 0; }
    while (cursor < evs.length && evs[cursor].t <= t) apply(evs[cursor++]);
    lines = lines.filter((l) => l.t > t - 10);
    api.t = t;
  }

  const api = {
    active: false, playing: false, speed: 5, from: 0, to: 0, t: 0, loading: false, error: null,
    async load(from, to) {
      api.loading = true; api.error = null;
      try {
        data = await fetchJson(`/api/replay?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      } catch (err) { api.loading = false; api.error = String(err?.message ?? err); return false; }
      api.loading = false;
      api.from = data.from; api.to = data.to; api.t = data.from;
      reset();
      advanceTo(data.from);
      api.active = true; api.playing = true; lastReal = null;
      return true;
    },
    play() { if (data) { if (api.t >= api.to) api.seek(api.from); api.playing = true; lastReal = null; } },
    pause() { api.playing = false; },
    setSpeed(x) { api.speed = Math.max(1, Math.min(60, Number(x) || 1)); },
    seek(t) { if (!data) return; const target = Math.max(api.from, Math.min(api.to, Number(t))); if (target < api.t) { reset(); api.t = api.from; advanceTo(api.from); } advanceTo(target); lastReal = null; },
    stop() { api.active = false; api.playing = false; data = null; state = null; },
    events: () => data?.events ?? [],
    /** The replayed state for the scene, built from the live one (never modifying it). */
    stateAt(liveS, ms) {
      if (!api.active || !state) return liveS;
      const now = clock();
      if (api.playing) {
        if (lastReal != null) advanceTo(Math.min(api.to, api.t + ((now - lastReal) / 1000) * api.speed));
        if (api.t >= api.to) api.playing = false;
      }
      lastReal = now;
      const citizens = new Map();
      for (const [id, live] of liveS.citizens) {
        const r = state.citizens.get(id);
        citizens.set(id, r ? { ...live, location: r.location, spot: r.spot, activity: r.activity ?? { type: 'idle' }, conversationId: null, __place: live.__place } : { ...live });
      }
      const objects = new Map();
      for (const [id, live] of liveS.objects) { const r = state.objects.get(id); objects.set(id, r ? { ...live, ...r } : live); }
      const rooms = new Map();
      for (const [id, live] of liveS.rooms) rooms.set(id, { ...live, effects: state.rooms.get(id) ?? [] });
      const bubbles = new Map();
      const msPerGameMin = 60000 / Math.max(1, api.speed) / 60; // real ms per game minute at this speed
      for (const l of lines) {
        const age = (api.t - l.t) * msPerGameMin;
        if (age >= 0 && age < 9000) bubbles.set(l.speakerId, { text: l.text, born: ms - age, volume: l.volume, toId: l.toId, conversationId: null });
      }
      return { ...liveS, now: api.t, citizens, objects, objectsRev: `r${objectsRev}`, rooms, bubbles, social: null, faceOf: new Map(), events: [], replaying: true };
    },
  };
  return api;
}
