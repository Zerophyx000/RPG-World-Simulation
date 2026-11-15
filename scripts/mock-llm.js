// Fake OpenAI-compatible server for developing without the school GPU.
// - Without tools: returns a "thinking" block plus an in-character answer.
// - With tools: picks a random tool and generates valid arguments from its JSON schema
//   (enums → random value, strings → canned phrase, integers → value in range).
//   `say` is picked ~40% of the time when someone is present, so conversations happen.
//
// Usage: npm run mock-llm   (then LLM_BASE_URL=http://localhost:4000/v1)
// Env:   MOCK_PORT=4000  MOCK_DELAY_MS=400  MOCK_FAIL_RATE=0 (0–1, returns HTTP 500)
//        MOCK_INVALID_RATE=0 (0–1, returns a tool call with bad arguments, to test the retry path)
// Step 11: set_traits / set_ambitions (real names from the target enum) / plan_scheme (a plan about half the time) /
// judge (leak check) get shaped answers; in decisions the optional step-11 fields are filled on purpose, not at random:
// say + deceive with a check (~12%), confide asking to join, confess, proposal answers, trust_claim, scheme updates.
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 4000);
const DELAY_MS = Number(process.env.MOCK_DELAY_MS ?? 400);
const FAIL_RATE = Number(process.env.MOCK_FAIL_RATE ?? 0);
const INVALID_RATE = Number(process.env.MOCK_INVALID_RATE ?? 0);

const PHRASES = {
  text: [
    'Morning. Cold one today.',
    'What do you want?',
    "I've heard things, you know.",
    "Don't look at me like that.",
    'Has anyone seen the miller this week?',
    "I'm not in the mood for talk.",
    'You still owe me, and you know it.',
    'Bread was dear again at the market.',
  ],
  farewell: ['I have work to do.', 'We are done here.', 'Another time.'],
  action: ['wiping the counter', 'kneading dough', 'sweeping the floor', 'mending a strap', 'staring into the fire', 'counting coins'],
  reason: ['for things to calm down', 'to see who comes by', 'for the dough to rise', 'nothing in particular'],
  inner_thought: ['Better keep my head down.', 'Something is off today.', 'I could use a drink.', 'Why does everyone stare?'],
  // observer / director helper tools
  headline: ['The village argues about debts while the flour keeps vanishing.', 'A quiet morning with old grudges simmering.'],
  label: ['owes money', 'old friends', 'suspicious of', 'protective of'],
  note: ['They argued about it in the tavern.', 'Shared a quiet word at the well.'],
  id: ['flour-theft', 'unpaid-bread', 'old-war'],
  title: ['The missing flour', 'The unpaid bread', 'Old war stories'],
  summary: ['Something is going on and people are starting to notice.'],
  near: ['A loud noise comes from nearby.'],
  // step 4: plans, memory
  time: ['10:00', '12:30', '17:00', '19:00'],
  description: ['tidying up', 'mending a strap', 'sweeping the floor', 'counting stock'],
  note: ['see how things stand', 'ask about work', 'have a word'],
  core_memory: ['I am trying to make a place for myself here. Some people are kind, some are not, and I keep my eyes open.'],
  addition: ['Just arrived.', 'I mend things.'],
  comment: ['Tell them I sent you.'],
  gist: ['They talked about bread and the weather.'],
  person: ['nobody'],
  far: ['Something faint happens far away.'],
  // step 5.5: parties; step 6: feelings
  purpose: ['look around the old mine', 'fetch water together', 'keep an eye on the square'],
  why: ['It stung more than I expected.', 'That was kind of them.', 'I do not like how this is going.'],
  feeling: ['anger +1: nothing goes right today', 'joy +1: a quiet moment to myself', 'sadness +1: the day drags', 'fear +1: something feels off', 'pride +1: a job done well', 'anger -1: it is not worth it'],
  cause: ['It stung more than I expected.'],
  default: ['hmm'],
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function genValue(key, schema) {
  if (schema.enum) return pick(schema.enum);
  if (schema.type === 'integer' || schema.type === 'number') {
    const min = schema.minimum ?? 1;
    const max = Math.min(schema.maximum ?? 30, min + 29); // keep mock activities short
    return min + Math.floor(Math.random() * (max - min + 1));
  }
  if (schema.type === 'boolean') return Math.random() < 0.5;
  if (schema.type === 'array') {
    const n = 1 + Math.floor(Math.random() * 2);
    return Array.from({ length: n }, () => genValue(key, schema.items ?? { type: 'string' }));
  }
  if (schema.type === 'object') return genObject(schema);
  return pick(PHRASES[key] ?? PHRASES.default);
}

function genObject(schema) {
  const { properties = {}, required = [] } = schema;
  const out = {};
  for (const [k, sch] of Object.entries(properties)) {
    if (required.includes(k) || Math.random() < 0.7) out[k] = genValue(k, sch);
  }
  return out;
}

function genArgs(tool) {
  const { properties = {}, required = [] } = tool.function.parameters ?? {};
  const args = {};
  for (const [key, schema] of Object.entries(properties)) {
    if (key === 'feeling' && Math.random() > 0.2) continue; // step 6: only now and then a self-report
    if (required.includes(key) || Math.random() < 0.7) args[key] = genValue(key, schema);
  }
  return args;
}

// Need-aware choices (step 3) so the hunger → asking → learning → eating loop runs without GLM.
function chooseNeedTool(byName, prompt, stimulus) {
  const enumOf = (tool, key) => tool?.function.parameters?.properties?.[key]?.enum ?? [];
  const preferFood = (ids) => ids.find((id) => /tavern|bakery/.test(id)) ?? pick(ids);
  const urgent = /^Above all, you are/m.test(prompt);
  const hungry = /You're (hungry|starving|ravenous|faint with hunger)/.test(prompt) || urgent;
  if (urgent && byName.eat && Math.random() < 0.8) return { tool: byName.eat, args: {} };
  if (hungry && byName.eat && Math.random() < 0.6) return { tool: byName.eat, args: {} };
  // asked a question by someone → explain a place
  const asker = /^- \([^)]*\) (\w+) says to you: ".*\?"$/.exec(stimulus)?.[1];
  if (byName.tell_about_place && asker && enumOf(byName.tell_about_place, 'to').includes(asker) && Math.random() < 0.7) {
    return { tool: byName.tell_about_place, args: { to: asker, place: preferFood(enumOf(byName.tell_about_place, 'place')), comment: 'Tell them I sent you.' } };
  }
  if (/You don't know where to find food/.test(prompt) && enumOf(byName.say, 'to').length && Math.random() < 0.6) {
    return { tool: byName.say, args: { to: pick(enumOf(byName.say, 'to')), text: 'Do you know where I can get something to eat?' } };
  }
  if (hungry && byName.travel_to && Math.random() < 0.5) {
    return { tool: byName.travel_to, args: { destination: preferFood(enumOf(byName.travel_to, 'destination')) } };
  }
  if (/You're (?:[\w ]+ and )?(tired|exhausted|barely able to stay awake)/.test(prompt) && byName.sleep && Math.random() < 0.6) {
    return { tool: byName.sleep, args: { until_rested: true } };
  }
  return null;
}

// ---- step 11 ----
const firstName = (label) => (/^[A-Z][a-z]+/.exec(String(label ?? ''))?.[0] ?? null);
function step11Helper(tool) {
  const p = tool.function.parameters?.properties ?? {};
  switch (tool.function.name) {
    case 'set_traits': return { honesty: 2 + Math.floor(Math.random() * 8), cunning: 1 + Math.floor(Math.random() * 9), reason: pick(['Plain-spoken, hides nothing.', 'Keeps their cards close.', 'Says what suits them.']) };
    case 'set_ambitions': {
      const item = p.ambitions.items.properties;
      const people = (item.targets?.items?.enum ?? []).filter((x) => x !== 'nobody');
      const max = Math.max(1, Math.min(p.ambitions.maxItems ?? 2, 2));
      return { ambitions: Array.from({ length: 1 + Math.floor(Math.random() * max) }, () => {
        const t = people.length && Math.random() < 0.6 ? pick(people) : null;
        const name = firstName(t);
        const [kind, text] = name ? pick([['revenge', `I want ${name} to pay for how I was treated.`], ['bond', `I want ${name} to think well of me.`], ['status', `I want to be thought more of than ${name}.`], ['protect', `I want to keep ${name} safe.`]])
          : pick([['mastery', 'I want to be the best at my trade in this village.'], ['wealth', 'I want to put enough coin aside for a hard winter.'], ['belonging', 'I want people here to count me as one of them.'], ['freedom', 'I want to answer to nobody.']]);
        return { kind, text, ...(name ? { targets: [t] } : {}), intensity: 3 + Math.floor(Math.random() * 8), secrecy: pick(['open', 'private', 'secret']) };
      }) };
    }
    case 'plan_scheme': {
      if (Math.random() < 0.5) return { no_plan: true, why_not: pick(['Better to wait and see.', 'It is not worth the risk yet.']) };
      const sp = p.steps.items.properties;
      const people = (p.targets?.items?.enum ?? []).filter((x) => x !== 'nobody');
      const target = people.length ? pick(people) : null;
      const places = (sp.at_place?.enum ?? []).filter((x) => x !== 'nowhere');
      const types = sp.object_type?.enum ?? [];
      const steps = [
        { text: 'Find out when they are away from home', kind: 'talk', ...(target ? { with: [target] } : {}) },
        ...(types.length && Math.random() < 0.5 ? [{ text: 'Get hold of what I need', kind: 'obtain', object_type: pick(types) }] : []),
        { text: 'Go there when nobody is about', kind: 'go', ...(places.length ? { at_place: pick(places) } : {}), not_before: pick(['+1h', '+2h', '21:00']) },
        { text: 'Do it, and be home before anyone notices', kind: 'act', ...(target ? { absent: [target] } : {}) },
      ];
      const others = people.filter((x) => x !== target);
      return { goal: target ? `Make ${firstName(target) ?? 'them'} sorry, without anyone knowing it was me.` : 'Get ahead without anyone noticing.', ...(target ? { targets: [target] } : {}), steps, ...(others.length && Math.random() < 0.4 ? { recruit: [pick(others)] } : {}), risks: 'Someone could see me on the way.' };
    }
    case 'judge': return Math.random() < 0.7 ? { leaked: 'none' } : { leaked: pick(['hint', 'full']), which: 1, what: 'they let something slip' };
    default: return null;
  }
}
const STEP11_KEYS = ['deceive', 'confide', 'confess', 'scheme', 'proposal', 'trust_claim'];
/** Fill the optional step-11 fields deliberately (genArgs alone would put a lie in 70% of lines). */
function step11Fields(tool, args) {
  const p = tool.function.parameters?.properties ?? {};
  for (const k of STEP11_KEYS) delete args[k];
  const name = tool.function.name;
  if (name === 'say' && p.deceive) {
    if (p.confess && Math.random() < 0.1) { args.confess = pick(p.confess.enum); args.text = "I wasn't honest with you before. I'm sorry."; }
    else if (p.confide && Math.random() < 0.3) { args.confide = { scheme: pick(p.confide.properties.scheme.enum), reveal: pick(['partial', 'full']), ask: pick(['join', 'join', 'keep_quiet']) }; args.text = 'I have a plan. Keep this between us. Will you help?'; }
    else if (Math.random() < 0.12) {
      const who = Math.random() < 0.5 ? 'me' : (firstName(args.to) ?? 'me');
      const where = pick(['at home', 'at the tavern', 'at the bakery']);
      const when = pick(['last night', 'this morning']);
      args.text = who === 'me' ? `I was ${where} ${when}, ask anyone.` : `${who} was ${where} ${when}, I saw them.`;
      args.deceive = { truth: 'I was somewhere else entirely.', kind: who === 'me' ? 'self' : 'cover', why: 'Nobody needs to know.', check: { who, where, when } };
    }
  }
  if (['put', 'give', 'handle'].includes(name) && p.deceive && Math.random() < 0.05) args.deceive = { truth: 'I want it to look like someone else did this.', kind: 'frame', why: 'To turn them against each other.' };
  if (p.proposal && Math.random() < 0.7) args.proposal = { scheme: pick(p.proposal.properties.scheme.enum), answer: pick(['join', 'refuse', 'think_about_it']), reason: 'I need to think about what it costs me.' };
  if (p.trust_claim && Math.random() < 0.5) args.trust_claim = { from: pick(p.trust_claim.properties.from.enum), verdict: pick(['believe', 'believe', 'doubt', 'disbelieve']), why: 'That does not square with what I saw.' };
  if (p.scheme && Math.random() < 0.25) {
    const s = p.scheme.properties;
    const r = Math.random();
    args.scheme = { id: pick(s.id.enum), reason: 'It went as I meant it to.' };
    if (s.step && r < 0.7) Object.assign(args.scheme, { step: s.step.enum[0], outcome: 'done' });
    else if (s.step && r < 0.85) Object.assign(args.scheme, { step: s.step.enum[0], outcome: 'failed', reason: 'Someone was there.' });
    else if (r < 0.95) Object.assign(args.scheme, { status: 'pause', reason: 'Too many eyes on me right now.' });
    else Object.assign(args.scheme, { status: 'abandon', reason: 'It is not worth it any more.' });
  }
  return args;
}

function chooseTool(tools, prompt = '', stimulus = '') {
  const byName = Object.fromEntries(tools.map((t) => [t.function.name, t]));
  if (tools.length === 1) { const a = step11Helper(tools[0]); if (a) return { tool: tools[0], args: a }; }
  const r = chooseTool10(tools, byName, prompt, stimulus);
  return { tool: r.tool, args: step11Fields(r.tool, r.args) };
}

function chooseTool10(tools, byName, prompt, stimulus) {
  const needy = chooseNeedTool(byName, prompt, stimulus);
  if (needy) return needy;
  // Step 7B: tend the hurt (mostly sensible, sometimes a wrong method to exercise the "does nothing" feedback)
  if (byName.treat && Math.random() < 0.6) {
    const tool = byName.treat;
    const args = genArgs(tool);
    const methods = tool.function.parameters.properties.method?.enum ?? [];
    if (Math.random() < 0.75) {
      args.method = ['tourniquet', 'bandage', 'pack_wound', 'stitch', 'wrap_with_cloth', 'apply_pressure', 'splint', 'set_bone', 'rinse', 'herbal_remedy', 'keep_still'].find((m) => methods.includes(m)) ?? args.method;
    }
    return { tool, args };
  }
  // Step 10: physical acts. Prone → get up; held or tied → struggle or give up; afraid → dodge, yield or flee;
  // angry (anger >= 6 shows as "your jaw is clenched" / "fury" wording) → go at someone; now and then a reversal with a reason.
  if (byName.get_up && Math.random() < 0.7) return { tool: byName.get_up, args: {} };
  const act = byName.act_on;
  const acts = act?.function.parameters.properties.action.enum ?? [];
  const actArgs = (action, extra = {}) => ({ person: pick(act.function.parameters.properties.person.enum), action, ...extra });
  if (act && acts.includes('break_free') && Math.random() < 0.7) return { tool: act, args: actArgs(pick(['break_free', 'break_free', 'plead', 'yield'].filter((a) => acts.includes(a)))) };
  if (act && /ALTERCATION/.test(prompt)) {
    const afraid = /afraid|fear|terrif|panic|heart is racing/i.test(prompt);
    if (afraid && Math.random() < 0.5) {
      const flee = byName.move_to;
      if (flee && Math.random() < 0.4) return { tool: flee, args: genArgs(flee) };
      const d = ['dodge', 'block', 'yield', 'plead'].filter((a) => acts.includes(a));
      if (d.length) return { tool: act, args: actArgs(pick(d)) };
    }
    const hit = ['shove', 'punch', 'kick', 'grab', 'strike', 'slap'].filter((a) => acts.includes(a));
    if (hit.length && Math.random() < 0.6) return { tool: act, args: actArgs(pick(hit), { intent: pick(['scare', 'subdue', 'hurt', 'hurt']), ...(acts.includes('strike') && Math.random() < 0.5 ? { action: 'strike', with: pick(act.function.parameters.properties.with.enum) } : {}) }) };
    if (Math.random() < 0.15) {
      const care = ['help_up', 'comfort', 'embrace'].filter((a) => acts.includes(a));
      if (care.length) return { tool: act, args: actArgs(pick(care), { reason: "I didn't mean for it to go this far.", intent: 'care' }) };
    }
  }
  if (act && /anger|furious|fury|jaw is (tight|clenched)|blood is up/i.test(prompt) && Math.random() < 0.12) {
    const hit = ['shove', 'punch', 'slap', 'grab'].filter((a) => acts.includes(a));
    if (hit.length) return { tool: act, args: actArgs(pick(hit), { intent: pick(['scare', 'hurt']), words: 'Enough!' }) };
  }
  if (act && Math.random() < 0.04) {
    const kind = ['embrace', 'comfort', 'hold_hand'].filter((a) => acts.includes(a));
    if (kind.length) return { tool: act, args: actArgs(pick(kind), { intent: 'care' }) };
  }
  if (byName.handle && Math.random() < (/Fire!|on fire|Smoke/i.test(prompt + stimulus) ? 0.8 : 0.06)) {
    const h = byName.handle;
    const args = genArgs(h);
    const allowed = h.function.parameters.properties.action.enum;
    if (/Fire!|on fire|Smoke/i.test(prompt + stimulus)) args.action = ['pour', 'smother', 'fill', 'push'].find((a) => allowed.includes(a)) ?? args.action;
    else args.action = pick(allowed.filter((a) => ['throw', 'push', 'pour', 'open', 'close', 'light', 'douse', 'sit_on', 'bar', 'ignite'].includes(a))) ?? args.action;
    delete args.target;
    return { tool: h, args };
  }
  if (byName.force_door && Math.random() < 0.3) return { tool: byName.force_door, args: genArgs(byName.force_door) };
  if (byName.refuse_treatment && Math.random() < 0.25) return { tool: byName.refuse_treatment, args: genArgs(byName.refuse_treatment) };
  if (byName.accept_help && Math.random() < 0.6) return { tool: byName.accept_help, args: genArgs(byName.accept_help) };
  if (byName.examine_person && Math.random() < 0.5) return { tool: byName.examine_person, args: genArgs(byName.examine_person) };
  if (byName.carry_person && Math.random() < 0.4) return { tool: byName.carry_person, args: genArgs(byName.carry_person) };
  if (byName.put_down_person && Math.random() < 0.5) return { tool: byName.put_down_person, args: genArgs(byName.put_down_person) };
  if (byName.wash_clothes && Math.random() < 0.5) return { tool: byName.wash_clothes, args: genArgs(byName.wash_clothes) };
  const say = byName.say;
  if (say?.function.parameters?.properties?.to && Math.random() < 0.4) {
    const args = genArgs(say);
    args.to = pick(say.function.parameters.properties.to.enum);
    return { tool: say, args };
  }
  if (byName.leave_conversation && Math.random() < 0.15) {
    return { tool: byName.leave_conversation, args: genArgs(byName.leave_conversation) };
  }
  // Step 5: now and then handle the things in the room (enum values are always valid handles).
  const objectTools = ['examine', 'search', 'take', 'put', 'use', 'give'].filter((n) => byName[n]);
  if (objectTools.length && Math.random() < 0.3) {
    const tool = byName[pick(objectTools)];
    const args = genArgs(tool);
    if (tool.function.name === 'use') args.intent = pick(['light it', 'open it', 'close it', 'clean it', 'fill it', 'tear it']);
    return { tool, args };
  }
  const tool = pick(tools);
  return { tool, args: genArgs(tool) };
}

// Step 5 keeper: accept with the first allowed transition; conceal behind the first offered anchor.
function keeperAnswer(js, messages) {
  const user = String(messages.find((m) => m.role === 'user')?.content ?? '');
  if (js.name === 'keeper_conceal') {
    const ids = js.schema?.properties?.of?.enum ?? [];
    return { relation: 'behind', of: ids[0] ?? '', visibility: 'hidden', searchDifficulty: 4, clue: '', perceivedText: '{actor} pushes something out of sight.' };
  }
  const allowed = /Allowed changes from "[^"]*": ([^\n]*)/.exec(user)?.[1] ?? '';
  const first = /"([^"]+)"/.exec(allowed)?.[1] ?? null;
  if (!first) return { accept: false, newState: 'none', surfaceText: '', perceivedText: '', rejectText: 'Nothing about it can change that way.' };
  return { accept: true, newState: first, surfaceText: '', perceivedText: '{actor} works at it for a moment.', rejectText: '' };
}

// The last line of the "WHAT JUST HAPPENED" block in the user prompt.
function lastStimulus(messages) {
  const user = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const block = String(user).split('# WHAT JUST HAPPENED')[1]?.split('\n# ')[0] ?? '';
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? String(user).slice(-80);
}

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model' }] }));
    return;
  }
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }
    const { messages = [], tools = [], response_format: rf } = parsed;
    const stimulus = lastStimulus(messages);
    const message = {
      role: 'assistant',
      reasoning_content: `(mock thinking) The last thing I noticed: ${stimulus.slice(0, 160)}. Weighing who I am and who is in front of me...`,
      content: '(mock) I hesitate, then decide based on how I feel right now.',
    };
    if (rf?.type === 'json_schema' && !tools.length && /^keeper_/.test(rf.json_schema?.name ?? '')) {
      message.content = JSON.stringify(keeperAnswer(rf.json_schema, messages));
      delete message.reasoning_content;
    } else if (rf?.type === 'json_schema' && !tools.length) {
      const sch = rf.json_schema?.schema ?? {};
      const out = genObject({ ...sch, required: Object.keys(sch.properties ?? {}) });
      if ('significance' in out) out.significance = 1 + Math.floor(Math.random() * 10);
      message.content = JSON.stringify(out);
      delete message.reasoning_content;
    } else if (tools.length) {
      const prompt = String([...messages].reverse().find((m) => m.role === 'user')?.content ?? '');
      let { tool, args } = chooseTool(tools, prompt, stimulus);
      if (Math.random() < INVALID_RATE) args = { ...args, destination: 'the moon', minutes: 'soon', to: 'Nobody' };
      message.content = null;
      message.tool_calls = [{
        id: `call_mock_${Date.now().toString(36)}`,
        type: 'function',
        function: { name: tool.function.name, arguments: JSON.stringify(args) },
      }];
    }

    const timer = setTimeout(() => {
      if (Math.random() < FAIL_RATE) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'mock failure' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        id: 'mock', object: 'chat.completion', model: 'mock',
        choices: [{ index: 0, message, finish_reason: tools.length ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      }));
    }, DELAY_MS);
    res.on('close', () => { if (!res.writableEnded) clearTimeout(timer); }); // client aborted
  });
}).listen(PORT, () => console.log(`[mock-llm] http://localhost:${PORT}/v1  delay=${DELAY_MS}ms fail=${FAIL_RATE} invalid=${INVALID_RATE}`));
