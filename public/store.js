// Single client-side state, updated from the API and SSE. Views subscribe to topics
// and re-render only their own part.
//
// Topics: clock, citizens, citizen (id), rooms, conversations, conversation (id), conversationEnded (id),
//         events, event (event), observer, llm (call), selection, filter, view
export const store = {
  clock: null,
  llm: null,               // { active, waiting, maxConcurrent }
  rooms: new Map(),        // id -> { id, name, description, exits, tags, x, y, effects }
  citizens: new Map(),     // id -> summary (incl. activity, lastInnerThought)
  conversations: new Map(),// active only: id -> { id, roomId, participants, everParticipants, lines, held }
  endedConversations: new Map(), // step 9: id -> { reason, at (real ms) } for conversations that just ended
  storylineFocus: null,    // step 9: a storyline id chosen in the Story view, highlighted on the map
  objects: new Map(),      // step 5: id -> object view (true view; the director's camera)
  events: [],              // recent events, newest first
  observer: null,          // latest observer report
  observerStatus: null,
  selectedId: null,        // citizen in the inspector
  filterCitizen: null,     // shift-click filter for the main views
  view: 'world',
  connected: false,
};

const subs = new Map();

export function subscribe(topic, fn) {
  if (!subs.has(topic)) subs.set(topic, new Set());
  subs.get(topic).add(fn);
  return () => subs.get(topic)?.delete(fn);
}

export function emit(topic, payload) {
  for (const fn of subs.get(topic) ?? []) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`[store] subscriber for "${topic}" failed`, err);
    }
  }
}

/** Subscribe to several topics with one handler; returns a single unsubscribe function. */
export function subscribeMany(topics, fn) {
  const offs = topics.map((t) => subscribe(t, fn));
  return () => offs.forEach((off) => off());
}

export const MAX_EVENTS = 1500;

export function addEvent(e) {
  store.events.unshift(e);
  if (store.events.length > MAX_EVENTS) store.events.length = MAX_EVENTS;
  emit('event', e);
}

export function select(id) {
  store.selectedId = id;
  emit('selection', id);
}

export function setFilter(id) {
  store.filterCitizen = store.filterCitizen === id ? null : id;
  emit('filter', store.filterCitizen);
}
