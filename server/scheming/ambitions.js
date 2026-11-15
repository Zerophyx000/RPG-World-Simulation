// Step 11 §1: ambitions — what a citizen wants out of life, over weeks. Table `ambitions` (see migration 015).
//
//   generation   one `ambitions` call per citizen (light tier) once their traits exist: 1–3 ambitions from the persona,
//                job, relationships with reasons, core memory and habits; only real people (targets), and no invented
//                names in the text. 5.5 secret goals become secret ambitions (migration 016, or here for new seeds).
//   evolution    at sleep consolidation: ambition_changes (add at most one a night, update, achieve, abandon,
//                transform), each with a reason kept in data.history. Revenge is never automatic: the day's violence is
//                shown and the model decides from the persona.
//   in prompts   full tier: YOUR AMBITIONS (up to 3, secret ones marked); light: the strongest one; none: nothing.
//                Context, not orders.
import { chatForTool } from '../llm.js';
import { grievanceBlock, topGrievances } from './grievances.js';
import { relationLine } from '../social/describe.js';
import { J, clampInt, peopleFor } from './common.js';

export const KINDS = ['mastery', 'wealth', 'status', 'bond', 'protect', 'revenge', 'belonging', 'freedom', 'secret', 'other'];
export const SECRECY = ['open', 'private', 'secret'];
const MAX = () => Number(process.env.AMBITIONS_MAX ?? 3) || 3;
const RETRY_MINUTES = 180;
const ALLOWED_CAPS = new Set(['I', 'God', 'Gods', 'Lord', 'Lady', 'Sir', 'Master', 'Mistress', 'Mother', 'Father', 'Ma', 'Pa', 'My', 'The', 'A', 'An']);

export class Ambitions {
  constructor(world) {
    this.world = world;
    const db = world.db;
    this.busy = new Set();
    this.lastTry = new Map();
    this.q = {
      byCitizen: db.prepare('SELECT * FROM ambitions WHERE citizen_id = ? ORDER BY intensity DESC, id'),
      active: db.prepare("SELECT * FROM ambitions WHERE citizen_id = ? AND status = 'active' ORDER BY intensity DESC, id"),
      get: db.prepare('SELECT * FROM ambitions WHERE id = ?'),
      insert: db.prepare(`INSERT INTO ambitions (citizen_id, kind, text, target_ids, intensity, secrecy, status, origin, created_at, updated_at, data)
                          VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`),
      update: db.prepare('UPDATE ambitions SET kind = ?, text = ?, target_ids = ?, intensity = ?, secrecy = ?, status = ?, updated_at = ?, data = ? WHERE id = ?'),
      all: db.prepare('SELECT * FROM ambitions ORDER BY citizen_id, status, intensity DESC'),
    };
  }

  row(r) {
    return r ? { id: r.id, citizenId: r.citizen_id, kind: r.kind, text: r.text, targetIds: J(r.target_ids, []), intensity: r.intensity, secrecy: r.secrecy, status: r.status, origin: r.origin, createdAt: r.created_at, updatedAt: r.updated_at, data: J(r.data, {}) } : null;
  }

  get(id) { return this.row(this.q.get.get(id)); }
  of(citizenId, { all = false } = {}) { return (all ? this.q.byCitizen : this.q.active).all(citizenId).map((r) => this.row(r)); }
  allRows() { return this.q.all.all().map((r) => this.row(r)); }

  // ---------- writes (the only ones) ----------
  add(c, a, { origin = 'persona', why = null } = {}) {
    const w = this.world;
    if (this.of(c.id).length >= MAX()) return null;
    const kind = KINDS.includes(a.kind) ? a.kind : 'other';
    const text = String(a.text ?? '').trim().slice(0, 300);
    if (!text) return null;
    const data = { history: [{ at: w.now, op: 'add', why: why ?? null }], ...(a.data ?? {}) };
    const info = this.q.insert.run(c.id, kind, text, JSON.stringify(a.targetIds ?? []), clampInt(a.intensity, 1, 10, 5), SECRECY.includes(a.secrecy) ? a.secrecy : 'private', origin, w.now, w.now, JSON.stringify(data));
    const id = Number(info.lastInsertRowid);
    w.logEvent('ambition', { actorId: c.id, op: 'add', id, kind, text, intensity: clampInt(a.intensity, 1, 10, 5), secrecy: a.secrecy ?? 'private', origin, why });
    w.bus.emit('scheming', { what: 'ambition', citizenId: c.id });
    return this.get(id);
  }

  change(id, patch, { op, why }) {
    const w = this.world;
    const a = this.get(id);
    if (!a) return null;
    const next = { ...a, ...patch };
    next.data = { ...a.data, history: [...(a.data.history ?? []), { at: w.now, op, why: why ?? null, ...(patch.intensity != null ? { intensity: patch.intensity } : {}) }].slice(-20) };
    this.q.update.run(next.kind, next.text, JSON.stringify(next.targetIds ?? []), clampInt(next.intensity, 1, 10, 5), next.secrecy, next.status, w.now, JSON.stringify(next.data), id);
    w.logEvent('ambition', { actorId: a.citizenId, op, id, kind: next.kind, text: next.text, intensity: next.intensity, status: next.status, why });
    w.bus.emit('scheming', { what: 'ambition', citizenId: a.citizenId });
    return this.get(id);
  }

  // ---------- validation: only real people, no invented names ----------
  vocabulary() {
    const w = this.world;
    const words = new Set(ALLOWED_CAPS);
    const add = (s) => { for (const m of String(s ?? '').matchAll(/\b[A-Z][a-z']+/g)) words.add(m[0].replace(/'s$/, '')); };
    for (const o of w.citizens.values()) add(o.name);
    for (const r of w.rooms.values()) { add(r.name); add(r.description); }
    add(w.worldText);
    return words;
  }

  /** A model's ambition → a clean one, or null (with why). */
  normalize(c, a, labels) {
    if (!a || typeof a !== 'object') return { bad: 'not an object' };
    const text = String(a.text ?? '').trim().replace(/\s+/g, ' ').slice(0, 300);
    if (text.length < 8) return { bad: 'too short' };
    const targetIds = [];
    for (const t of Array.isArray(a.targets) ? a.targets : []) {
      const o = labels.get(t) ?? [...this.world.citizens.values()].find((x) => x.name.toLowerCase() === String(t).toLowerCase());
      if (!o) return { bad: `unknown person "${t}"` };
      if (o.id !== c.id) targetIds.push(o.id);
    }
    const vocab = this.vocabulary();
    for (const m of text.matchAll(/(?<![.!?]\s|^)\b([A-Z][a-z']{2,})\b/g)) {
      const word = m[1].replace(/'s$/, '');
      if (/^I'/.test(word)) continue; // I've, I'd, I'll, I'm
      if (!vocab.has(word)) return { bad: `names someone or somewhere that isn't here ("${word}")` };
    }
    return { kind: KINDS.includes(a.kind) ? a.kind : 'other', text, targetIds, intensity: clampInt(a.intensity, 1, 10, 5), secrecy: SECRECY.includes(a.secrecy) ? a.secrecy : 'private' };
  }

  // ---------- generation ----------
  needs(c) {
    if (!c.alive || c.kind !== 'citizen' || this.world.scheming?.traits.needs(c)) return false;
    return !c.ambitionsGenerated;
  }

  /** 5.5 secret goals still in a persona (a world seeded after migration 016) become secret ambitions. */
  moveSecretGoals(c) {
    const goals = (c.persona?.secretGoals ?? []).filter((g) => String(g ?? '').trim());
    if (!goals.length) return;
    for (const g of goals.slice(0, MAX())) this.add(c, { kind: 'secret', text: g, intensity: 6, secrecy: 'secret' }, { origin: 'migrated_secret_goal', why: 'a private aim from before' });
    c.persona.secretGoals = [];
    this.world.saveCitizen(c);
  }

  async generate(c) {
    const w = this.world;
    if (this.busy.has(c.id)) return;
    this.busy.add(c.id);
    this.lastTry.set(c.id, w.now);
    try {
      this.moveSecretGoals(c);
      const have = this.of(c.id);
      const room = MAX() - have.length;
      if (room <= 0) { c.ambitionsGenerated = true; w.saveCitizen(c); return; }
      const labels = peopleFor(w, c);
      const rels = [...labels.values()].slice(0, 8).map((o) => `- ${[...labels].find(([, x]) => x === o)?.[0]}: ${relationLine(w, c, o).text}`).join('\n');
      const user = [
        rels ? `# THE PEOPLE IN YOUR LIFE\n${rels}` : '',
        have.length ? `# WHAT YOU ALREADY WANT\n${have.map((a) => `- ${a.text}`).join('\n')}` : '',
        w.habits?.brief(c) ? `# YOUR DAYS\n${w.habits.brief(c)}` : '',
        `# WHAT NOW\nWhat do you want out of life, over the coming weeks? Give ${room === 1 ? 'one ambition' : `1 to ${room} ambitions`}, in your own voice (first person, one sentence each): mastery, wealth, status, a bond (winning or keeping someone), protecting someone or something, revenge, belonging, freedom, or something else. Name only people listed here (as targets) and only places from this village. Say how strongly you want it (1–10) and how secret it is: open (you talk about it), private (you don't bring it up), secret (you would deny it). Call set_ambitions once.`,
      ].filter(Boolean).join('\n\n');
      const tools = [{ type: 'function', function: { name: 'set_ambitions', description: 'What you want out of life.', parameters: { type: 'object', properties: {
        ambitions: { type: 'array', minItems: 1, maxItems: room, items: { type: 'object', properties: {
          kind: { type: 'string', enum: KINDS.filter((k) => k !== 'secret') }, text: { type: 'string' },
          targets: { type: 'array', items: { type: 'string', enum: labels.size ? [...labels.keys()] : ['nobody'] } },
          intensity: { type: 'integer', minimum: 1, maximum: 10 }, secrecy: { type: 'string', enum: SECRECY },
        }, required: ['kind', 'text', 'intensity', 'secrecy'] } },
      }, required: ['ambitions'] } } }];
      let list = null;
      try {
        const { authorSystemPrompt } = await import('./author.js'); // step 11.5 (A2)
        const r = await chatForTool(w.llm, { purpose: 'ambitions', tier: 'light', citizenId: c.id, tools, messages: [{ role: 'system', content: authorSystemPrompt(w, c) }, { role: 'user', content: `(Below, "you" is ${c.name}. Answer as ${c.name}, in ${c.name}'s own voice.)\n\n${user}` }] }, 'set_ambitions');
        list = r.toolCalls?.find((x) => x.name === 'set_ambitions')?.arguments?.ambitions;
      } catch (err) {
        if (err.code !== 'unavailable') w.logEvent('error', { actorId: c.id, message: `ambitions failed: ${String(err.message).slice(0, 160)}` });
        if (err.code === 'unavailable') return; // try again later, when a model is up
      }
      if (!c.alive || w.citizens.get(c.id) !== c) return;
      let added = 0;
      for (const a of (Array.isArray(list) ? list : []).slice(0, room)) {
        const n = this.normalize(c, { ...a, targets: (a.targets ?? []).filter((t) => t !== 'nobody') }, labels);
        if (n.bad) { w.logEvent('ambition_rejected', { actorId: c.id, text: String(a?.text ?? '').slice(0, 160), why: n.bad }); continue; }
        if (this.add(c, n, { origin: 'persona', why: 'who they are' })) added++;
      }
      c.ambitionsGenerated = true;
      c.needsAmbitions = false;
      w.saveCitizen(c);
    } finally {
      this.busy.delete(c.id);
    }
  }

  ensure() {
    const w = this.world;
    if (!w.clock.running) return;
    for (const c of w.citizens.values()) {
      if (!this.needs(c) || this.busy.has(c.id)) continue;
      if (this.busy.size >= 2) break;
      if (w.now - (this.lastTry.get(c.id) ?? -Infinity) < RETRY_MINUTES) continue;
      this.generate(c).catch(() => {});
    }
  }

  // ---------- prompt ----------
  promptBlock(c, tier) {
    if (tier === 'none') return null;
    const list = this.of(c.id);
    if (!list.length) return null;
    const shown = tier === 'full' ? list.slice(0, 3) : list.slice(0, 1);
    const line = (a) => `- ${this.world.memory.resolveNames(c, a.text)}${a.secrecy === 'secret' ? " (you'd never admit this)" : a.secrecy === 'private' ? ' (you keep this to yourself)' : ''}`;
    return `${shown.map(line).join('\n')}\nThese are what you want out of life. They colour what you notice and choose; they don't decide for you.`;
  }

  // ---------- evolution (consolidation) ----------
  consolidationBlock(c) {
    const w = this.world;
    const list = this.of(c.id);
    const since = c.lastConsolidatedAt ?? w.now - 1440;
    const done = (c.deeds ?? []).filter((d) => d.lastAt > since);
    // step 11.5 (A4): the worst grievances, as they happened (what was done, who saw, wounds still felt, what it cost)
    const grievances = topGrievances(w, c, { min: Number(process.env.GRIEVANCE_MIN ?? 5) || 5, limit: 2 }).map((g) => grievanceBlock(w, c, g.id, { heading: '# WHAT WAS DONE TO YOU' })).filter(Boolean);
    const lines = [];
    lines.push(list.length ? `# WHAT YOU WANT OUT OF LIFE\n${list.map((a) => `- [${a.id}] (${a.kind}, ${a.intensity}/10, ${a.secrecy}) ${w.memory.resolveNames(c, a.text)}`).join('\n')}` : '# WHAT YOU WANT OUT OF LIFE\n(nothing in particular yet)');
    const done2 = done.length ? w.memory.resolveNames(c, (w.physical?.consequences.deedLines({ ...c, deeds: done, discovery: null }) ?? []).join('\n')) : '';
    if (done2) lines.push(`# WHAT YOU DID TODAY\n${done2}`);
    lines.push(...grievances);
    return lines.join('\n\n');
  }

  changesSchema(c) {
    const labels = peopleFor(this.world, c);
    const ids = this.of(c.id).map((a) => a.id);
    const amb = { type: 'object', properties: { kind: { type: 'string', enum: KINDS.filter((k) => k !== 'secret') }, text: { type: 'string' }, targets: { type: 'array', items: { type: 'string', enum: labels.size ? [...labels.keys()] : ['nobody'] } }, intensity: { type: 'integer', minimum: 1, maximum: 10 }, secrecy: { type: 'string', enum: SECRECY } }, required: ['kind', 'text', 'intensity'] };
    const ref = ids.length ? { type: 'integer', enum: ids } : { type: 'integer' };
    return {
      type: 'object', description: 'Optional: how what you want out of life changed today (at most one new ambition). Each with why.',
      properties: {
        add: { type: 'array', maxItems: 1, items: { ...amb, properties: { ...amb.properties, why: { type: 'string' } } } },
        update: { type: 'array', items: { type: 'object', properties: { id: ref, intensity: { type: 'integer', minimum: 1, maximum: 10 }, note: { type: 'string' } }, required: ['id', 'note'] } },
        achieve: { type: 'array', items: { type: 'object', properties: { id: ref, why: { type: 'string' } }, required: ['id', 'why'] } },
        abandon: { type: 'array', items: { type: 'object', properties: { id: ref, why: { type: 'string' } }, required: ['id', 'why'] } },
        transform: { type: 'array', maxItems: 1, items: { type: 'object', properties: { id: ref, into: amb, why: { type: 'string' } }, required: ['id', 'into', 'why'] } },
      },
    };
  }

  applyChanges(c, ch) {
    const w = this.world;
    if (!ch || typeof ch !== 'object' || !c.alive) return [];
    const out = [];
    const mine = new Set(this.of(c.id).map((a) => a.id));
    const labels = peopleFor(w, c);
    for (const u of Array.isArray(ch.update) ? ch.update : []) {
      if (!mine.has(u.id)) continue;
      const r = this.change(u.id, { ...(u.intensity != null ? { intensity: clampInt(u.intensity, 1, 10, 5) } : {}) }, { op: 'update', why: String(u.note ?? '').slice(0, 200) });
      if (r) out.push({ op: 'update', id: u.id });
    }
    for (const [op, status] of [['achieve', 'achieved'], ['abandon', 'abandoned']]) {
      for (const u of Array.isArray(ch[op]) ? ch[op] : []) {
        if (!mine.has(u.id) || !String(u.why ?? '').trim()) continue;
        this.change(u.id, { status }, { op, why: String(u.why).slice(0, 200) });
        out.push({ op, id: u.id });
      }
    }
    for (const t of (Array.isArray(ch.transform) ? ch.transform : []).slice(0, 1)) {
      if (!mine.has(t.id) || !String(t.why ?? '').trim()) continue;
      const n = this.normalize(c, t.into, labels);
      if (n.bad) { w.logEvent('ambition_rejected', { actorId: c.id, text: String(t.into?.text ?? '').slice(0, 160), why: n.bad }); continue; }
      this.change(t.id, { status: 'transformed' }, { op: 'transform', why: String(t.why).slice(0, 200) });
      const added = this.add(c, n, { origin: 'consolidation', why: `${t.why} (it grew out of an older want)` });
      if (added) { this.change(added.id, { data: { ...added.data, from: t.id } }, { op: 'from', why: `transformed from #${t.id}` }); out.push({ op: 'transform', id: t.id, into: added.id }); }
    }
    for (const a of (Array.isArray(ch.add) ? ch.add : []).slice(0, 1)) {
      const n = this.normalize(c, a, labels);
      if (n.bad) { w.logEvent('ambition_rejected', { actorId: c.id, text: String(a?.text ?? '').slice(0, 160), why: n.bad }); continue; }
      const added = this.add(c, n, { origin: 'consolidation', why: String(a.why ?? '').slice(0, 200) || null });
      if (added) out.push({ op: 'add', id: added.id, intensity: added.intensity, kind: added.kind });
    }
    return out;
  }

  view(citizenId = null) {
    const list = citizenId ? this.of(citizenId, { all: true }) : this.allRows();
    return list.map((a) => ({ ...a, citizenName: this.world.citizens.get(a.citizenId)?.name ?? a.citizenId, targetNames: a.targetIds.map((id) => this.world.citizens.get(id)?.name ?? id) }));
  }
}
