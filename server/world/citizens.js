// Citizens: normalize rows, persist them, validate new ones.
//
// In memory a citizen is one flat object: the real table columns
// (id, name, kind, alive, location, bornAt, diedAt) plus everything from the
// `data` JSON column. Always read rows through normalizeCitizen() so fields
// added in later steps get defaults without a migration. Unknown fields in
// `data` are kept untouched.
import { initialKnownPlaces } from './places.js';

const COLUMN_KEYS = new Set(['id', 'name', 'kind', 'alive', 'location', 'bornAt', 'diedAt']);
const KINDS = new Set(['citizen', 'shadow', 'avatar']);
const TRAITS = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'];

export const ACTIVITY_TYPES = ['idle', 'thinking', 'moving', 'doing', 'waiting', 'talking', 'sleeping', 'collapsed'];

export function defaultNeeds() {
  return {
    hunger: 20,
    fatigue: 20,
    hp: 100,
    hpMax: 100,
    levels: { hunger: 0, fatigue: 0, hp: 0 },        // last level the citizen was TOLD about
    lastReminderAt: { hunger: 0, fatigue: 0, hp: 0 },
  };
}

export function defaultPersona() {
  return {
    age: null,
    sex: null,
    occupation: null,
    appearance: '',
    traits: Object.fromEntries(TRAITS.map((t) => [t, 0.5])),
    personality: '',
    backstory: '',
    goals: [],
    speechStyle: '',
    appearanceTags: [],   // step 5.5: visible cues from content/cues.json (hooded, armed, foreign…)
    secretGoals: [],      // step 5.5: private aims; only ever in their OWN prompt
    covets: [],           // step 6: tags / object types / roles they want (drives envy)
  };
}

function defaultData() {
  return {
    persona: defaultPersona(),
    home: null,
    activity: { type: 'idle', since: 0, until: null, detail: null },
    inbox: [],
    thinkingInbox: [],      // inbox snapshot taken by an in-flight think (restored if it is aborted)
    conversationId: null,
    lastThought: null,      // model reasoning (trimmed)
    lastInnerThought: null, // the character's own voice (tool arg `inner_thought`)
    lastDecisionAt: null,
    thinkCooldownUntil: 0,
    recentActions: [],      // last few own actions; STEP 4: superseded by real memory
    needs: defaultNeeds(),
    knownPlaces: null,      // { roomId: { services: [], source, learnedAt } }; null = never set (World fills it in)
    marks: [],              // visible changes to appearance from director effects: [{ id, text, until }]
    sleepBuffer: [],        // importance 4–6 stimuli perceived while asleep, told on waking
    // step 4: memory
    coreMemory: '',         // first person, ≤ ~250 words; rewritten at nightly consolidation
    onMyMind: [],           // [{ text, importance, gameTime, memoryId }], cleared at consolidation
    lastConsolidatedAt: null,
    lastDecayAt: null,
    // step 4: day plans
    plan: null,             // see agents/plan.js
    yesterdayPlan: null,
    needsPlan: true,        // plan at the next calm idle moment
    // step 5: objects (see world/objects.js)
    carrying: [],           // object ids held (mirror of objects.holder_id; at most 2 slots)
    knownObjects: {},       // { objectId: { lastSeenAt, roomId, holderId, placementSig, state, visible, touchedAt? } }
    roomSnapshots: {},      // { roomId: { at, objects: { objectId: "state|placement" } } }, last 20 rooms
    roomVisits: {},         // { roomId: n }: 5+ visits = familiar (notices the noticeable)
    searchCounts: {},       // { roomId: n }: repeated searches get better
    missingNoted: {},       // { objectId: gameTime }: owned things noticed missing (not repeated for 12 h)
    // step 5.5: groups, strangers, warning signs
    invitations: [],        // pending party invitations: [{ from, purpose, at, until }]
    partyProposal: null,    // their own last proposal
    roomLog: [],            // last 4 room changes with who arrived right after (the "being followed" sign)
    strangerTrust: 0.5,     // learned attitude towards strangers, 0..1
    strangerLog: [],        // [{ at, value, why }]
    metStrangers: {},       // { otherId: gameTime of the first impression }
    signalNotes: {},
    // STEP 6: emotions
  };
}

export function normalizeCitizen(row) {
  const raw = typeof row.data === 'string' ? safeJson(row.data) : (row.data ?? {});
  const d = { ...defaultData(), ...raw };
  const persona = { ...defaultPersona(), ...(raw.persona ?? {}) };
  persona.traits = { ...defaultPersona().traits, ...(persona.traits ?? {}) };
  persona.goals = Array.isArray(persona.goals) ? persona.goals.map(String) : [];
  for (const k of ['appearanceTags', 'secretGoals', 'covets']) persona[k] = Array.isArray(persona[k]) ? persona[k].map(String) : [];

  const activity = { ...defaultData().activity, ...(d.activity ?? {}) };
  if (!ACTIVITY_TYPES.includes(activity.type)) activity.type = 'idle';

  return {
    ...d,
    id: String(row.id),
    name: String(row.name),
    kind: KINDS.has(row.kind) ? row.kind : 'citizen',
    alive: row.alive === undefined ? true : Boolean(row.alive),
    location: row.location ?? null,
    bornAt: row.born_at ?? row.bornAt ?? null,
    diedAt: row.died_at ?? row.diedAt ?? null,
    persona,
    activity,
    inbox: Array.isArray(d.inbox) ? d.inbox : [],
    thinkingInbox: Array.isArray(d.thinkingInbox) ? d.thinkingInbox : [],
    recentActions: Array.isArray(d.recentActions) ? d.recentActions : [],
    needs: normalizeNeeds(d.needs),
    knownPlaces: d.knownPlaces && typeof d.knownPlaces === 'object' && !Array.isArray(d.knownPlaces) ? d.knownPlaces : null,
    marks: Array.isArray(d.marks) ? d.marks : [],
    sleepBuffer: Array.isArray(d.sleepBuffer) ? d.sleepBuffer : [],
    onMyMind: Array.isArray(d.onMyMind) ? d.onMyMind : [],
    coreMemory: typeof d.coreMemory === 'string' ? d.coreMemory : '',
    carrying: Array.isArray(d.carrying) ? d.carrying : [],
    knownObjects: obj(d.knownObjects),
    roomSnapshots: obj(d.roomSnapshots),
    roomVisits: obj(d.roomVisits),
    searchCounts: obj(d.searchCounts),
    missingNoted: obj(d.missingNoted),
    invitations: Array.isArray(d.invitations) ? d.invitations : [],
    roomLog: Array.isArray(d.roomLog) ? d.roomLog : [],
    strangerTrust: Number.isFinite(Number(d.strangerTrust)) ? Number(d.strangerTrust) : 0.5,
    strangerLog: Array.isArray(d.strangerLog) ? d.strangerLog : [],
    metStrangers: obj(d.metStrangers),
    signalNotes: obj(d.signalNotes),
    thinkCooldownUntil: Number(d.thinkCooldownUntil) || 0,
  };
}

function obj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function normalizeNeeds(n) {
  const def = defaultNeeds();
  const out = { ...def, ...(n ?? {}) };
  out.levels = { ...def.levels, ...(n?.levels ?? {}) };
  out.lastReminderAt = { ...def.lastReminderAt, ...(n?.lastReminderAt ?? {}) };
  for (const k of ['hunger', 'fatigue', 'hp', 'hpMax']) out[k] = Number.isFinite(Number(out[k])) ? Number(out[k]) : def[k];
  return out;
}

export function dataOf(c) {
  const data = {};
  for (const [k, v] of Object.entries(c)) if (!COLUMN_KEYS.has(k)) data[k] = v;
  return data;
}

export function createCitizenStore(db) {
  const update = db.prepare(`UPDATE citizens SET name = ?, kind = ?, alive = ?, location = ?, born_at = ?, died_at = ?, data = ?
                             WHERE id = ?`);
  const insert = db.prepare(`INSERT INTO citizens (id, name, kind, alive, location, born_at, died_at, data)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  return {
    loadAll() {
      const map = new Map();
      for (const row of db.prepare('SELECT * FROM citizens').all()) {
        const c = normalizeCitizen(row);
        map.set(c.id, c);
      }
      return map;
    },
    save(c) {
      update.run(c.name, c.kind, c.alive ? 1 : 0, c.location, c.bornAt, c.diedAt, JSON.stringify(dataOf(c)), c.id);
    },
    insert(c) {
      insert.run(c.id, c.name, c.kind, c.alive ? 1 : 0, c.location, c.bornAt, c.diedAt, JSON.stringify(dataOf(c)));
    },
  };
}

// Validate a citizen definition (shape of content/citizens.json entries).
// Returns a normalized citizen ready to insert, or throws an Error with a readable message.
export function citizenFromInput(input, { rooms, existingIds, now }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('citizen must be a JSON object');
  const errors = [];
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) errors.push('name is required');
  const id = String(input.id ?? slug(name)).trim();
  if (!/^[a-z0-9_-]{1,40}$/.test(id)) errors.push('id must be 1–40 chars of a-z, 0-9, _ or -');
  if (existingIds.has(id)) errors.push(`id "${id}" already exists`);
  if (!input.location || !rooms.has(input.location)) errors.push(`location must be one of: ${[...rooms.keys()].join(', ')}`);
  if (input.home != null && !rooms.has(input.home)) errors.push(`home must be a room id or null`);
  if (input.kind != null && !KINDS.has(input.kind)) errors.push(`kind must be one of: ${[...KINDS].join(', ')}`);
  const kp = input.knownPlaces;
  if (kp != null && kp !== 'all' && !Array.isArray(kp)) errors.push('knownPlaces must be "all" or an array of room ids');
  if (Array.isArray(kp)) for (const r of kp) if (!rooms.has(r)) errors.push(`knownPlaces: unknown room "${r}"`);
  if (input.needs != null && typeof input.needs !== 'object') errors.push('needs must be an object like { "hunger": 40, "fatigue": 30 }');

  const p = input.persona;
  if (!p || typeof p !== 'object') {
    errors.push('persona object is required');
  } else {
    for (const key of ['occupation', 'appearance', 'personality']) {
      if (typeof p[key] !== 'string' || !p[key].trim()) errors.push(`persona.${key} is required (string)`);
    }
    if (p.age != null && !(Number(p.age) >= 0)) errors.push('persona.age must be a number');
    if (p.goals != null && !Array.isArray(p.goals)) errors.push('persona.goals must be an array of strings');
    for (const k of ['appearanceTags', 'secretGoals', 'covets']) if (p[k] != null && !Array.isArray(p[k])) errors.push(`persona.${k} must be an array of strings`);
    if (p.traits != null) {
      for (const [k, v] of Object.entries(p.traits)) {
        if (!TRAITS.includes(k)) errors.push(`persona.traits.${k} is not a Big Five trait`);
        else if (!(Number(v) >= 0 && Number(v) <= 1)) errors.push(`persona.traits.${k} must be between 0 and 1`);
      }
    }
  }
  if (errors.length) throw new Error(errors.join('; '));

  return normalizeCitizen({
    id,
    name,
    kind: input.kind ?? 'citizen',
    alive: 1,
    location: input.location,
    born_at: now,
    died_at: null,
    data: {
      persona: p,
      home: input.home ?? null,
      activity: { type: 'idle', since: now, until: null, detail: null },
      // Default: a local who knows the whole village. Newcomers list the few places they know.
      knownPlaces: initialKnownPlaces(rooms, kp ?? 'all', { location: input.location, home: input.home ?? null, now }),
      needs: {
        ...defaultNeeds(),
        ...pickNumbers(input.needs, ['hunger', 'fatigue', 'hp', 'hpMax']),
      },
    },
  });
}

function pickNumbers(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && Number.isFinite(Number(obj[k]))) out[k] = Number(obj[k]);
  return out;
}

// Pronouns for generated narration about fictional characters, from persona.sex.
export function pronouns(c) {
  const sex = String(c?.persona?.sex ?? '').toLowerCase();
  if (sex === 'female' || sex === 'f') return { subj: 'she', obj: 'her', poss: 'her' };
  if (sex === 'male' || sex === 'm') return { subj: 'he', obj: 'him', poss: 'his' };
  return { subj: 'they', obj: 'them', poss: 'their' };
}

/** Compact needs for the UI (values + the levels the citizen was last told about). */
export function needsSummary(c) {
  const n = c.needs ?? {};
  return {
    hunger: Math.round(n.hunger ?? 0), fatigue: Math.round(n.fatigue ?? 0),
    hp: Math.round(n.hp ?? 100), hpMax: n.hpMax ?? 100, levels: n.levels ?? {},
  };
}

export function citizenSummary(c) {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    alive: c.alive,
    location: c.location,
    activity: c.activity,
    conversationId: c.conversationId,
    occupation: c.persona.occupation,
    bornAt: c.bornAt,
    lastInnerThought: c.lastInnerThought,
    lastDecisionAt: c.lastDecisionAt,
    hp: c.needs?.hp ?? 100,
    needs: needsSummary(c),
    marks: c.marks,
  };
}

function slug(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
