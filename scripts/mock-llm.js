// Fake OpenAI-compatible server for developing without the school GPU.
// - Without tools: returns a "thinking" block plus an in-character answer.
// - With tools: picks a random tool and generates valid arguments from its JSON schema
//   (enums → random value, strings → canned phrase, integers → value in range).
//   `say` is picked ~40% of the time when someone is present, so conversations happen.
//
// Usage: npm run mock-llm   (then LLM_BASE_URL=http://localhost:4000/v1)
// Env:   MOCK_PORT=4000  MOCK_DELAY_MS=400  MOCK_FAIL_RATE=0 (0–1, returns HTTP 500)
//        MOCK_INVALID_RATE=0 (0–1, returns a tool call with bad arguments, to test the retry path)
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

function chooseTool(tools, prompt = '', stimulus = '') {
  const byName = Object.fromEntries(tools.map((t) => [t.function.name, t]));
  const needy = chooseNeedTool(byName, prompt, stimulus);
  if (needy) return needy;
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
