// Step 9.5 (A2/A3): habits, generated per citizen and evolving. Routine behaviour that CODE may carry out — but only in a
// calm moment, never an intention, and never more than twice in a row (then the citizen decides again, staying present
// in their own life). A habit run by code shows in their next prompt as "out of habit, you …".
//
//   c.habits = [{ id, what, doing, kind, window: ["HH:MM","HH:MM"], place, action: { type, target?, minutes?, until_rested? },
//                 strength 0..1, lastDone, lastJudged, origin: generated|consolidation|director, history: [{ at, op, why }] }]
//   place: a room id, 'home', 'any_food' or 'any_bed' (resolved against KNOWN places)
//   action.type: travel_to · do · eat · sleep · wait · use (existing tools only)
//
// Generation: purpose 'habits' (tier full), once per citizen without habits; a code default if no LLM is up.
// Evolution: the nightly consolidation returns habit_changes (at most 2, each with a why; logged as habit_change).
// Strength: done inside the window +0.05 (max 1), a window passed without it −0.1; below 0.2 it is dropped.
import { clockTime } from '../world/time.js';
import { activeServices } from '../world/rooms.js';
import { knownWith, travelMinutes } from '../world/places.js';
import { systemPrompt } from './prompt.js';
import { chatForTool } from '../llm.js';
import { maxImportance } from '../world/perception.js';

export const KINDS = ['work', 'need', 'rest', 'social', 'care', 'other'];
export const ACTIONS = ['travel_to', 'do', 'eat', 'sleep', 'wait', 'use'];
export const MAX_HABITS = 8;
const MAX_CHANGES = 2;
const MAX_IN_A_ROW = 2;
const DROP_BELOW = 0.2;
const RETRY_GEN_MINUTES = 120;

const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim()); return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null; };
const hhmm = (m) => clockTime(((m % 1440) + 1440) % 1440);
const tod = (now) => ((now % 1440) + 1440) % 1440;
const dayStart = (now) => Math.floor(now / 1440) * 1440;

/** Is time-of-day `t` inside [a, b] (windows may wrap past midnight)? */
function inWindow(t, [a, b]) {
  return a <= b ? t >= a && t <= b : t >= a || t <= b;
}

/**
 * Stimuli that are part of an ordinary day, not something happening: their own activity ending, arriving, waking, a
 * need reminder (pressing needs block the autopilot on their own). A calm-day GLM run showed the timer alone (importance
 * 6) kept every habit from running.
 */
export function isRoutineStimulus(s) {
  if (s.kind === 'timer' && !s.data?.wakeUp) return true;
  if (s.kind === 'body' && s.data?.need && (s.data.level ?? 0) < 3) return true;
  return s.kind === 'arrive' && /^You (arrive|reach)\b/.test(String(s.text ?? '')); // their own arrival, not someone walking in
}

export class Habits {
  constructor(world) {
    this.world = world;
    this.generating = new Set();
    this.lastGenTry = new Map();
    this.lastJudge = -Infinity;
  }

  // ---------- validation ----------
  #placeOk(c, place) {
    if (['home', 'any_food', 'any_bed'].includes(place)) return place === 'home' ? Boolean(c.home) : true;
    return Boolean(place && this.world.rooms.has(place) && c.knownPlaces?.[place]);
  }

  /** A habit as the model (or the director) gave it → a clean habit, or null. */
  normalize(c, h, { origin = 'generated', id = null } = {}) {
    if (!h || typeof h !== 'object') return null;
    const what = String(h.what ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const w = Array.isArray(h.window) ? h.window : String(h.window ?? '').split(/[-–]/);
    const a = toMin(w[0]); const b = toMin(w[1]);
    const place = String(h.place ?? '').trim();
    const type = String(h.action?.type ?? h.action ?? '').trim();
    if (!what || a == null || b == null || a === b || !this.#placeOk(c, place) || !ACTIONS.includes(type)) return null;
    const action = { type };
    if (h.action?.target) action.target = String(h.action.target).trim().slice(0, 60);
    if (type === 'do' || type === 'wait') action.minutes = Math.max(5, Math.min(240, Math.round(Number(h.action?.minutes) || 60)));
    if (type === 'sleep') action.until_rested = true;
    const doing = String(h.doing ?? '').trim().slice(0, 100) || null;
    return {
      id: id ?? h.id ?? null, what, doing, kind: KINDS.includes(h.kind) ? h.kind : 'other', window: [hhmm(a), hhmm(b)], place, action,
      strength: Math.max(0.2, Math.min(1, Number(h.strength) || 0.8)), lastDone: h.lastDone ?? null, lastJudged: h.lastJudged ?? null,
      origin, history: Array.isArray(h.history) ? h.history.slice(-10) : [],
    };
  }

  #withIds(c, list) {
    let n = Math.max(0, ...(c.habits ?? []).map((h) => Number(String(h.id).slice(1)) || 0), c.habitSeq ?? 0);
    for (const h of list) if (!h.id || list.filter((x) => x.id === h.id).length > 1 || (c.habits ?? []).some((x) => x.id === h.id && x !== h)) h.id = `h${++n}`;
    c.habitSeq = n;
    return list;
  }

  set(c, list, { origin = 'generated', why = null } = {}) {
    const clean = (Array.isArray(list) ? list : []).map((h) => this.normalize(c, h, { origin })).filter(Boolean).slice(0, MAX_HABITS);
    c.habits = [];
    c.habits = this.#withIds(c, clean);
    for (const h of c.habits) h.history.push({ at: this.world.now, op: origin === 'director' ? 'edit' : 'generated', why });
    this.world.saveCitizen(c);
    this.world.logEvent('habits', { actorId: c.id, origin, n: c.habits.length, habits: c.habits.map((h) => `${h.window.join('–')} ${h.what}`) });
    return c.habits;
  }

  // ---------- generation (A2.2) ----------
  async generate(c) {
    const w = this.world;
    if (this.generating.has(c.id)) return null;
    this.generating.add(c.id);
    this.lastGenTry.set(c.id, w.now);
    try {
      const places = Object.keys(c.knownPlaces ?? {}).filter((id) => w.rooms.has(id));
      const placeEnum = [...places, ...(c.home ? ['home'] : []), 'any_food', 'any_bed'];
      const groups = w.groups.of(c.id).map((m) => `${m.group.name} (${m.group.kind})`).join(', ');
      const user = [
        `# PLACES YOU KNOW\n${places.map((id) => `- "${id}" = ${w.rooms.get(id).name}: ${w.rooms.get(id).description ?? ''}`).join('\n')}`,
        c.home ? `Your home: "${c.home}" (${w.rooms.get(c.home)?.name}).` : 'You have no home here.',
        groups ? `You belong to: ${groups}.` : '',
        "# WHAT NOW\nDescribe your ordinary daily routine as 3 to 8 habits: things you do most days without thinking about them (work, meals, rest, people you see). For each: what (a few words), doing (an -ing phrase for when you do it, e.g. 'kneading the morning dough'), kind, a time window (\"HH:MM\" start and end), the place (a place id from the list, or home / any_food / any_bed), and the action: travel_to (just going there), do (working at something, with minutes and optionally the thing you work on), eat, sleep, wait, or use (a thing there). Only places you know. Call set_habits exactly once.",
      ].filter(Boolean).join('\n\n');
      const tools = [{
        type: 'function',
        function: {
          name: 'set_habits', description: 'Your daily routine.',
          parameters: {
            type: 'object',
            properties: {
              habits: {
                type: 'array', minItems: 3, maxItems: MAX_HABITS,
                items: {
                  type: 'object',
                  properties: {
                    what: { type: 'string' }, doing: { type: 'string' }, kind: { type: 'string', enum: KINDS },
                    window: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
                    place: { type: 'string', enum: placeEnum },
                    action: { type: 'object', properties: { type: { type: 'string', enum: ACTIONS }, target: { type: 'string' }, minutes: { type: 'integer', minimum: 5, maximum: 240 } }, required: ['type'] },
                  },
                  required: ['what', 'kind', 'window', 'place', 'action'],
                },
              },
            },
            required: ['habits'],
          },
        },
      }];
      let list = null;
      const messages = [{ role: 'system', content: systemPrompt(w, c) }, { role: 'user', content: user }];
      const habitsOf = (r) => r?.toolCalls?.find((t) => t.name === 'set_habits')?.arguments?.habits ?? null;
      try {
        list = habitsOf(await chatForTool(w.llm, { purpose: 'habits', tier: 'full', citizenId: c.id, tools, messages }, 'set_habits'));
        // a long think can leave the tool call empty (seen with GLM at 3,000 tokens): once more without thinking
        if (!Array.isArray(list) || list.length < 3) list = habitsOf(await w.llm.chat({ purpose: 'habits', tier: 'none', maxTokens: 3000, citizenId: c.id, tools, messages }));
      } catch (err) {
        if (err.code !== 'unavailable') w.logEvent('error', { actorId: c.id, message: `habit generation failed: ${String(err.message).slice(0, 200)}` });
      }
      const clean = (Array.isArray(list) ? list : []).map((h) => this.normalize(c, h)).filter(Boolean);
      if (clean.length >= 3) return this.set(c, clean, { origin: 'generated' });
      return this.set(c, this.defaults(c), { origin: 'generated', why: 'code default (no usable answer from the model)' });
    } finally {
      this.generating.delete(c.id);
    }
  }

  /** A plain routine from the persona, when no model is available. */
  defaults(c) {
    const w = this.world;
    // where they work: a room they own, else the known room (not home) where most of their things are
    const owned = new Map();
    for (const o of w.objects.byId.values()) if (o.ownerId === c.id && o.roomId && o.roomId !== c.home) owned.set(o.roomId, (owned.get(o.roomId) ?? 0) + 1);
    const work = Object.keys(c.knownPlaces ?? {}).find((id) => id !== c.home && w.rooms.get(id)?.owner === c.id)
      ?? [...owned.entries()].filter(([id]) => c.knownPlaces?.[id]).sort((a, b) => b[1] - a[1])[0]?.[0];
    const out = [];
    if (work) out.push({ what: `work as ${c.persona?.occupation ?? 'usual'}`, doing: `working as ${c.persona?.occupation ?? 'usual'}`, kind: 'work', window: ['07:00', '11:00'], place: work, action: { type: 'do', minutes: 120 } });
    out.push({ what: 'eat at midday', kind: 'need', window: ['11:30', '13:30'], place: 'any_food', action: { type: 'eat' } });
    out.push({ what: 'eat in the evening', kind: 'need', window: ['18:00', '19:30'], place: 'any_food', action: { type: 'eat' } });
    if (c.home) out.push({ what: 'go home to sleep', kind: 'rest', window: ['21:30', '23:30'], place: 'home', action: { type: 'sleep', until_rested: true } });
    return out;
  }

  /** Citizens without habits get them (a few at a time; retried after a while if it failed). */
  ensure() {
    const w = this.world;
    if (!w.clock.running) return;
    for (const c of w.citizens.values()) {
      if (!c.alive || c.kind !== 'citizen' || (c.habits ?? []).length || this.generating.has(c.id)) continue;
      if (this.generating.size >= 2) break;
      if (w.now - (this.lastGenTry.get(c.id) ?? -Infinity) < RETRY_GEN_MINUTES) continue;
      this.generate(c).catch(() => {});
    }
  }

  // ---------- when, where ----------
  resolvePlace(c, place) {
    const w = this.world;
    if (place === 'home') return c.home && w.rooms.has(c.home) ? c.home : null;
    const nearest = (service) => knownWith(c, service).map((id) => ({ id, m: travelMinutes(w.rooms, c.location, id, w.now) })).filter((x) => x.m != null).sort((a, b) => a.m - b.m)[0]?.id ?? null;
    if (place === 'any_food') return activeServices(w.rooms.get(c.location), w.now).food ? c.location : nearest('food');
    if (place === 'any_bed') return c.home && w.rooms.get(c.home)?.services?.bed ? c.home : nearest('bed');
    return w.rooms.has(place) ? place : null;
  }

  /** A habit whose window is open now (for the dead too: "this is when Jonas used to sweep"). */
  windowNow(c) {
    const t = tod(this.world.now);
    return (c.habits ?? []).find((h) => inWindow(t, h.window.map(toMin))) ?? null;
  }

  /** Done in today's window already? */
  #doneToday(h) {
    if (h.lastDone == null) return false;
    const [a] = h.window.map(toMin);
    const now = this.world.now;
    // the window's start today (or yesterday, for a window that wraps past midnight and started before)
    let start = dayStart(now) + a;
    if (start > now) start -= 1440;
    return h.lastDone >= start;
  }

  due(c) {
    const t = tod(this.world.now);
    return (c.habits ?? []).filter((h) => h.strength >= DROP_BELOW && inWindow(t, h.window.map(toMin)) && !this.#doneToday(h) && (h.failedAt ?? -Infinity) < this.world.now - 60)
      .sort((a, b) => b.strength - a.strength)[0] ?? null;
  }

  // ---------- A3: autopilot only when calm ----------
  calm(c) {
    const w = this.world;
    if (c.activity.type !== 'idle') return { ok: false, why: 'busy' };
    if ((c.habitStreak ?? 0) >= MAX_IN_A_ROW) return { ok: false, why: 'two habits in a row' };
    if (c.conversationId) return { ok: false, why: 'in a conversation' };
    if (maxImportance((c.inbox ?? []).filter((x) => !isRoutineStimulus(x))) >= 5) return { ok: false, why: 'something to react to' };
    if ((c.lastStrongAt ?? -Infinity) > w.now - 30) return { ok: false, why: 'something important lately' };
    if ((c.lastAddressedAt ?? -Infinity) > w.now - 10) return { ok: false, why: 'spoken to lately' };
    if (w.emotions.of(c).some((e) => e.intensity >= 5 || w.emotions.expressed(c, e) >= 5)) return { ok: false, why: 'a strong feeling' };
    if (w.objects.inRoom(c.location).some((o) => o.typeId === 'corpse')) return { ok: false, why: 'a body here' };
    if (c.mortal?.state || w.body?.criticalHere(c)) return { ok: false, why: 'the body in danger' };
    if (Object.values(c.needs?.levels ?? {}).some((l) => l >= 3)) return { ok: false, why: 'a pressing need' };
    if ((w.deaths?.dreadFor(c) ?? 0) >= 4) return { ok: false, why: 'the village is on edge' };
    return { ok: true };
  }

  /** The scheduler asks: carry out a habit now, by code? → the habit, or null. */
  autopilot(c) {
    const h = this.due(c);
    if (!h) return null;
    return this.calm(c).ok ? h : null;
  }

  /** Code carries out one habit step (no LLM). Returns true when something started. */
  run(c, h) {
    const w = this.world;
    const act = (name, args) => w.applyAction(c, { name, arguments: args, planned: true, habit: h.id });
    const place = this.resolvePlace(c, h.place);
    let r = null;
    let text = null;
    if (place && place !== c.location && h.action.type !== 'travel_to') {
      r = act('travel_to', { destination: place });
      text = `out of habit, you set off for ${w.rooms.get(place)?.name} (${h.what})`;
      if (r?.ok) c.habitPending = { id: h.id, place };
    } else {
      c.habitPending = null;
      switch (h.action.type) {
        case 'travel_to': r = place && place !== c.location ? act('travel_to', { destination: place }) : { ok: true }; break;
        case 'eat': r = act('eat', {}); break;
        case 'sleep': r = act('sleep', { until_rested: true }); break;
        case 'wait': r = act('wait', { reason: h.what, minutes: h.action.minutes ?? 30 }); break;
        case 'use': {
          const o = h.action.target ? w.objects.match(c, h.action.target) : null;
          r = o ? act('use', { object: w.objects.alias(o), intent: h.what }) : { ok: false };
          break;
        }
        default: {
          const o = h.action.target ? w.objects.match(c, h.action.target) : null;
          const doing = h.doing || `${h.what.replace(/^(\w+)/, (m) => `${m.replace(/e$/, '')}ing`)}`;
          r = act('do', { action: doing, minutes: h.action.minutes ?? 60, ...(o ? { target: w.objects.alias(o) } : {}) });
        }
      }
      text = `out of habit, you ${h.what}`;
      if (r?.ok) { h.lastDone = w.now; h.strength = Math.min(1, h.strength + 0.05); }
    }
    if (!r?.ok) {
      // a habit they couldn't keep: the citizen decides (and may make it an intention)
      h.failedAt = w.now;
      c.habitPending = null;
      w.saveCitizen(c);
      return false;
    }
    c.habitStreak = (c.habitStreak ?? 0) + 1;
    c.habitNote = { text, at: w.now, id: h.id };
    w.logEvent('habit', { actorId: c.id, location: c.location, id: h.id, what: h.what, step: place && place !== c.location && h.action.type !== 'travel_to' ? 'travel' : h.action.type });
    w.saveCitizen(c);
    return true;
  }

  /** A decision by the citizen ends the autopilot streak (A3). */
  onDecision(c) {
    if (c.habitStreak || c.habitPending) { c.habitStreak = 0; c.habitPending = null; }
  }

  // ---------- strength (A2.3) ----------
  /** Once a window has closed today: done → kept (+0.05 was given when done), skipped → −0.1; below 0.2 → dropped. */
  judge() {
    const w = this.world;
    if (w.now - this.lastJudge < 10) return;
    this.lastJudge = w.now;
    const t = tod(w.now);
    for (const c of w.citizens.values()) {
      if (!c.alive || !(c.habits ?? []).length) continue;
      let changed = false;
      for (const h of [...c.habits]) {
        const [a, b] = h.window.map(toMin);
        if (a > b) continue; // windows past midnight are judged by the next day's run; keep it simple
        const closedToday = t > b;
        const today = dayStart(w.now);
        if (!closedToday || (h.lastJudged ?? -1) >= today) continue;
        h.lastJudged = today;
        changed = true;
        const done = h.lastDone != null && h.lastDone >= today + a - 60;
        if (!done) {
          h.strength = Math.round((h.strength - 0.1) * 100) / 100;
          if (h.strength < DROP_BELOW) {
            c.habits = c.habits.filter((x) => x !== h);
            w.logEvent('habit_change', { actorId: c.id, op: 'drop', id: h.id, what: h.what, why: 'it fell out of use' });
          }
        }
      }
      if (changed) w.saveCitizen(c);
    }
  }

  // ---------- evolution (nightly consolidation) ----------
  /** What they actually did in each habit's window over the last 3 days. */
  consolidationBlock(c) {
    const w = this.world;
    const list = c.habits ?? [];
    if (!list.length) return '';
    const rows = w.db.prepare("SELECT game_time, type, data FROM events WHERE actor_id = ? AND type IN ('action','habit') AND game_time >= ? ORDER BY id").all(c.id, w.now - 3 * 1440);
    const lines = list.map((h) => {
      const [a, b] = h.window.map(toMin);
      const days = [];
      for (let d = 1; d <= 3; d++) {
        const ds = dayStart(w.now) - (d - 1) * 1440;
        const inW = rows.filter((r) => r.game_time >= ds - (d === 1 ? 0 : 0) && r.game_time < ds + 1440 && inWindow(tod(r.game_time), [a, b]));
        const habitRun = inW.some((r) => r.type === 'habit' && JSON.parse(r.data).id === h.id);
        const acts = inW.filter((r) => r.type === 'action').map((r) => { const x = JSON.parse(r.data); return x.tool === 'do' ? x.args?.action : x.tool === 'travel_to' ? `went to ${w.rooms.get(x.args?.destination)?.name ?? x.args?.destination}` : x.tool; }).filter(Boolean);
        days.push(habitRun ? 'did it' : acts.length ? acts.slice(0, 2).join('; ') : 'nothing in particular');
      }
      return `- [${h.id}] ${h.window.join('–')} ${h.what} (at ${h.place}) — lately: ${days.join(' / ')}`;
    });
    return `# YOUR HABITS (and what you actually did at those times, last 3 days)\n${lines.join('\n')}`;
  }

  changesSchema(c) {
    const places = [...Object.keys(c.knownPlaces ?? {}).filter((id) => this.world.rooms.has(id)), ...(c.home ? ['home'] : []), 'any_food', 'any_bed'];
    const habit = {
      type: 'object',
      properties: {
        what: { type: 'string' }, doing: { type: 'string' }, kind: { type: 'string', enum: KINDS },
        window: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 }, place: { type: 'string', enum: places },
        action: { type: 'object', properties: { type: { type: 'string', enum: ACTIONS }, target: { type: 'string' }, minutes: { type: 'integer' } }, required: ['type'] },
      },
    };
    const ids = (c.habits ?? []).map((h) => h.id);
    return {
      type: 'array', maxItems: MAX_CHANGES, description: 'At most 2 changes to your daily routine, each with why.',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['add', 'modify', 'drop'] },
          ...(ids.length ? { id: { type: 'string', enum: ids } } : {}),
          habit: habit, changes: habit,
          why: { type: 'string', description: 'First person, short.' },
        },
        required: ['op', 'why'],
      },
    };
  }

  applyChanges(c, changes) {
    const w = this.world;
    const out = [];
    if (!c.alive) return out; // step 9.5: the dead have no routine to change
    for (const ch of (Array.isArray(changes) ? changes : []).slice(0, MAX_CHANGES)) {
      const why = String(ch?.why ?? '').trim().slice(0, 200) || null;
      if (!why) continue;
      if (ch.op === 'add') {
        if ((c.habits ?? []).length >= MAX_HABITS) continue;
        const h = this.normalize(c, ch.habit, { origin: 'consolidation' });
        if (!h) continue;
        c.habits = [...(c.habits ?? []), h];
        this.#withIds(c, c.habits);
        h.history.push({ at: w.now, op: 'add', why });
        out.push({ op: 'add', id: h.id, what: h.what, why });
      } else if (ch.op === 'modify') {
        const cur = (c.habits ?? []).find((x) => x.id === ch.id);
        if (!cur) continue;
        const next = this.normalize(c, { ...cur, ...(ch.changes ?? {}), action: { ...cur.action, ...(ch.changes?.action ?? {}) } }, { origin: cur.origin, id: cur.id });
        if (!next) continue;
        Object.assign(cur, { what: next.what, doing: next.doing, kind: next.kind, window: next.window, place: next.place, action: next.action });
        cur.history.push({ at: w.now, op: 'modify', why });
        out.push({ op: 'modify', id: cur.id, what: cur.what, why });
      } else if (ch.op === 'drop') {
        const cur = (c.habits ?? []).find((x) => x.id === ch.id);
        if (!cur) continue;
        c.habits = c.habits.filter((x) => x !== cur);
        out.push({ op: 'drop', id: cur.id, what: cur.what, why });
      }
    }
    for (const o of out) w.logEvent('habit_change', { actorId: c.id, ...o });
    if (out.length) w.saveCitizen(c);
    return out;
  }

  // ---------- prompt ----------
  /** Today's habits in brief, for the ON WAKING block. */
  brief(c) {
    const list = (c.habits ?? []).filter((h) => h.strength >= DROP_BELOW).sort((a, b) => toMin(a.window[0]) - toMin(b.window[0]));
    if (!list.length) return null;
    return list.map((h) => `${h.window[0]} ${h.what}`).join('; ');
  }

  view(c) {
    return (c.habits ?? []).map((h) => ({ ...h, strength: Math.round(h.strength * 100) / 100, due: this.due(c)?.id === h.id }));
  }
}
