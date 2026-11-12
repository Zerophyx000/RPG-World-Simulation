// Day plans: citizens plan their day once (one LLM call, tier full) and CODE carries the plan out.
// They only re-decide when something happens (a stimulus that triggers a think), a step fails,
// they find the person they meant to visit, or the plan is done.
//
// c.plan = { createdAt, steps: [{ kind, place, person, description, minutes, time, note, status }], cursor,
//            status: 'active'|'done'|'abandoned', interrupted, dropped }
// c.needsPlan  → the next calm idle moment is a planning think (set on morning wake-up, and for citizens
//               that never planned).
import { activeServices } from '../world/rooms.js';
import { clockTime } from '../world/time.js';

export const PLAN_MAX_STEPS = 12;
export const STEP_KINDS = ['travel', 'do', 'eat', 'visit', 'wait_until', 'sleep', 'follow'];
const FOLLOW_WAIT = 3; // game minutes between looks while staying close to someone
const MAX_WAIT = 240;

export function planActive(c) {
  return Boolean(c.plan && c.plan.status === 'active');
}

export function hasStepsLeft(c) {
  return planActive(c) && c.plan.cursor < c.plan.steps.length;
}

// ---------- the planning tool ----------
export function makePlanTool(world, c) {
  const places = Object.keys(c.knownPlaces ?? {}).filter((id) => world.rooms.has(id));
  const labels = [...world.memory.labelsFor(c, world.memory.knownPeople(c)).keys()];
  return {
    type: 'function',
    function: {
      name: 'make_plan',
      description: `Plan your day: what you intend to do, roughly when, and where. Up to ${PLAN_MAX_STEPS} steps, in order. Places you know: ${places.map((id) => `"${id}" = ${world.rooms.get(id).name}`).join('; ')}.`,
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array', maxItems: PLAN_MAX_STEPS,
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: STEP_KINDS, description: 'travel: go somewhere · do: spend time on something · eat · visit: go and find someone · wait_until: stay until a time · sleep · follow: stay with someone (e.g. a member of your party) wherever they go, for some minutes' },
                place: { type: 'string', enum: places, description: 'For travel, eat, sleep (and optionally do).' },
                person: { type: 'string', enum: labels.length ? labels : ['nobody'], description: 'For visit and follow.' },
                description: { type: 'string', description: 'For do / wait_until: what you are doing, an -ing phrase.' },
                thing: { type: 'string', description: 'For do, optional: the thing you will work on there, e.g. "the flour sacks" or "the hearth".' },
                minutes: { type: 'integer', minimum: 1, maximum: MAX_WAIT, description: 'For do and follow: roughly how long.' },
                time: { type: 'string', description: 'For wait_until: "HH:MM".' },
                note: { type: 'string', description: 'Why, in a few words (e.g. "ask about the debt").' },
              },
              required: ['kind'],
            },
          },
          inner_thought: { type: 'string', description: 'Optional. What you think about the day ahead.' },
        },
        required: ['steps'],
      },
    },
  };
}

/** Keep only steps that make sense for this citizen. Returns { steps, dropped }. */
export function validatePlan(world, c, raw) {
  const steps = [];
  let dropped = 0;
  const known = c.knownPlaces ?? {};
  const people = world.memory.labelsFor(c, world.memory.knownPeople(c));
  for (const s of (Array.isArray(raw) ? raw : []).slice(0, PLAN_MAX_STEPS)) {
    const step = normalizeStep(world, c, s, known, people);
    if (step) steps.push(step);
    else dropped++;
  }
  if (Array.isArray(raw) && raw.length > PLAN_MAX_STEPS) dropped += raw.length - PLAN_MAX_STEPS;
  return { steps, dropped };
}

function normalizeStep(world, c, s, known, people) {
  if (!s || !STEP_KINDS.includes(s.kind)) return null;
  const note = s.note ? String(s.note).trim().slice(0, 120) : null;
  const place = s.place && known[s.place] && world.rooms.has(s.place) ? s.place : null;
  switch (s.kind) {
    case 'travel':
      return place ? { kind: 'travel', place, note, status: 'pending' } : null;
    case 'do': {
      const description = String(s.description ?? '').trim();
      if (!description) return null;
      const thing = s.thing ? String(s.thing).trim().slice(0, 60) : null;
      return { kind: 'do', place, description: description.slice(0, 120), minutes: clampInt(s.minutes, 1, MAX_WAIT, 60), ...(thing ? { thing } : {}), note, status: 'pending' };
    }
    case 'eat':
      if (!place || !known[place].services.includes('food')) return null;
      return { kind: 'eat', place, note, status: 'pending' };
    case 'sleep':
      return place ? { kind: 'sleep', place, note, status: 'pending' } : null;
    case 'visit': {
      const o = people.get(s.person) ?? [...people.values()].find((p) => p.id === s.person || p.name.toLowerCase() === String(s.person ?? '').toLowerCase());
      return o ? { kind: 'visit', person: o.id, note, status: 'pending' } : null;
    }
    case 'follow': {
      const o = people.get(s.person) ?? [...people.values()].find((p) => p.id === s.person || p.name.toLowerCase() === String(s.person ?? '').toLowerCase());
      return o ? { kind: 'follow', person: o.id, minutes: clampInt(s.minutes, 5, MAX_WAIT, 120), note, status: 'pending' } : null;
    }
    case 'wait_until': {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(s.time ?? '').trim());
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
      return { kind: 'wait_until', time: `${m[1].padStart(2, '0')}:${m[2]}`, description: String(s.description ?? 'waiting').trim().slice(0, 120), note, status: 'pending' };
    }
    default:
      return null;
  }
}

export function startPlan(world, c, steps, dropped) {
  c.plan = { createdAt: world.now, steps, cursor: 0, status: steps.length ? 'active' : 'done', interrupted: false, dropped };
  c.needsPlan = false;
  world.saveCitizen(c);
  world.logEvent('plan', { actorId: c.id, location: c.location, steps: steps.length, dropped });
}

/** Replace the remaining steps (revise_plan). */
export function revisePlan(world, c, raw) {
  const { steps, dropped } = validatePlan(world, c, raw);
  const done = c.plan ? c.plan.steps.slice(0, c.plan.cursor) : [];
  c.plan = { ...(c.plan ?? { createdAt: world.now }), steps: [...done, ...steps], cursor: done.length, status: 'active', interrupted: false, dropped };
  world.saveCitizen(c);
  world.logEvent('plan', { actorId: c.id, location: c.location, revised: true, steps: steps.length, dropped });
}

/** On a morning wake-up: today's plan becomes yesterday's, and a new one is due. */
export function endOfDay(world, c) {
  if (c.plan) {
    const unfinished = c.plan.steps.slice(c.plan.cursor).map((s) => stepText(world, c, s));
    c.yesterdayPlan = { createdAt: c.plan.createdAt, unfinished, done: c.plan.steps.slice(0, c.plan.cursor).map((s) => stepText(world, c, s)) };
  }
  c.plan = null;
  c.needsPlan = true;
}

// ---------- execution (code, no LLM) ----------
/**
 * Called by the scheduler when a citizen with an active plan is idle and nothing urgent is pending.
 * Runs steps until one starts an activity (or fails / needs a decision).
 */
export function runPlan(world, c) {
  const plan = c.plan;
  plan.interrupted = false;
  for (let guard = 0; guard <= PLAN_MAX_STEPS + 1; guard++) {
    if (plan.cursor >= plan.steps.length) {
      plan.status = 'done';
      world.saveCitizen(c);
      world.perceive([c.id], { kind: 'timer', text: "You've done everything you planned for today.", importance: 5, data: { planEnd: true } });
      return;
    }
    const step = plan.steps[plan.cursor];
    const r = runStep(world, c, step);
    if (r === 'skip' || r === 'started-done') {
      step.status = 'done';
      plan.cursor++;
      if (r === 'started-done') return world.saveCitizen(c);
      continue;
    }
    if (r === 'started') {
      step.status = 'active';
      return world.saveCitizen(c);
    }
    // failed / found: the citizen has to decide
    step.status = r.kind === 'found' ? 'done' : 'failed';
    plan.cursor++;
    world.saveCitizen(c);
    world.perceive([c.id], {
      kind: 'timer', text: r.text, importance: 5,
      data: { tierHint: 'light', planEnd: plan.cursor >= plan.steps.length },
    });
    return;
  }
}

// 'skip' (nothing to do) | 'started' (step still running afterwards) | 'started-done' (step complete once this ends)
// | { kind: 'failed'|'found', text }
function runStep(world, c, step) {
  const act = (name, args) => world.applyAction(c, { name, arguments: args, planned: true });
  const here = c.location;
  const goTo = (place) => {
    const ok = act('travel_to', { destination: place });
    return ok?.ok ? 'started' : { kind: 'failed', text: `Your plan hit a snag: you couldn't get to ${world.rooms.get(place)?.name ?? 'where you meant to go'}.` };
  };
  switch (step.kind) {
    case 'travel':
      if (here === step.place) return 'skip';
      {
        const r = goTo(step.place);
        return r === 'started' ? 'started-done' : r;
      }
    case 'do':
      if (step.place && here !== step.place) return goTo(step.place);
      return act('do', { action: step.description, minutes: step.minutes, ...doTarget(world, c, step) }).ok ? 'started-done' : { kind: 'failed', text: `Your plan hit a snag: you couldn't get on with ${step.description}.` };
    case 'eat': {
      if (here !== step.place) return goTo(step.place);
      if (!activeServices(world.rooms.get(here), world.now).food) return { kind: 'failed', text: `Your plan hit a snag: there's nothing to eat at ${world.rooms.get(here)?.name}.` };
      return act('eat', {}).ok ? 'started-done' : { kind: 'failed', text: 'Your plan hit a snag: you couldn\'t eat here.' };
    }
    case 'sleep':
      if (here !== step.place) return goTo(step.place);
      return act('sleep', { until_rested: true }).ok ? 'started-done' : { kind: 'failed', text: 'Your plan hit a snag: you couldn\'t lie down here.' };
    case 'wait_until': {
      const [h, m] = step.time.split(':').map(Number);
      const target = Math.floor(world.now / 1440) * 1440 + h * 60 + m;
      const left = target - world.now;
      if (left <= 1) return 'skip';
      const minutes = Math.min(MAX_WAIT, Math.ceil(left));
      act('wait', { reason: step.description || `until ${step.time}`, minutes });
      return minutes >= left ? 'started-done' : 'started';
    }
    case 'follow': {
      // Stay with someone: code moves the citizen after them (about a minute behind) until the time is up.
      step.startedAt ??= world.now;
      const name = world.memory.nameFor(c, step.person);
      if (world.now - step.startedAt >= step.minutes) return 'skip';
      const t = world.citizens.get(step.person);
      if (!t || !t.alive) return { kind: 'failed', text: `Your plan hit a snag: ${name} is nowhere to be found.` };
      if (t.location === here) {
        world.setActivity(c, { type: 'waiting', until: world.now + FOLLOW_WAIT, detail: { reason: `staying close to ${name}`, minutes: FOLLOW_WAIT, silent: true, following: t.id } });
        return 'started';
      }
      const dest = t.location ?? t.activity?.detail?.to ?? null;
      if (!dest || !world.rooms.has(dest)) return { kind: 'failed', text: `Your plan hit a snag: you lost sight of ${name}.` };
      const adjacent = world.rooms.get(here)?.exits.some((e) => e.to === dest);
      const r = adjacent ? act('move_to', { destination: dest }) : act('travel_to', { destination: dest });
      return r?.ok ? 'started' : { kind: 'failed', text: `Your plan hit a snag: you lost sight of ${name}.` };
    }
    case 'visit': {
      const rel = world.memory.rel(c.id, step.person);
      const name = world.memory.nameFor(c, step.person);
      const target = world.citizens.get(step.person);
      const where = rel?.lastSeenPlace;
      if (target && target.alive && target.location === here) {
        return { kind: 'found', text: `You've found ${name}.${step.note ? ` You meant to: ${step.note}.` : ''}` };
      }
      if (!where || where === here) return { kind: 'failed', text: `Your plan hit a snag: ${name} isn't here, and you don't know where else to look.` };
      step.tried = true;
      return goTo(where);
    }
    default:
      return 'skip';
  }
}

/** One step as words, from the citizen's point of view. */
export function stepText(world, c, s) {
  const place = (id) => world.rooms.get(id)?.name ?? id;
  const note = s.note ? ` (${s.note})` : '';
  switch (s.kind) {
    case 'travel': return `go to ${place(s.place)}${note}`;
    case 'do': return `${s.description}${s.place ? ` at ${place(s.place)}` : ''}${note}`;
    case 'eat': return `eat at ${place(s.place)}${note}`;
    case 'sleep': return `sleep at ${place(s.place)}${note}`;
    case 'visit': return `find ${world.memory.nameFor(c, s.person)}${note}`;
    case 'follow': return `stay with ${world.memory.nameFor(c, s.person)} wherever they go (about ${s.minutes} min)${note}`;
    case 'wait_until': return `${s.description} until ${s.time}${note}`;
    default: return s.kind;
  }
}

// Step 5: "check the flour sacks" → the flour sacks they can see here become the do's target (the keeper may change them).
function doTarget(world, c, step) {
  if (!step.thing) return {};
  const o = world.objects.match(c, step.thing);
  return o ? { target: world.objects.alias(o) } : {};
}

/** YOUR PLAN block text for the prompt. */
export function planBlock(world, c) {
  if (!c.plan) return null;
  const p = c.plan;
  const lines = p.steps.map((s, i) => {
    const mark = s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : i === p.cursor ? '→' : '·';
    return `${mark} ${stepText(world, c, s)}`;
  });
  const head = p.status === 'done' ? 'You have done what you planned for today.'
    : p.status === 'abandoned' ? 'You gave up on your plan for today.'
      : p.interrupted ? 'Your plan for today (on hold while you deal with this):' : 'Your plan for today:';
  const extra = p.dropped ? '\nYou realize part of your plan made no sense.' : '';
  return `${head}\n${lines.join('\n')}${extra}`;
}

export function yesterdayText(world, c) {
  const y = c.yesterdayPlan;
  if (!y?.unfinished?.length) return null;
  return `Left undone from yesterday: ${y.unfinished.join('; ')}.`;
}

export function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export { clockTime };
