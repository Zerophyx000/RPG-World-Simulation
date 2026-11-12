// Bootstrapping memories for citizens that have none (live worlds from before step 4), and
// seeding memories/relationships from scenario files.
import { systemPrompt } from '../agents/prompt.js';
import { chatForTool } from '../llm.js';

/** Scenario seeds: memories, relationships, coreMemory on citizens.json entries. */
export function seedFromScenario(world, inputs) {
  const mem = world.memory;
  for (const input of inputs) {
    const c = world.citizens.get(input.id);
    if (!c) continue;
    if (input.coreMemory) c.coreMemory = String(input.coreMemory);
    for (const m of Array.isArray(input.memories) ? input.memories : []) {
      if (!m?.text) continue;
      mem.add(c.id, {
        kind: 'seed', text: m.text, importance: m.importance ?? 5,
        about: (m.about ?? []).filter((id) => world.citizens.has(id)),
        gameTime: world.now - (Number(m.daysAgo) || 0) * 1440, source: { seeded: true },
      });
    }
    for (const r of Array.isArray(input.relationships) ? input.relationships : []) {
      if (!world.citizens.has(r.to)) continue;
      mem.upsertRel(c.id, r.to, {
        affinity: r.affinity ?? 0, trust: r.trust ?? 0, familiarity: r.familiarity ?? 3,
        nameKnown: r.nameKnown !== false, nameConfidence: r.nameKnown === false ? 0 : 1, summary: r.summary ?? null,
      });
    }
    world.saveCitizen(c);
  }
}

/**
 * A pre-step-4 village: everyone has lived alongside everyone. If no relationship rows exist at all,
 * give each pair of locals a plain "we know each other" row so names don't vanish before bootstrap.
 */
export function ensureVillageAcquaintance(world) {
  if (world.memory.rels.size > 0) return 0;
  const locals = [...world.citizens.values()].filter((c) => c.alive && Object.values(c.knownPlaces ?? {}).some((k) => k.source === 'local' || k.source === 'home'));
  let n = 0;
  for (const a of locals) {
    for (const b of locals) {
      if (a === b) continue;
      world.memory.upsertRel(a.id, b.id, { familiarity: 6, nameKnown: true, nameConfidence: 1 });
      n++;
    }
  }
  return n;
}

/** POST /api/director/bootstrap-memories: one LLM call per citizen without memories. Resolves when all are done. */
export async function bootstrap(world, citizenIds = null) {
  const targets = [...world.citizens.values()].filter((c) => c.alive && c.kind === 'citizen'
    && (!citizenIds?.length || citizenIds.includes(c.id))
    && world.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE citizen_id = ?').get(c.id).n === 0);
  const results = await Promise.all(targets.map((c) => bootstrapOne(world, c).then(
    (r) => ({ id: c.id, ok: true, ...r }),
    (err) => ({ id: c.id, ok: false, error: err.message }),
  )));
  world.logEvent('system', { action: 'bootstrap_memories', results });
  return results;
}

async function bootstrapOne(world, c) {
  const others = [...world.citizens.values()].filter((o) => o !== c && o.alive && o.kind === 'citizen');
  const local = Object.values(c.knownPlaces ?? {}).some((k) => k.source === 'local' || k.source === 'home');
  const people = others.map((o) => `- ${o.id}: ${o.name}, ${o.persona.occupation ?? 'unknown occupation'}${Object.values(o.knownPlaces ?? {}).some((k) => k.source === 'local') ? '' : ' (a newcomer)'}`).join('\n');
  const places = Object.keys(c.knownPlaces ?? {}).map((id) => world.rooms.get(id)?.name).filter(Boolean).join(', ');
  const ids = others.map((o) => o.id);
  const user = [
    `# OTHER PEOPLE IN THE WORLD\n${people || '(nobody)'}`,
    `# PLACES YOU KNOW\n${places || '(none)'}`,
    `# WHAT NOW\nBefore today begins, recall your life so far. Write your core memory (first person, at most 250 words: who you are, what matters, your people, what you are working towards) and 5 to 10 memories from your past, in your own words, consistent with your story. Then say how you see the people your story gives you a reason to know.${local
      ? ' You have lived in this small village a long time: you know the names of the locals you have lived alongside.'
      : ' You are new here: you know nobody yet.'} Do not invent other people or places. Call recall_your_life exactly once.`,
  ].join('\n\n');
  const tools = [{
    type: 'function',
    function: {
      name: 'recall_your_life',
      description: 'Your core memory, a few memories and how you see people.',
      parameters: {
        type: 'object',
        properties: {
          core_memory: { type: 'string' },
          memories: {
            type: 'array', minItems: 3, maxItems: 10,
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'First person, one or two sentences.' },
                importance: { type: 'integer', minimum: 1, maximum: 10 },
                about: { type: 'array', items: { type: 'string', enum: ids.length ? ids : ['nobody'] } },
                days_ago: { type: 'integer', minimum: 0, maximum: 20000 },
              },
              required: ['text', 'importance', 'days_ago'],
            },
          },
          relationships: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                person: { type: 'string', enum: ids.length ? ids : ['nobody'] },
                affinity: { type: 'integer', minimum: -5, maximum: 5 },
                trust: { type: 'integer', minimum: -5, maximum: 5, description: 'How far you trust them (separate from liking: you can like someone you would not lend a penny).' },
                familiarity: { type: 'integer', minimum: 0, maximum: 10 },
                knows_name: { type: 'boolean' },
                summary: { type: 'string', description: 'One or two sentences, your words.' },
              },
              required: ['person', 'affinity', 'trust', 'familiarity', 'knows_name', 'summary'],
            },
          },
        },
        required: ['core_memory', 'memories', 'relationships'],
      },
    },
  }];
  const r = await chatForTool(world.llm, {
    purpose: 'bootstrap', tier: 'full', citizenId: c.id, tools,
    messages: [{ role: 'system', content: systemPrompt(world, c) }, { role: 'user', content: user }],
  }, 'recall_your_life');
  const a = r.toolCalls?.find((t) => t.name === 'recall_your_life')?.arguments;
  if (!a || '_raw' in a) throw new Error('no usable answer');
  if (a.core_memory) c.coreMemory = String(a.core_memory).trim().slice(0, 1800);
  let mems = 0;
  for (const m of Array.isArray(a.memories) ? a.memories.slice(0, 10) : []) {
    if (!m?.text) continue;
    world.memory.add(c.id, {
      kind: 'seed', text: String(m.text).trim(), importance: Math.min(10, Math.max(1, Math.round(Number(m.importance) || 4))),
      about: (Array.isArray(m.about) ? m.about : []).filter((id) => world.citizens.has(id) && id !== c.id),
      gameTime: world.now - (Number(m.days_ago) || 0) * 1440, source: { bootstrap: true },
    });
    mems++;
  }
  let rels = 0;
  for (const rr of Array.isArray(a.relationships) ? a.relationships : []) {
    if (!world.citizens.has(rr?.person) || rr.person === c.id) continue;
    world.memory.upsertRel(c.id, rr.person, {
      // GLM sometimes omits trust despite the schema: then derive a rough value from how much they like them
      affinity: Number(rr.affinity) || 0, trust: rr.trust != null && rr.trust !== '' ? Number(rr.trust) || 0 : Math.round((Number(rr.affinity) || 0) * 0.6), familiarity: Number(rr.familiarity) || 0,
      nameKnown: Boolean(rr.knows_name), nameConfidence: rr.knows_name ? 1 : 0, summary: rr.summary ? String(rr.summary).trim() : null,
    });
    rels++;
  }
  world.saveCitizen(c);
  return { memories: mems, relationships: rels };
}
