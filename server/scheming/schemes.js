// Step 11 §2: schemes — a concrete secret plan toward an ambition, across days. Table `schemes` (migration 015).
//
//   planning   a `scheme` call (full tier) ONLY at reflection (an ambition >= SCHEME_MIN_INTENSITY with no scheme
//              serving it) or at sleep consolidation (a new ambition >= that); at most SCHEME_PLAN_PER_DAY per citizen
//              per game day; "no scheme" is a fine answer. Steps may only use real places, people and object types
//              (enums); invalid steps are dropped; a scheme without a valid step is discarded.
//   due steps  code checks only structured `when` fields (after, at_place, with, absent, not_before, not_after) and
//              tells the owner (YOUR PLAN; the first decision with a newly due step is full, reason scheme_step). Code
//              NEVER performs a step: the owner reports it in the decision's `scheme` field (done / failed / revise one
//              step / pause / abandon, with a reason).
//   accomplices `confide` on say → everyone who heard is exposed; the one asked gets a proposal (join / refuse /
//              think_about_it, full tier, reason proposal). Commitment is recomputed at each of their reflections;
//              below 3 they waver (doubts in their prompt); telling the target or anyone else is betrayal.
//   exposure   a memory with its source and a relationship event, never a hidden flag; the scheme is `exposed` once its
//              target knows. The owner learns this only through what they perceive.
import { chatForTool } from '../llm.js';
import { citizensIn } from '../world/rooms.js';
import { ref } from '../memory/index.js';
import { J, clampInt, peopleFor, parseTimeRef, trait } from './common.js';

export const STEP_KINDS = ['talk', 'obtain', 'go', 'act', 'deceive', 'recruit', 'wait', 'other'];
const ACTIVE = ['planning', 'active', 'paused'];
const env = (k, d) => Number(process.env[k] ?? d) || d;
const MAX_ACTIVE = () => env('SCHEME_MAX_ACTIVE', 2);
const PER_DAY = () => env('SCHEME_PLAN_PER_DAY', 1);
const MIN_INTENSITY = () => env('SCHEME_MIN_INTENSITY', 6);
const DUE_FADE = 120;
const PROPOSAL_MINUTES = 1440;

export class Schemes {
  constructor(world) {
    this.world = world;
    const db = world.db;
    this.busy = new Set();
    this.lastDue = -Infinity;
    this.q = {
      insert: db.prepare(`INSERT INTO schemes (owner_id, ambition_id, goal, target_ids, status, steps, accomplices, exposed_to, created_at, updated_at, data)
                          VALUES (?, ?, ?, ?, 'active', ?, '[]', '[]', ?, ?, ?)`),
      get: db.prepare('SELECT * FROM schemes WHERE id = ?'),
      save: db.prepare('UPDATE schemes SET goal = ?, target_ids = ?, status = ?, steps = ?, accomplices = ?, exposed_to = ?, updated_at = ?, data = ? WHERE id = ?'),
      byOwner: db.prepare('SELECT * FROM schemes WHERE owner_id = ? ORDER BY id DESC'),
      live: db.prepare("SELECT * FROM schemes WHERE status IN ('planning','active','paused') ORDER BY id"),
      all: db.prepare('SELECT * FROM schemes ORDER BY id DESC LIMIT ?'),
    };
  }

  row(r) {
    return r ? { id: r.id, ownerId: r.owner_id, ambitionId: r.ambition_id, goal: r.goal, targetIds: J(r.target_ids, []), status: r.status, steps: J(r.steps, []), accomplices: J(r.accomplices, []), exposedTo: J(r.exposed_to, []), createdAt: r.created_at, updatedAt: r.updated_at, data: J(r.data, {}) } : null;
  }

  get(id) { return this.row(this.q.get.get(id)); }
  save(s, { op = null, why = null } = {}) {
    const w = this.world;
    if (op) s.data.history = [...(s.data.history ?? []), { at: w.now, op, why }].slice(-40);
    this.q.save.run(s.goal, JSON.stringify(s.targetIds), s.status, JSON.stringify(s.steps), JSON.stringify(s.accomplices), JSON.stringify(s.exposedTo), w.now, JSON.stringify(s.data), s.id);
    if (op) w.logEvent('scheme', { actorId: s.ownerId, schemeId: s.id, op, why, status: s.status });
    w.bus.emit('scheming', { what: 'scheme', id: s.id });
  }

  live() { return this.q.live.all().map((r) => this.row(r)); }
  ownedBy(c, { live = true } = {}) { return this.q.byOwner.all(c.id).map((r) => this.row(r)).filter((s) => !live || ACTIVE.includes(s.status)); }
  joinedBy(c) { return this.live().filter((s) => s.accomplices.some((a) => a.citizen_id === c.id && ['in', 'wavering'].includes(a.status))); }

  /** The scheme a lie or an intention belongs to: one the citizen runs (or is in on), by id or the one with a due deceive step. */
  linkFor(c, id = null) {
    const mine = [...this.ownedBy(c), ...this.joinedBy(c)];
    if (id != null) return mine.find((s) => s.id === Number(id)) ?? null;
    return mine.find((s) => s.steps.some((st) => st.kind === 'deceive' && st.status === 'pending' && st.dueSince != null)) ?? null;
  }

  // ---------- planning ----------
  /** Called at reflection and at consolidation (with the ambition that may want a plan). */
  maybePlan(c, { trigger, ambition = null }) {
    const w = this.world;
    if (!c.alive || this.busy.has(c.id) || !w.scheming?.ambitions) return;
    const day = Math.floor(w.now / 1440);
    if ((c.schemePlans?.day === day ? c.schemePlans.n : 0) >= PER_DAY()) return;
    if (this.ownedBy(c).length >= MAX_ACTIVE()) return;
    const served = new Set(this.ownedBy(c).map((s) => s.ambitionId));
    const amb = ambition ?? w.scheming.ambitions.of(c.id).find((a) => a.intensity >= MIN_INTENSITY() && !served.has(a.id));
    if (!amb || amb.intensity < MIN_INTENSITY() || served.has(amb.id)) return;
    c.schemePlans = { day, n: (c.schemePlans?.day === day ? c.schemePlans.n : 0) + 1 };
    w.saveCitizen(c);
    this.plan(c, amb, trigger).catch((err) => w.logEvent('error', { actorId: c.id, message: `scheme planning failed: ${String(err.message).slice(0, 160)}` }));
  }

  async plan(c, amb, trigger) {
    const w = this.world;
    this.busy.add(c.id);
    try {
      const labels = peopleFor(w, c);
      const places = Object.keys(c.knownPlaces ?? {}).filter((id) => w.rooms.has(id));
      const types = [...w.objects.types.values()].filter((t) => t.portable || t.weapon || (t.tags ?? []).length).map((t) => t.id);
      const user = [
        `# WHAT YOU WANT\n${w.memory.resolveNames(c, amb.text)} (${amb.intensity}/10)`,
        `# PEOPLE YOU KNOW\n${[...labels.keys()].join(', ') || '(nobody)'}`,
        `# PLACES YOU KNOW\n${places.map((id) => `"${id}" = ${w.rooms.get(id).name}`).join('; ')}`,
        '# WHAT NOW\nYou lie awake turning it over. Is there a concrete plan — secret, over the next days — that would get you closer to this? Many people would rather wait and see; if that is you, say so (no_plan). If you do plan: the goal in one private sentence, who it is aimed at, 2 to 6 steps in order (what you do; where; with or without whom; not before / not after a time like "20:00" or "day 3 20:00"; what thing you would need, only of kinds that exist here), whom you would want to bring in, and what could go wrong. Call plan_scheme once.',
      ].join('\n\n');
      const people = labels.size ? [...labels.keys()] : ['nobody'];
      const tools = [{ type: 'function', function: { name: 'plan_scheme', description: 'A secret plan, or none.', parameters: { type: 'object', properties: {
        no_plan: { type: 'boolean', description: 'true: no plan for now (wait and see).' },
        why_not: { type: 'string' },
        goal: { type: 'string' },
        targets: { type: 'array', items: { type: 'string', enum: people } },
        steps: { type: 'array', maxItems: 6, items: { type: 'object', properties: {
          text: { type: 'string' }, kind: { type: 'string', enum: STEP_KINDS },
          at_place: { type: 'string', enum: places.length ? places : ['nowhere'] },
          with: { type: 'array', items: { type: 'string', enum: people } }, absent: { type: 'array', items: { type: 'string', enum: people } },
          not_before: { type: 'string' }, not_after: { type: 'string' },
          object_type: { type: 'string', enum: types }, condition: { type: 'string' },
        }, required: ['text', 'kind'] } },
        recruit: { type: 'array', maxItems: 2, items: { type: 'string', enum: people } },
        risks: { type: 'string' },
      } } } }];
      const { systemPrompt } = await import('../agents/prompt.js');
      const r = await chatForTool(w.llm, { purpose: 'scheme', tier: 'full', citizenId: c.id, tools, messages: [{ role: 'system', content: systemPrompt(w, c) }, { role: 'user', content: user }] }, 'plan_scheme');
      const a = r.toolCalls?.find((x) => x.name === 'plan_scheme')?.arguments;
      if (!c.alive || w.citizens.get(c.id) !== c) return null;
      if (!a || a.no_plan || !Array.isArray(a.steps) || !a.steps.length || !String(a.goal ?? '').trim()) {
        w.logEvent('scheme_none', { actorId: c.id, ambitionId: amb.id, trigger, why: String(a?.why_not ?? '').slice(0, 200) || null });
        return null;
      }
      return this.create(c, amb, a, { trigger, labels, places, types });
    } finally {
      this.busy.delete(c.id);
    }
  }

  /** Validate and store. → the scheme, or null (no valid step). */
  create(c, amb, a, { trigger, labels, places, types }) {
    const w = this.world;
    const person = (l) => labels.get(l)?.id ?? null;
    const steps = [];
    const rejected = [];
    for (const [i, st] of (a.steps ?? []).slice(0, 6).entries()) {
      const why = (() => {
        if (!STEP_KINDS.includes(st.kind)) return 'unknown kind';
        if (st.at_place && !places.includes(st.at_place)) return `unknown place ${st.at_place}`;
        if ((st.with ?? []).some((l) => !person(l)) || (st.absent ?? []).some((l) => !person(l))) return 'unknown person';
        if (st.object_type && !types.includes(st.object_type)) return `no such thing here: ${st.object_type}`;
        if (st.kind === 'obtain' && !st.object_type) return 'obtain what? (no kind of thing that exists here)';
        return null;
      })();
      if (why) { rejected.push({ text: String(st.text ?? '').slice(0, 120), why }); continue; }
      const prev = steps.at(-1);
      steps.push({
        id: `s${i + 1}`, text: String(st.text).trim().slice(0, 200), kind: st.kind,
        when: {
          after: prev?.id ?? null,
          ...(st.at_place ? { at_place: st.at_place } : {}),
          ...((st.with ?? []).length ? { with: st.with.map(person) } : {}),
          ...((st.absent ?? []).length ? { absent: st.absent.map(person) } : {}),
          ...(parseTimeRef(w, st.not_before) != null ? { not_before: parseTimeRef(w, st.not_before) } : {}),
          ...(parseTimeRef(w, st.not_after) != null ? { not_after: parseTimeRef(w, st.not_after) } : {}),
          ...(st.condition ? { condition: String(st.condition).slice(0, 160) } : {}),
        },
        ...(st.object_type ? { objectType: st.object_type } : {}),
        status: 'pending', result: null,
      });
    }
    if (!steps.length) { w.logEvent('scheme_rejected', { actorId: c.id, ambitionId: amb.id, rejected }); return null; }
    const targets = (a.targets ?? []).map(person).filter(Boolean);
    const data = { trigger, risks: String(a.risks ?? '').slice(0, 300) || null, recruit: (a.recruit ?? []).map(person).filter(Boolean), rejected, history: [{ at: w.now, op: 'created', why: `toward: ${amb.text}`.slice(0, 200) }] };
    const info = this.q.insert.run(c.id, amb.id, String(a.goal).trim().slice(0, 300), JSON.stringify(targets), JSON.stringify(steps), w.now, w.now, JSON.stringify(data));
    const s = this.get(Number(info.lastInsertRowid));
    w.logEvent('scheme', { actorId: c.id, schemeId: s.id, op: 'created', goal: s.goal, steps: steps.length, rejected: rejected.length, trigger });
    w.memory.pushOnMind(c, { text: `My plan: ${s.goal}`, importance: 7 });
    w.bus.emit('scheming', { what: 'scheme', id: s.id });
    return s;
  }

  // ---------- due steps (code checks; never performs) ----------
  holds(s, st, owner) {
    const w = this.world;
    if (st.status !== 'pending') return false;
    const wh = st.when ?? {};
    if (wh.after && s.steps.find((x) => x.id === wh.after)?.status !== 'done') return false;
    if (wh.at_place && owner.location !== wh.at_place) return false;
    const here = new Set(citizensIn(w.citizens, owner.location ?? '', { exceptId: owner.id }).map((o) => o.id));
    if ((wh.with ?? []).some((id) => !here.has(id))) return false;
    if ((wh.absent ?? []).some((id) => here.has(id))) return false;
    if (wh.not_before != null && w.now < wh.not_before) return false;
    if (wh.not_after != null && w.now > wh.not_after) return false;
    return true;
  }

  dueStep(s, owner) {
    return s.status === 'active' ? s.steps.find((st) => this.holds(s, st, owner)) ?? null : null;
  }

  /** Every few game minutes: mark newly due steps (the first decision with one is full: scheme_step). */
  tick() {
    const w = this.world;
    if (w.now - this.lastDue < 2) return;
    this.lastDue = w.now;
    for (const s of this.live()) {
      const owner = w.citizens.get(s.ownerId);
      if (!owner?.alive) {
        if (s.status !== 'failed') { s.status = 'failed'; this.save(s, { op: 'failed', why: 'the one behind it is dead' }); }
        continue;
      }
      let changed = false;
      for (const st of s.steps) {
        const due = this.holds(s, st, owner);
        if (due && st.dueSince == null) { st.dueSince = w.now; owner.schemeStepNew = { schemeId: s.id, stepId: st.id, at: w.now }; changed = true; w.logEvent('scheme_step_due', { actorId: owner.id, schemeId: s.id, step: st.id, text: st.text }); }
        else if (!due && st.dueSince != null && st.status === 'pending' && w.now - st.dueSince > DUE_FADE) { /* fades to a reminder in the prompt */ }
      }
      if (changed) { this.save(s); w.saveCitizen(owner); }
    }
  }

  // ---------- the prompt ----------
  promptBlock(c, tier) {
    const w = this.world;
    if (tier === 'none') return null;
    const out = [];
    for (const s of this.ownedBy(c).filter((x) => x.status === 'active')) {
      const due = s.steps.find((st) => st.status === 'pending' && st.dueSince != null && this.holds(s, st, c));
      const next = s.steps.find((st) => st.status === 'pending' && st !== due);
      const stale = due && w.now - due.dueSince > DUE_FADE;
      if (tier === 'light' && !due) continue;
      const done = s.steps.filter((st) => st.status === 'done').length;
      const lines = [`Your plan (secret): ${w.memory.resolveNames(c, s.goal)} [${done}/${s.steps.length} steps done]`];
      if (due && !stale) lines.push(`Now would be the moment: ${s.steps.indexOf(due) + 1}. ${due.text}${due.when?.condition ? ` (${due.when.condition})` : ''}`);
      else if (due) lines.push(`(Still waiting to be done: ${due.text})`);
      if (next && tier === 'full') lines.push(`Then: ${next.text}`);
      const acc = s.accomplices.filter((a) => a.status !== 'out');
      if (acc.length && tier === 'full') lines.push(`In on it: ${acc.map((a) => `${ref(w.citizens.get(a.citizen_id) ?? a.citizen_id)} (${a.status === 'asked' ? 'still thinking about it' : a.status === 'refused' ? 'said no, but knows' : a.status === 'in' ? 'with you' : a.status})`).join(', ')}.`);
      out.push(lines.join('\n'));
    }
    if (tier === 'full') {
      for (const s of this.joinedBy(c)) {
        const a = s.accomplices.find((x) => x.citizen_id === c.id);
        const owner = w.citizens.get(s.ownerId);
        const what = a.knows === 'full' ? s.goal : `${a.role === 'keep_quiet' ? 'keep quiet about it' : 'help'}: ${s.steps.find((st) => st.status === 'pending')?.text ?? s.goal}`;
        out.push(`You're in on ${ref(owner)}'s plan: ${what}${a.status === 'wavering' ? "\nYou're having doubts about it." : ''}`);
      }
    }
    for (const p of (c.proposals ?? []).filter((x) => w.now - x.at < PROPOSAL_MINUTES)) {
      out.push(`${ref(w.citizens.get(p.from) ?? p.from)} asked you to ${p.ask === 'keep_quiet' ? 'keep quiet about' : 'join'} a plan of theirs. You haven't answered yet.`);
    }
    return out.length ? w.memory.resolveNames(c, out.join('\n\n')) : null;
  }

  // ---------- the decision's `scheme` field ----------
  applyDecision(c, f) {
    const w = this.world;
    if (!f || typeof f !== 'object') return;
    const s = this.get(Number(f.id));
    if (!s || s.ownerId !== c.id || !ACTIVE.includes(s.status)) return;
    const reason = String(f.reason ?? '').trim().slice(0, 200) || null;
    const step = (id) => s.steps.find((st) => st.id === id);
    if (f.step_done && step(f.step_done) && step(f.step_done).status === 'pending') {
      Object.assign(step(f.step_done), { status: 'done', result: reason, doneAt: w.now });
      this.save(s, { op: 'step_done', why: `${f.step_done}${reason ? `: ${reason}` : ''}` });
    }
    if (f.step_failed && step(f.step_failed) && step(f.step_failed).status === 'pending') {
      Object.assign(step(f.step_failed), { status: 'failed', result: reason, doneAt: w.now });
      this.save(s, { op: 'step_failed', why: `${f.step_failed}${reason ? `: ${reason}` : ''}` });
    }
    if (f.revise?.replace_step && step(f.revise.replace_step) && f.revise.with?.text) {
      const st = step(f.revise.replace_step);
      if (st.status === 'pending') {
        const old = st.text;
        st.text = String(f.revise.with.text).slice(0, 200);
        if (STEP_KINDS.includes(f.revise.with.kind)) st.kind = f.revise.with.kind;
        if (f.revise.with.at_place && w.rooms.has(f.revise.with.at_place)) st.when = { ...st.when, at_place: f.revise.with.at_place };
        st.dueSince = null;
        this.save(s, { op: 'revise', why: `${st.id}: "${old}" → "${st.text}"${reason ? ` — ${reason}` : ''}` });
      }
    }
    if (f.pause && reason) { s.status = 'paused'; this.save(s, { op: 'pause', why: reason }); }
    if (f.resume && s.status === 'paused') { s.status = 'active'; this.save(s, { op: 'resume', why: reason }); }
    if (f.abandon && reason) { s.status = 'abandoned'; this.save(s, { op: 'abandon', why: reason }); }
    if (s.status === 'active' && s.steps.length && s.steps.every((st) => st.status !== 'pending')) {
      s.status = s.steps.some((st) => st.status === 'done') ? 'done' : 'failed';
      this.save(s, { op: s.status, why: 'every step is behind them' });
    }
  }

  // ---------- accomplices ----------
  /** say with confide: { scheme, reveal, ask } — what was shared; everyone who heard it is exposed. */
  confide(c, f, { addressee, hearers }) {
    const w = this.world;
    const s = this.get(Number(f?.scheme));
    if (!s || s.ownerId !== c.id) return;
    const reveal = f.reveal === 'full' ? 'full' : 'partial';
    const ask = ['join', 'keep_quiet'].includes(f.ask) ? f.ask : 'none';
    for (const o of hearers) this.expose(s, o, { how: o.id === addressee?.id ? 'confided' : 'overheard', from: c.id, reveal, intended: o.id === addressee?.id });
    if (addressee && ask !== 'none' && hearers.some((o) => o.id === addressee.id)) {
      const known = s.accomplices.find((a) => a.citizen_id === addressee.id);
      if (!known) s.accomplices.push({ citizen_id: addressee.id, role: ask, knows: reveal, commitment: null, joined_at: null, status: 'asked', asked_at: w.now });
      addressee.proposals = [...(addressee.proposals ?? []).filter((p) => p.scheme !== s.id), { scheme: s.id, from: c.id, reveal, ask, at: w.now }];
      w.saveCitizen(addressee);
      w.perceive([addressee.id], { kind: 'speech', text: `${ref(c)} wants your answer: will you ${ask === 'keep_quiet' ? 'keep quiet about it' : 'join in'}?`, importance: 8, sourceId: c.id, roomId: c.location, data: { proposal: s.id, wake: true } });
    }
    this.save(s, { op: 'confided', why: `to ${hearers.map((o) => o.name).join(', ')} (${reveal}${ask !== 'none' ? `, asked to ${ask}` : ''})` });
  }

  /** proposal: { scheme, answer: join | refuse | think_about_it, reason } */
  answer(c, p) {
    const w = this.world;
    const s = this.get(Number(p?.scheme));
    const pending = (c.proposals ?? []).find((x) => x.scheme === Number(p?.scheme));
    if (!s || !pending) return;
    const a = s.accomplices.find((x) => x.citizen_id === c.id) ?? (s.accomplices.push({ citizen_id: c.id, role: pending.ask, knows: pending.reveal, status: 'asked' }), s.accomplices.at(-1));
    const reason = String(p.reason ?? '').trim().slice(0, 200) || null;
    if (p.answer === 'join') {
      Object.assign(a, { status: 'in', joined_at: w.now, commitment: this.commitment(s, c, 6) });
      w.memory.pushOnMind(c, { text: `I'm in on ${ref(w.citizens.get(s.ownerId))}'s plan.`, importance: 6 });
    } else if (p.answer === 'refuse') {
      Object.assign(a, { status: 'refused' });
    } else {
      pending.think = true;
      this.save(s, { op: 'proposal_think', why: `${c.name}: ${reason ?? 'will think about it'}` });
      w.saveCitizen(c);
      return;
    }
    c.proposals = (c.proposals ?? []).filter((x) => x !== pending);
    w.saveCitizen(c);
    this.save(s, { op: `proposal_${p.answer}`, why: `${c.name}${reason ? `: ${reason}` : ''}` });
  }

  /** Commitment 0–10, from feelings and ties (recomputed in code at each of the accomplice's reflections). */
  commitment(s, c, base = null) {
    const w = this.world;
    const a = s.accomplices.find((x) => x.citizen_id === c.id);
    let v = base ?? a?.commitment ?? 6;
    const fear = Math.max(0, ...w.emotions.of(c).filter((e) => e.type === 'fear').map((e) => e.intensity));
    const guilt = Math.max(0, ...w.emotions.of(c).filter((e) => e.type === 'guilt').map((e) => e.intensity));
    v -= 0.3 * fear;
    v -= 0.3 * guilt * (trait(c, 'honesty') / 10);
    for (const t of s.targetIds) {
      const aff = w.memory.rel(c.id, t)?.affinity ?? 0;
      if (aff >= 2) v -= 1.5;
      if (aff <= -2) v += 1; // a shared grudge
    }
    v += (w.memory.rel(c.id, s.ownerId)?.affinity ?? 0) * 0.4;
    const lastTalk = w.db.prepare("SELECT MAX(game_time) t FROM events WHERE type = 'action' AND actor_id = ? AND json_extract(data, '$.toId') = ?").get(s.ownerId, c.id)?.t;
    if (lastTalk != null && w.now - lastTalk < 1440) v += 0.5; else if (lastTalk != null) v -= Math.min(2, (w.now - lastTalk) / 1440 * 0.5);
    return Math.round(Math.max(0, Math.min(10, v)) * 10) / 10;
  }

  /** Reflection of citizen c: their commitments, their open proposals, their own plans (failed targets, new plans). */
  onReflection(c) {
    const w = this.world;
    for (const s of this.live()) {
      const a = s.accomplices.find((x) => x.citizen_id === c.id && ['in', 'wavering'].includes(x.status));
      if (a) {
        const before = a.status;
        a.commitment = this.commitment(s, c);
        a.status = a.commitment < 3 ? 'wavering' : 'in';
        if (a.status !== before) this.save(s, { op: a.status === 'wavering' ? 'wavering' : 'steady', why: `${c.name} (commitment ${a.commitment})` });
        else this.save(s);
      }
      if (s.ownerId === c.id && s.status === 'active' && s.targetIds.length && s.targetIds.every((id) => !w.citizens.get(id)?.alive)) {
        s.status = 'failed';
        this.save(s, { op: 'failed', why: 'the one it was aimed at is dead' });
      }
    }
    // a proposal they said they'd think about comes back once
    for (const p of (c.proposals ?? []).filter((x) => x.think && !x.reminded)) {
      p.reminded = true;
      w.perceive([c.id], { kind: 'system', text: `You still owe ${ref(w.citizens.get(p.from) ?? p.from)} an answer about that plan.`, importance: 6, roomId: c.location, data: { proposal: p.scheme } });
    }
    c.proposals = (c.proposals ?? []).filter((x) => w.now - x.at < PROPOSAL_MINUTES);
    w.saveCitizen(c);
    this.maybePlan(c, { trigger: 'reflection' });
  }

  // ---------- exposure ----------
  expose(s, o, { how, from = null, reveal = 'partial', intended = false }) {
    const w = this.world;
    if (!o || o.id === s.ownerId || s.exposedTo.includes(o.id)) return;
    s.exposedTo.push(o.id);
    const owner = w.citizens.get(s.ownerId);
    const what = reveal === 'full' ? s.goal : `something against ${s.targetIds.map((id) => ref(w.citizens.get(id) ?? id)).join(' and ') || 'someone'}`;
    const src = how === 'confided' || how === 'overheard' ? ref(owner) : from ? ref(w.citizens.get(from) ?? from) : 'someone';
    w.memory.add(o.id, { kind: how === 'confided' ? 'episodic' : 'secondhand', text: `${how === 'overheard' ? `I overheard ${src} — ` : how === 'confided' ? `${src} told me in confidence: ` : `${src} told me: `}${ref(owner)} means ${what.replace(/^I /, 'to ')}`.slice(0, 300), importance: 7, about: [s.ownerId, ...s.targetIds], placeId: o.location, source: { schemeId: s.id, how, from, ...(from && from !== s.ownerId ? { toldBy: from } : {}) } });
    if (!intended && !s.accomplices.some((a) => a.citizen_id === o.id && ['in', 'wavering'].includes(a.status))) {
      w.relationships.change(o.id, s.ownerId, { trust: -1 }, { reason: `${ref(owner)} is plotting something against ${s.targetIds.map((id) => ref(w.citizens.get(id) ?? id)).join(' and ') || 'someone'}`, source: 'reflection', evidence: { schemeId: s.id } });
    }
    // an accomplice who passes it on has betrayed it
    const fromAcc = from ? s.accomplices.find((a) => a.citizen_id === from) : null;
    if (fromAcc && fromAcc.status !== 'betrayed') { fromAcc.status = 'betrayed'; w.logEvent('scheme', { actorId: s.ownerId, schemeId: s.id, op: 'betrayed', why: `${w.citizens.get(from)?.name} told ${o.name}` }); }
    if (s.targetIds.includes(o.id) && s.status !== 'exposed') { s.status = 'exposed'; s.data.exposedAt = w.now; }
    this.save(s, { op: 'exposed_to', why: `${o.name} (${how}${from && from !== s.ownerId ? `, from ${w.citizens.get(from)?.name}` : ''})` });
  }

  view({ ownerId = null, limit = 100 } = {}) {
    const name = (id) => this.world.citizens.get(id)?.name ?? id;
    return this.q.all.all(limit).map((r) => this.row(r)).filter((s) => !ownerId || s.ownerId === ownerId || s.accomplices.some((a) => a.citizen_id === ownerId))
      .map((s) => ({ ...s, ownerName: name(s.ownerId), targetNames: s.targetIds.map(name), exposedNames: s.exposedTo.map(name), accomplices: s.accomplices.map((a) => ({ ...a, name: name(a.citizen_id) })), steps: s.steps.map((st) => ({ ...st, placeName: st.when?.at_place ? this.world.rooms.get(st.when.at_place)?.name ?? null : null })) }));
  }
}
