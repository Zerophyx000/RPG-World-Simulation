// Tools a citizen can use, built fresh per citizen per think so enums only contain values that
// are valid right now. Descriptions are written in the citizen's world, never in technical terms.
// Unknown places are described by how they look (appearance), known ones by name.
import { citizensIn, openExits, activeServices } from '../world/rooms.js';
import { placeLabel } from '../world/places.js';
import { planActive, STEP_KINDS, PLAN_MAX_STEPS } from './plan.js';
import { RELATIONS } from '../world/objects.js';
import { frameTools } from '../emotions/present.js';
import { feelingParam } from '../emotions/report.js';
import { CRAWL_FACTOR } from '../body/content.js';
import { treatOptions, pendingList, carriable, WASH_OFFERED } from '../body/treat.js';
import { cuesFor } from '../body/perceive.js';

const INNER_THOUGHT = {
  type: 'string',
  description: 'Optional. One or two sentences of what goes through your head right now, in your own voice. Nobody else hears it.',
};

export const LIMITS = { sayMax: 220, actionMax: 120, reasonMax: 160, minMinutes: 1, maxMinutes: 240, exhaustedMaxMinutes: 30 };

// Speech limits are enforced here but NOT shown in the schema: models treat a visible maxLength
// as a target length (GLM wrote ~290 chars against 300, ~200 against 220). They get a word count instead.
const HIDDEN_MAX = {
  say: { text: LIMITS.sayMax },
  leave_conversation: { farewell: LIMITS.sayMax },
  tell_about_place: { comment: 120 },
  decline_invitation: { reason: LIMITS.sayMax },
  leave_group: { farewell: LIMITS.sayMax },
};

export function buildTools(world, c) {
  const room = world.rooms.get(c.location);
  const tools = [];
  if (!room) return tools;
  const now = world.now;
  const present = citizensIn(world.citizens, c.location, { exceptId: c.id });
  const awake = present.filter((o) => o.activity.type !== 'sleeping' && o.activity.type !== 'collapsed');
  // People are offered by name only if this citizen knows it, otherwise as "the tall man".
  const awakeLabels = [...world.memory.labelsFor(c, awake).keys()];
  const services = activeServices(room, now);
  // Exhausted or worse: no committing to long tasks.
  const exhausted = world.needs.levelIndex('fatigue', c.needs) >= world.needs.levelOf('fatigue', 'exhausted');
  const maxMinutes = exhausted ? LIMITS.exhaustedMaxMinutes : LIMITS.maxMinutes;

  // move_to: one step to an adjacent place
  const exits = openExits(room, now).filter((e) => world.rooms.has(e.to));
  // Step 7B (a physical exception, with the reason in HOW YOU FEEL): the body decides how they get around.
  const bodyMoving = c.body?.capacities?.moving ?? 1;
  const crawling = bodyMoving < 0.35;
  if (exits.length && !crawling) {
    const list = exits.map((e) => `"${e.to}" = ${placeLabel(c, world.rooms.get(e.to))} (${e.travelMinutes} min walk)`).join('; ');
    tools.push(fn('move_to', `Walk to a place right next to here: ${list}.`, {
      destination: { type: 'string', enum: exits.map((e) => e.to), description: 'Where you go (one of the ids above).' },
      inner_thought: INNER_THOUGHT,
    }, ['destination']));
  } else if (exits.length && bodyMoving >= 0.05) {
    const list = exits.map((e) => `"${e.to}" = ${placeLabel(c, world.rooms.get(e.to))} (${e.travelMinutes * CRAWL_FACTOR} min of crawling)`).join('; ');
    tools.push(fn('crawl_to', `You can't walk. Drag yourself to a place right next to here, slowly and painfully, at a cost to your strength: ${list}.`, {
      destination: { type: 'string', enum: exits.map((e) => e.to), description: 'Where you go (one of the ids above).' },
      inner_thought: INNER_THOUGHT,
    }, ['destination']));
  }

  // travel_to: anywhere you know, the route is found for you
  const known = crawling ? [] : Object.keys(c.knownPlaces ?? {}).filter((id) => id !== room.id && world.rooms.has(id));
  if (known.length) {
    const list = known.map((id) => `"${id}" = ${world.rooms.get(id).name}`).join('; ');
    tools.push(fn('travel_to', `Go to a place you know, even if it is further away; you find the way there yourself. Places you know: ${list}.`, {
      destination: { type: 'string', enum: known, description: 'Where you go (one of the ids above).' },
      inner_thought: INNER_THOUGHT,
    }, ['destination']));
  }

  // say
  const sayProps = {
    text: {
      type: 'string',
      description: 'Exactly what you say out loud, in your own words: one or two short sentences, usually under 25 words. You can say more on your next turn.',
    },
  };
  if (awake.length) {
    sayProps.to = { type: 'string', enum: awakeLabels, description: 'Who you are speaking to. Leave it out to speak to nobody in particular.' };
  }
  sayProps.inner_thought = INNER_THOUGHT;
  const mute = (c.body?.status ?? []).includes('mute');
  if (mute) {
    // Step 7B: no voice. Gestures only (a physical exception; the reason is in HOW YOU FEEL).
    const gProps = { text: { type: 'string', description: 'What you gesture or mime, in a few words, e.g. "points frantically at the door".' } };
    if (awake.length) gProps.to = { type: 'string', enum: awakeLabels, description: 'Who you gesture to. Leave it out to gesture to everyone.' };
    gProps.inner_thought = INNER_THOUGHT;
    tools.push(fn('gesture', "You can't speak. Show something with your hands and face instead.", gProps, ['text']));
  } else {
    tools.push(fn('say',
      awake.length ? 'Say one or two sentences out loud. Everyone here can hear you.'
        : 'Say one or two sentences out loud. Nobody here is awake to hear you, so you would be talking to yourself.',
      sayProps, ['text']));
  }

  // tell_about_place: the way to explain where something is (the listener will then know it)
  const tellable = Object.keys(c.knownPlaces ?? {}).filter((id) => world.rooms.has(id));
  if (awake.length && tellable.length && !mute) {
    const list = tellable.map((id) => `"${id}" = ${world.rooms.get(id).name}`).join('; ');
    tools.push(fn('tell_about_place',
      `Tell someone here about a place you know: what it is, what can be had there and how to get there. This is how you explain where to find something, so that they can go there afterwards. Places you know: ${list}.`, {
        to: { type: 'string', enum: awakeLabels, description: 'Who you tell.' },
        place: { type: 'string', enum: tellable, description: 'Which place (one of the ids above).' },
        comment: { type: 'string', description: 'Optional. A few words of your own to add, e.g. advice or an opinion about the place.' },
        inner_thought: INNER_THOUGHT,
      }, ['to', 'place']));
  }

  // introduce_yourself: say your name (shy people rarely do otherwise)
  if (awake.length && !mute) {
    tools.push(fn('introduce_yourself', 'Tell people here your name.', {
      to: { type: 'string', enum: awakeLabels, description: 'Optional. Who you introduce yourself to.' },
      addition: { type: 'string', description: 'Optional. A few words more, e.g. where you are from or what you do.' },
      inner_thought: INNER_THOUGHT,
    }, []));
  }

  // Objects (step 5): only what is listed under WHAT'S HERE / YOU'RE CARRYING, by its [handle].
  const O = world.objects;
  const { here, carried } = O.actionable(c);
  const hereIds = here.map((o) => O.alias(o));
  const carriedIds = carried.map((o) => O.alias(o));
  const reachIds = [...hereIds, ...carriedIds];

  // do / wait
  const doProps = {
    action: {
      type: 'string',
      maxLength: LIMITS.actionMax,
      description: "What you are doing, as a short phrase starting with a verb in -ing form, without 'I', 'me' or 'my'. Example: 'kneading dough by the oven'.",
    },
    minutes: { type: 'integer', minimum: LIMITS.minMinutes, maximum: maxMinutes, description: 'Roughly how many minutes it takes.' },
  };
  if (reachIds.length) doProps.target = { type: 'string', enum: reachIds, description: 'Optional. The thing you are working on, by its [handle].' };
  doProps.inner_thought = INNER_THOUGHT;
  tools.push(fn('do',
    `Spend a while doing something here: working, tidying, resting, anything that fits. Others here can see what you are doing.${exhausted ? ' You are too exhausted for anything long.' : ''}`,
    doProps, ['action', 'minutes']));

  const hands = O.handsOf(c.id);
  const blind = (c.body?.status ?? []).includes('blind');
  if (reachIds.length) {
    tools.push(fn('examine', blind ? "You can't see; feel the thing with your hands instead, slowly (a few minutes)." : "Take a closer look at something here or something you're carrying (a minute or two).", {
      object: { type: 'string', enum: reachIds, description: blind ? 'What you feel, by its [handle].' : 'What you look at, by its [handle].' },
      inner_thought: INNER_THOUGHT,
    }, ['object']));
  }
  if (reachIds.length && hands > 0) {
    tools.push(fn('use', "Do something with a thing here or in your hands: light it, open it, lock it, tear it, pour it... Say what you try; whether it works depends on the thing.", {
      object: { type: 'string', enum: reachIds, description: 'What you use, by its [handle].' },
      intent: { type: 'string', maxLength: LIMITS.actionMax, description: "What you try to do with it, in a few words, e.g. 'light it' or 'lock the door'." },
      inner_thought: INNER_THOUGHT,
    }, ['object', 'intent']));
  }
  const searchProps = {};
  if (hereIds.length) searchProps.target = { type: 'string', enum: hereIds, description: 'Optional. Search just around this thing (quicker and more thorough). Leave it out to search the whole place.' };
  searchProps.inner_thought = INNER_THOUGHT;
  tools.push(fn('search', 'Search this place for things that are hidden or out of sight. Takes a while, and others here can see you poking around.', searchProps, []));

  const free = O.freeSlots(c.id);
  const takeable = here.filter((o) => O.type(o)?.portable && O.type(o).size <= free && !O.around(o.id, 'in').length).map((o) => O.alias(o));
  if (takeable.length) {
    tools.push(fn('take', `Pick something up and carry it. ${hands === 2 ? `You have two hands: ${free === 2 ? 'both are free' : 'one is free'}; big things need both.` : 'You have only one usable hand.'}`, {
      object: { type: 'string', enum: takeable, description: 'What you pick up, by its [handle].' },
      inner_thought: INNER_THOUGHT,
    }, ['object']));
  }
  if (carriedIds.length) {
    const putProps = {
      object: { type: 'string', enum: carriedIds, description: "What you put down, by its [handle]." },
      relation: { type: 'string', enum: RELATIONS, description: "Where, relative to the anchor: on, in, behind, under, beside — or 'floor' to just set it down." },
    };
    if (hereIds.length) putProps.anchor = { type: 'string', enum: hereIds, description: 'Optional. The thing you put it on / in / behind / under / beside.' };
    putProps.conceal = { type: 'boolean', description: 'Optional. True to hide it so that others will not easily find it.' };
    putProps.inner_thought = INNER_THOUGHT;
    tools.push(fn('put', 'Put down something you are carrying, somewhere here — openly, or hidden away.', putProps, ['object']));
    if (awake.length) {
      tools.push(fn('give', 'Hand something you are carrying to someone here.', {
        object: { type: 'string', enum: carriedIds, description: 'What you hand over, by its [handle].' },
        to: { type: 'string', enum: awakeLabels, description: 'Who you give it to.' },
        inner_thought: INNER_THOUGHT,
      }, ['object', 'to']));
    }
  }

  tools.push(fn('wait',
    'Wait, or simply let some time pass where you are. Something important happening will catch your attention.',
    {
      reason: { type: 'string', maxLength: LIMITS.reasonMax, description: 'What you are waiting for, or why.' },
      minutes: { type: 'integer', minimum: LIMITS.minMinutes, maximum: maxMinutes, description: 'How many minutes at most.' },
      inner_thought: INNER_THOUGHT,
    }, ['reason', 'minutes']));

  // eat: only where there is food
  if (services.food) {
    tools.push(fn('eat', `Sit down and eat here: ${services.food.description} (about ${services.food.minutes} minutes).`, {
      inner_thought: INNER_THOUGHT,
    }, []));
  }

  // sleep: always possible; a bed makes it good sleep, otherwise it's the ground
  tools.push(fn('sleep',
    services.bed ? `Lie down and sleep here: ${services.bed.description}.` : 'Lie down and sleep right here, on the hard ground. There is no bed here.',
    {
      until_rested: { type: 'boolean', description: 'Sleep until you are rested (the default).' },
      hours: { type: 'integer', minimum: 1, maximum: 12, description: 'Or: sleep for this many hours.' },
      inner_thought: INNER_THOUGHT,
    }, []));

  // feed: someone here has collapsed and there is food
  const collapsed = present.filter((o) => o.activity.type === 'collapsed');
  if (collapsed.length && services.food) {
    tools.push(fn('feed', `Kneel down and feed someone who has collapsed here, with ${services.food.description}.`, {
      who: { type: 'string', enum: [...world.memory.labelsFor(c, collapsed).keys()], description: 'Who you feed.' },
      inner_thought: INNER_THOUGHT,
    }, ['who']));
  }

  // Step 7B: tending wounds, looking people over, consent, carrying, washing.
  const treat = treatOptions(world, c, present);
  if (treat) {
    const list = treat.methods.map((id) => { const m = world.body.content.treatments.methods[id]; return `"${id}" = ${m.hint ?? m.label}`; }).join('; ');
    tools.push(fn('treat', `Tend to one wound, yours or someone else's here. Pick the wound and what you do for it (${list}). Improvised care is limited; real supplies and the right method do more.`, {
      wound: { type: 'string', enum: treat.wounds.map((w) => w.key), description: 'Whose wound, and which one (the most dangerous first if you can).' },
      method: { type: 'string', enum: treat.methods, description: 'What you do about it.' },
      inner_thought: INNER_THOUGHT,
    }, ['wound', 'method']));
  }
  const hurtHere = present.filter((o) => o.alive && (o.activity.type === 'collapsed' || cuesFor(world, o)));
  if (hurtHere.length && !['sleeping', 'collapsed'].includes(c.activity.type)) {
    tools.push(fn('examine_person', 'Look someone over carefully for injuries (a few minutes). You may find what is hurt, but things inside are hard to tell.', {
      person: { type: 'string', enum: [...world.memory.labelsFor(c, hurtHere).keys()], description: 'Who you look over.' },
      inner_thought: INNER_THOUGHT,
    }, ['person']));
  }
  const pending = pendingList(world, c);
  if (pending.length) {
    const from = pending.map((p) => world.citizens.get(p.from)).filter(Boolean);
    const labels = [...world.memory.labelsFor(c, from).keys()];
    if (labels.length) {
      tools.push(fn('refuse_treatment', 'Refuse what someone here is about to do to you (tending, looking you over, carrying you). They stop.', {
        from: { type: 'string', enum: labels, description: 'Whose help you refuse.' }, inner_thought: INNER_THOUGHT,
      }, ['from']));
      const carriers = pending.filter((p) => p.kind === 'carry').map((p) => world.citizens.get(p.from)).filter(Boolean);
      if (carriers.length) {
        tools.push(fn('accept_help', 'Let someone carry you.', {
          from: { type: 'string', enum: [...world.memory.labelsFor(c, carriers).keys()], description: 'Who carries you.' }, inner_thought: INNER_THOUGHT,
        }, ['from']));
      }
    }
  }
  if (c.carryingPerson) {
    tools.push(fn('put_down_person', 'Lay down the person you are carrying, here.', { inner_thought: INNER_THOUGHT }, []));
  } else if (!['sleeping', 'collapsed'].includes(c.activity.type) && O.handsOf(c.id) >= 2 && O.slotsUsed(c.id) === 0) {
    const carriable_ = present.filter((o) => carriable(world, c, o));
    if (carriable_.length) {
      tools.push(fn('carry_person', "Lift someone who can't walk and carry them. It takes both hands, twice as long, and wears you out twice as fast. If they are awake they have to agree.", {
        person: { type: 'string', enum: [...world.memory.labelsFor(c, carriable_).keys()], description: 'Who you carry.' }, inner_thought: INNER_THOUGHT,
      }, ['person']));
    }
  }
  if (WASH_OFFERED(world, c)) tools.push(fn('wash_clothes', 'Wash the blood out of your clothes here (a few minutes).', { inner_thought: INNER_THOUGHT }, []));

  // Parties (step 5.5): the only groups citizens can form themselves.
  const invitable = world.groups.invitable(c, awake);
  if (invitable.length) {
    const labels = [...world.memory.labelsFor(c, awake).entries()].filter(([, o]) => invitable.includes(o)).map(([l]) => l);
    tools.push(fn('propose_party', 'Ask people here to join you as a party for some purpose: to go somewhere together, to get something done. They can accept or decline.', {
      people: { type: 'array', items: { type: 'string', enum: labels }, description: 'Who you ask.' },
      purpose: { type: 'string', maxLength: LIMITS.actionMax, description: "What the party is for, in a few words, e.g. 'explore the old mine'." },
      inner_thought: INNER_THOUGHT,
    }, ['people', 'purpose']));
  }
  const invites = world.groups.invitations(c);
  if (invites.length) {
    const from = [...world.memory.labelsFor(c, invites.map((i) => world.citizens.get(i.from)).filter(Boolean)).keys()];
    tools.push(fn('accept_invitation', 'Accept an invitation to join someone as a party.', {
      from: { type: 'string', enum: from, description: 'Whose invitation.' }, inner_thought: INNER_THOUGHT,
    }, ['from']));
    tools.push(fn('decline_invitation', 'Turn down an invitation.', {
      from: { type: 'string', enum: from, description: 'Whose invitation.' },
      reason: { type: 'string', description: 'Optional. What you say to them, in your own words (one short sentence).' },
      inner_thought: INNER_THOUGHT,
    }, ['from']));
  }
  const parties = world.groups.of(c.id).filter((m) => m.group.kind === 'party');
  if (parties.length) {
    tools.push(fn('leave_group', `Leave your party: ${parties.map((m) => `"${m.group.id}" = ${m.group.name}`).join('; ')}.`, {
      group: { type: 'string', enum: parties.map((m) => m.group.id), description: 'Which one.' },
      farewell: { type: 'string', description: 'Optional. A few words to the others.' },
      inner_thought: INNER_THOUGHT,
    }, ['group']));
  }

  // plan tools: only while a plan is running
  if (planActive(c)) {
    tools.push(fn('continue_plan', 'Carry on with your plan for the day where you left off.', { inner_thought: INNER_THOUGHT }, []));
    tools.push(fn('revise_plan', `Replace the rest of your plan with new steps (up to ${PLAN_MAX_STEPS}). Same step kinds as when you planned: ${STEP_KINDS.join(', ')}.`, {
      steps: {
        type: 'array', maxItems: PLAN_MAX_STEPS,
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: STEP_KINDS },
            place: { type: 'string', enum: Object.keys(c.knownPlaces ?? {}) },
            person: { type: 'string', description: 'For visit / follow: the person, as you know them.' },
            description: { type: 'string' }, minutes: { type: 'integer', minimum: 1, maximum: 240 }, time: { type: 'string', description: 'HH:MM' }, note: { type: 'string' },
            thing: { type: 'string', description: 'For do, optional: the thing you will work on there.' },
          },
          required: ['kind'],
        },
      },
      inner_thought: INNER_THOUGHT,
    }, ['steps']));
    tools.push(fn('abandon_plan', 'Give up on your plan for today.', { inner_thought: INNER_THOUGHT }, []));
  }

  if (c.conversationId && world.conversations.get(c.conversationId)) {
    tools.push(fn('leave_conversation', 'End your part in the current conversation.', {
      farewell: { type: 'string', description: 'Optional. A few last words before you turn away (one short sentence).' },
      inner_thought: INNER_THOUGHT,
    }, []));
  }

  // Step 6: hide_feelings, when something strong is showing and someone could see it.
  const strong = world.emotions.of(c).filter((e) => e.intensity >= 5);
  if (strong.length && awake.length) {
    tools.push(fn('hide_feelings', 'Keep what you feel off your face for a while. It does not change the feeling, and people who know you well may still notice.', {
      emotion: { type: 'string', enum: [...new Set(strong.map((e) => e.type))], description: 'Optional. Which feeling; leave it out to hide them all.' },
      inner_thought: INNER_THOUGHT,
    }, []));
  }
  // Step 7A: every action may carry the optional `feeling` self-report (an object; the enums are per citizen).
  const feeling = feelingParam(world, c);
  for (const t of tools) t.function.parameters.properties.feeling = feeling;
  // Step 7A (sleep): still due to wake, but up already — sleep first, so the model sees it before acting.
  if (c.wokeEarly && world.now < c.wokeEarly.until) {
    const i = tools.findIndex((t) => t.function.name === 'sleep');
    if (i > 0) tools.unshift(...tools.splice(i, 1));
  }
  // Emotion-congruent tools first, short notes on descriptions. The SET of tools never changes with emotions.
  return frameTools(world, c, tools);
}

function fn(name, description, properties, required) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}


/**
 * Validate a tool call against the tools offered in this think.
 * Lenient where it's harmless (case-insensitive enums, numeric strings, clamping, truncation),
 * strict where the meaning would be guessed (unknown tool, missing field, value not in enum).
 * @returns {{ok: true, call: {name, arguments}} | {ok: false, error: string}}
 */
export function validateCall(tools, call) {
  const tool = tools.find((t) => t.function.name === call?.name);
  if (!tool) {
    return { ok: false, error: `Unknown action "${call?.name}". Available: ${tools.map((t) => t.function.name).join(', ')}.` };
  }
  const raw = call.arguments;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || '_raw' in raw) {
    return { ok: false, error: 'The arguments must be a JSON object.' };
  }
  const { properties, required } = tool.function.parameters;
  const args = {};
  const errors = [];
  const truncated = [];

  for (const [key, schema] of Object.entries(properties)) {
    let v = raw[key];
    if (v === undefined || v === null || v === '') {
      if (required.includes(key)) errors.push(`"${key}" is required.`);
      continue;
    }
    if (schema.type === 'integer') {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n)) {
        errors.push(`"${key}" must be a whole number.`);
        continue;
      }
      v = Math.min(schema.maximum ?? n, Math.max(schema.minimum ?? n, n));
    } else if (schema.type === 'array') {
      if (!Array.isArray(v)) {
        errors.push(`"${key}" must be a list.`);
        continue;
      }
    } else if (schema.type === 'boolean') {
      v = v === true || String(v).toLowerCase() === 'true';
    } else if (schema.type === 'string') {
      if (typeof v !== 'string') v = String(v);
      v = v.trim();
      if (schema.enum) {
        const match = schema.enum.find((e) => e.toLowerCase() === v.toLowerCase());
        if (!match) {
          errors.push(`"${key}" must be one of: ${schema.enum.join(', ')}.`);
          continue;
        }
        v = match;
      }
      // step 7A: `feeling` may be an object (or its JSON form) — parseFeeling clips its own why, so don't clip it here.
      const max = key === 'feeling' ? undefined : schema.maxLength ?? HIDDEN_MAX[tool.function.name]?.[key];
      if (max && v.length > max) {
        v = truncate(v, max);
        truncated.push(key);
      }
      if (!v) {
        if (required.includes(key)) errors.push(`"${key}" must not be empty.`);
        continue;
      }
    }
    args[key] = v;
  }
  if (errors.length) return { ok: false, error: `Invalid ${tool.function.name}: ${errors.join(' ')}` };
  return {
    ok: true,
    call: { name: tool.function.name, arguments: args, ...(truncated.length ? { truncated } : {}) },
  };
}

/**
 * Shorten speech that is over the limit without cutting mid-word:
 * prefer the last sentence end (. ! ?) within the limit, else the last space plus "—".
 */
export function truncate(s, max) {
  const window = s.slice(0, max);
  const sentenceEnds = [...window.matchAll(/[.!?…]["'”’)]*(?=\s|$)/g)].map((m) => m.index + m[0].length);
  const end = sentenceEnds.at(-1);
  if (end && end >= max * 0.3) return window.slice(0, end).trim();
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/, '')}—`;
}
