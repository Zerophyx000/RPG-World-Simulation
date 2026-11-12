// Perception: stimuli and the per-citizen inbox.
//
// A stimulus is something a citizen perceives:
//   { id, gameTime, kind, text, importance, sourceId, roomId, data }
//   kind: 'arrive' | 'depart' | 'speech' | 'action' | 'director' | 'timer' | 'system'
//   text: second person, from the viewer's point of view ("Tomas walks in from the square.")
//   data.wake: true wakes a citizen who is `talking` (they were spoken to / it's their turn)

export const INBOX_CAP = 20;

export const IMPORTANCE = {
  spokenTo: 9,
  director: 7,
  speechInRoom: 5,
  arriveDepart: 4,
  timer: 6,
  visibleAction: 3,
  staleAction: 6,
  system: 6,
};

let counter = 0;

export function makeStimulus(partial, now) {
  return {
    id: `s${Date.now().toString(36)}${(counter++).toString(36)}`,
    gameTime: now,
    kind: partial.kind ?? 'system',
    text: String(partial.text ?? ''),
    importance: clampImportance(partial.importance ?? 5),
    sourceId: partial.sourceId ?? null,
    roomId: partial.roomId ?? null,
    data: partial.data ?? {},
  };
}

// Push into the inbox; when over the cap, drop the oldest entry of the lowest importance.
export function pushToInbox(c, stimulus) {
  c.inbox.push(stimulus);
  while (c.inbox.length > INBOX_CAP) {
    let drop = 0;
    for (let i = 1; i < c.inbox.length; i++) {
      if (c.inbox[i].importance < c.inbox[drop].importance) drop = i; // strict <: keeps the oldest of the lowest
    }
    c.inbox.splice(drop, 1);
  }
}

// Merge stimuli lists (e.g. restoring an aborted think's snapshot), oldest first, capped.
export function mergeInboxes(...lists) {
  const seen = new Set();
  const merged = [];
  for (const s of lists.flat()) {
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    merged.push(s);
  }
  merged.sort((a, b) => a.gameTime - b.gameTime);
  const holder = { inbox: [] };
  for (const s of merged) pushToInbox(holder, s);
  return holder.inbox;
}

export function maxImportance(stimuli) {
  let m = 0;
  for (const s of stimuli) if (s.importance > m) m = s.importance;
  return m;
}

export function clampImportance(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 5;
}
