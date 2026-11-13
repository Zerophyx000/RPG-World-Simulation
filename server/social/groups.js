// Groups (step 5.5): family, household, village, guild, faction, party, gang.
//
// Groups come from content (content/groups.json + content/scenarios/<id>/groups.json, seeded once per id),
// the director, or code (parties formed by citizens). Citizens never create arbitrary groups.
// Joining creates 'group' relationship events towards every other member ("She's my sister.").
//
// Who knows a membership (a code check for now):
//   - your own groups and their members: always (secret ones too)
//   - others: only public groups with a non-secret membership, and only if you know that person's name
//
// Parties: propose_party → invitations (pending 60 game minutes) → accept creates / joins the party.
import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_DIR } from '../world/scenarios.js';
import { pronounsOf } from '../memory/words.js';
import { ref } from '../memory/index.js';

export const GROUP_KINDS = ['family', 'household', 'village', 'guild', 'faction', 'party', 'gang'];
export const INVITATION_MINUTES = 60;
export const PARTY_MAX = 6;

// In-group deltas on joining (§2.2).
const IN_GROUP = {
  family: { trust: 3, affinity: 2, familiarity: 4 },
  household: { trust: 2, affinity: 1, familiarity: 3 },
  party: { trust: 2, affinity: 1, familiarity: 1 },
  guild: { trust: 1, affinity: 0.5, familiarity: 0.5 },
  faction: { trust: 1, affinity: 0.5, familiarity: 0.5 },
  village: { trust: 0.5, affinity: 0, familiarity: 0.5 },
  gang: { trust: 2, affinity: 1, familiarity: 1 },
};
const KIN_WORDS = new Set(['mother', 'father', 'sister', 'brother', 'daughter', 'son', 'wife', 'husband', 'aunt', 'uncle', 'cousin', 'grandmother', 'grandfather', 'niece', 'nephew']);

export class Groups {
  constructor(world) {
    this.world = world;
    this.db = world.db;
    this.groups = new Map();  // id -> group
    this.members = [];        // { groupId, citizenId, role, secret, joinedAt, leftAt }
  }

  // ---------- boot ----------
  load(scenario) {
    this.groups.clear();
    for (const r of this.db.prepare('SELECT * FROM groups').all()) {
      this.groups.set(r.id, { id: r.id, name: r.name, kind: r.kind, public: Boolean(r.public), origin: r.origin, data: safeJson(r.data), createdAt: r.created_at, dissolvedAt: r.dissolved_at });
    }
    this.members = this.db.prepare('SELECT * FROM group_members').all().map((r) => ({
      groupId: r.group_id, citizenId: r.citizen_id, role: r.role, secret: Boolean(r.secret), joinedAt: r.joined_at, leftAt: r.left_at,
    }));
    return this.seed(scenario);
  }

  contentDefs(scenario = this.world.scenario) {
    const out = new Map();
    for (const f of [path.join(CONTENT_DIR, 'groups.json'), path.join(CONTENT_DIR, 'scenarios', String(scenario ?? ''), 'groups.json')]) {
      if (!fs.existsSync(f)) continue;
      try {
        for (const g of JSON.parse(fs.readFileSync(f, 'utf8'))) if (g?.id) out.set(String(g.id), g);
      } catch (err) {
        console.warn(`[groups] ${path.relative(CONTENT_DIR, f)} unreadable: ${err.message}`);
      }
    }
    return out;
  }

  /** Content groups are inserted once per id; each content member joins once (also when they appear later). */
  seed(scenario) {
    let groups = 0;
    let joined = 0;
    for (const def of this.contentDefs(scenario).values()) {
      if (!GROUP_KINDS.includes(def.kind)) {
        console.warn(`[groups] ${def.id}: unknown kind "${def.kind}"`);
        continue;
      }
      if (!this.groups.has(def.id)) {
        this.#insertGroup({
          id: def.id, name: def.name ?? def.id, kind: def.kind, public: def.public !== false, origin: 'content',
          data: { description: def.description ?? null, purpose: def.purpose ?? null, norms: def.norms ?? [], wariness: Number(def.wariness) || 0, mark: def.mark ?? null },
        });
        groups++;
      }
      for (const m of def.members ?? []) {
        const id = typeof m === 'string' ? m : m.id;
        if (!this.world.citizens.has(id) || this.members.some((x) => x.groupId === def.id && x.citizenId === id)) continue;
        this.join(def.id, id, { role: m.role ?? 'member', secret: Boolean(m.secret) });
        joined++;
      }
    }
    if (groups || joined) console.log(`[content] seeded ${groups} groups, ${joined} memberships`);
    return { groups, joined };
  }

  #insertGroup(g) {
    g.createdAt = this.world.now;
    g.dissolvedAt = null;
    this.db.prepare('INSERT INTO groups (id, name, kind, public, origin, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(g.id, g.name, g.kind, g.public ? 1 : 0, g.origin, JSON.stringify(g.data ?? {}), g.createdAt);
    this.groups.set(g.id, g);
    return g;
  }

  // ---------- lookups ----------
  get(id) {
    const g = this.groups.get(id);
    return g && !g.dissolvedAt ? g : null;
  }

  membersOf(groupId) {
    return this.members.filter((m) => m.groupId === groupId && m.leftAt == null);
  }

  /** Active memberships of a citizen: [{ group, role, secret }] */
  of(citizenId) {
    const out = [];
    for (const m of this.members) {
      if (m.citizenId !== citizenId || m.leftAt != null) continue;
      const g = this.get(m.groupId);
      if (g) out.push({ group: g, role: m.role, secret: m.secret });
    }
    return out;
  }

  shared(a, b, kinds = null) {
    const mine = new Set(this.of(a).filter((x) => !kinds || kinds.includes(x.group.kind)).map((x) => x.group.id));
    return this.of(b).filter((x) => mine.has(x.group.id)).map((x) => x.group);
  }

  /** Family, household or party: the people who may walk behind you and be in your house. */
  isClose(a, b) {
    return this.shared(a, b, ['family', 'household', 'party']).length > 0;
  }

  isFamily(a, b) {
    return this.shared(a, b, ['family']).length > 0;
  }

  /** Memberships of `other` that `viewer` knows about. */
  knownMemberships(viewer, other) {
    const out = [];
    const rel = this.world.memory.rel(viewer.id, other.id);
    const knowsName = Boolean(rel?.nameKnown && rel.nameConfidence >= 0.5);
    const mine = new Set(this.of(viewer.id).map((x) => x.group.id));
    for (const m of this.of(other.id)) {
      if (mine.has(m.group.id)) out.push({ ...m, own: true });
      else if (m.group.public && !m.secret && (knowsName || m.group.data?.mark)) out.push({ ...m, own: false });
    }
    return out;
  }

  /** Tags for WHO IS HERE: "your sister", "your party", "from the village", "wears the smiths' guild mark". */
  tagsFor(viewer, other) {
    const tags = [];
    const order = ['family', 'household', 'party', 'gang', 'guild', 'faction', 'village'];
    const known = this.knownMemberships(viewer, other).sort((a, b) => order.indexOf(a.group.kind) - order.indexOf(b.group.kind));
    for (const m of known) {
      const g = m.group;
      if (m.own) {
        if (g.kind === 'family') tags.push(KIN_WORDS.has(String(m.role).toLowerCase()) ? `your ${m.role}` : 'your family');
        else if (g.kind === 'household') tags.push('your household');
        else if (g.kind === 'party') tags.push('your party');
        else if (g.kind === 'village') continue; // among villagers that goes without saying
        else if (g.kind === 'gang') tags.push(`one of ${g.name}, like you`);
        else tags.push(`${g.name}, like you`);
      } else if (g.kind === 'village') tags.push('from the village');
      else if (g.kind === 'guild') tags.push(g.data?.mark ? `wears ${g.data.mark}` : `of ${g.name}`);
      else if (g.kind === 'family') tags.push(`of ${g.name}`);
      else if (g.kind === 'party') tags.push(`travelling with ${g.name}`);
      else tags.push(`one of ${g.name}`);
    }
    return tags.slice(0, 2);
  }

  /** YOUR GROUPS block (own prompt only; secret groups included, marked as such). */
  block(c) {
    const mem = this.world.memory;
    const lines = [];
    for (const m of this.of(c.id)) {
      const g = m.group;
      const fellows = this.membersOf(g.id).filter((x) => x.citizenId !== c.id).map((x) => {
        const o = this.world.citizens.get(x.citizenId);
        if (!o) return null;
        const kin = g.kind === 'family' && KIN_WORDS.has(String(x.role).toLowerCase()) ? ` (your ${x.role})` : '';
        return `${mem.nameFor(c, o.id)}${kin}`;
      }).filter(Boolean);
      // the whole village is not worth listing by name
      const who = g.kind === 'village' ? '' : fellows.length ? ` With: ${fellows.join(', ')}.` : ' Nobody else, for now.';
      const purpose = g.data?.purpose ? ` Purpose: ${g.data.purpose}.` : '';
      const secret = !g.public ? ' Nobody outside knows of it.' : m.secret ? ' Nobody knows you belong to it.' : '';
      const role = m.role && !['member'].includes(m.role) && !KIN_WORDS.has(String(m.role).toLowerCase()) ? ` You are its ${m.role}.` : '';
      lines.push(`- ${g.name} (${g.kind === 'party' ? 'your party' : g.kind}).${role}${purpose}${who}${secret}`);
    }
    return lines.join('\n');
  }

  // ---------- membership changes ----------
  /** Director / code: create a group. */
  create(def, { origin = 'director' } = {}) {
    const id = String(def.id ?? `g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`);
    if (!/^[a-z0-9_-]{1,60}$/.test(id)) throw httpError(400, 'group id must be 1–60 chars of a-z, 0-9, _ or -');
    if (this.groups.has(id)) throw httpError(400, `group "${id}" already exists`);
    if (!GROUP_KINDS.includes(def.kind)) throw httpError(400, `kind must be one of ${GROUP_KINDS.join(', ')}`);
    const g = this.#insertGroup({
      id, name: String(def.name ?? id).slice(0, 80), kind: def.kind, public: def.public !== false, origin,
      data: {
        description: def.description ?? null, purpose: def.purpose ?? null, norms: def.norms ?? [], founderId: def.founderId ?? null,
        maxSize: def.maxSize ?? (def.kind === 'party' ? PARTY_MAX : null), wariness: Number(def.wariness) || 0, mark: def.mark ?? null,
      },
    });
    for (const m of def.members ?? []) this.join(id, typeof m === 'string' ? m : m.id, { role: m.role ?? 'member', secret: Boolean(m.secret) });
    this.world.logEvent('group', { action: 'create', groupId: id, name: g.name, kind: g.kind, public: g.public, origin });
    this.#emit(g);
    return this.view(g);
  }

  edit(id, patch = {}) {
    const g = this.groups.get(id);
    if (!g) throw httpError(404, `unknown group "${id}"`);
    if (patch.name != null) g.name = String(patch.name).slice(0, 80);
    if (patch.public != null) g.public = Boolean(patch.public);
    for (const k of ['description', 'purpose', 'wariness', 'mark']) if (patch[k] !== undefined) g.data[k] = patch[k];
    if (patch.dissolve) g.dissolvedAt = this.world.now;
    this.db.prepare('UPDATE groups SET name = ?, public = ?, data = ?, dissolved_at = ? WHERE id = ?').run(g.name, g.public ? 1 : 0, JSON.stringify(g.data), g.dissolvedAt, id);
    for (const m of patch.add ?? []) this.join(id, typeof m === 'string' ? m : m.id, { role: m.role ?? 'member', secret: Boolean(m.secret) });
    for (const cid of patch.remove ?? []) this.leave(id, cid, { dissolveSmallParty: false });
    this.#emit(g);
    return this.view(g);
  }

  /** Join: membership row + 'group' relationship events both ways with everyone already in it. */
  join(groupId, citizenId, { role = 'member', secret = false } = {}) {
    const g = this.get(groupId);
    const c = this.world.citizens.get(citizenId);
    if (!g) throw httpError(404, `unknown group "${groupId}"`);
    if (!c) throw httpError(404, `unknown citizen "${citizenId}"`);
    const current = this.membersOf(groupId);
    if (current.some((m) => m.citizenId === citizenId)) return false;
    if (g.data?.maxSize && current.length >= g.data.maxSize) throw httpError(400, `${g.name} is full`);
    const row = { groupId, citizenId, role, secret, joinedAt: this.world.now + this.members.length * 1e-6, leftAt: null };
    this.db.prepare('INSERT INTO group_members (group_id, citizen_id, role, secret, joined_at) VALUES (?, ?, ?, ?, ?)').run(groupId, citizenId, role, secret ? 1 : 0, row.joinedAt);
    this.members.push(row);
    const d = IN_GROUP[g.kind];
    for (const m of current) {
      const o = this.world.citizens.get(m.citizenId);
      if (!o) continue;
      const known = ['family', 'household', 'gang', 'party'].includes(g.kind) ? { nameKnown: true, nameConfidence: 1 } : {};
      this.world.relationships.change(citizenId, o.id, d, { source: 'group', reason: groupReason(g, o, m.role), evidence: { groupId }, meta: known });
      this.world.relationships.change(o.id, citizenId, d, { source: 'group', reason: groupReason(g, c, role), evidence: { groupId }, meta: known });
    }
    this.world.logEvent('group', { action: 'join', actorId: citizenId, groupId, name: g.name, kind: g.kind, role, secret });
    // Step 6: a party forming without you (jealousy), a coveted role going to someone else (envy).
    if (g.kind === 'party') this.world.emotions?.appraisal.onPartyJoin(g, citizenId);
    this.world.emotions?.appraisal.onGroupRole(g, citizenId, role);
    this.#emit(g);
    return true;
  }

  /** Leave. Nothing is reversed automatically: what happens around the leaving creates its own events. */
  leave(groupId, citizenId, { dissolveSmallParty = true } = {}) {
    const m = this.members.find((x) => x.groupId === groupId && x.citizenId === citizenId && x.leftAt == null);
    const g = this.groups.get(groupId);
    if (!m || !g) return false;
    m.leftAt = this.world.now;
    this.db.prepare('UPDATE group_members SET left_at = ? WHERE group_id = ? AND citizen_id = ? AND joined_at = ?').run(m.leftAt, groupId, citizenId, m.joinedAt);
    this.world.logEvent('group', { action: 'leave', actorId: citizenId, groupId, name: g.name, kind: g.kind });
    if (dissolveSmallParty && g.kind === 'party' && this.membersOf(groupId).length < 2) this.dissolve(groupId);
    this.#emit(g);
    return true;
  }

  dissolve(groupId) {
    const g = this.groups.get(groupId);
    if (!g || g.dissolvedAt) return;
    const left = this.membersOf(groupId);
    g.dissolvedAt = this.world.now;
    this.db.prepare('UPDATE groups SET dissolved_at = ? WHERE id = ?').run(g.dissolvedAt, groupId);
    for (const m of left) {
      m.leftAt = this.world.now;
      this.db.prepare('UPDATE group_members SET left_at = ? WHERE group_id = ? AND citizen_id = ? AND joined_at = ?').run(m.leftAt, groupId, m.citizenId, m.joinedAt);
      this.world.perceive([m.citizenId], { kind: 'system', text: `${g.name} is no more: you are on your own again.`, importance: 5 });
    }
    this.world.logEvent('group', { action: 'dissolve', groupId, name: g.name, kind: g.kind });
  }

  // ---------- parties (formed by citizens; the only groups they can form) ----------
  /** Live invitations for a citizen (expired ones are dropped). */
  invitations(c) {
    const live = (c.invitations ?? []).filter((i) => i.until > this.world.now && this.world.citizens.get(i.from)?.alive);
    if (live.length !== (c.invitations ?? []).length) c.invitations = live;
    return live;
  }

  /** People here that `c` could invite: known, awake, not already in a party with them. */
  invitable(c, present) {
    return present.filter((o) => this.world.memory.rel(c.id, o.id) && !this.shared(c.id, o.id, ['party']).length);
  }

  propose(c, invitees, purpose) {
    const text = String(purpose ?? '').trim().replace(/[.!]+$/, '').slice(0, 120) || 'stick together for a while';
    const p = pronounsOf(c);
    for (const o of invitees) {
      o.invitations = [...this.invitations(o).filter((i) => i.from !== c.id), { from: c.id, purpose: text, at: this.world.now, until: this.world.now + INVITATION_MINUTES }];
      this.world.saveCitizen(o);
      this.world.perceive([o.id], {
        kind: 'speech', text: `${ref(c)} asks you to join ${p.obj}: to ${text.replace(/^to /i, '')}.`, importance: 8, sourceId: c.id, roomId: c.location,
        data: { invitation: true, wake: true, addressed: true },
      });
    }
    c.partyProposal = { purpose: text, at: this.world.now, invited: invitees.map((o) => o.id) };
    this.world.saveCitizen(c);
    this.world.logEvent('group', { action: 'propose', actorId: c.id, location: c.location, purpose: text, invited: invitees.map((o) => o.id) });
    return text;
  }

  /** Accept: the first accept creates the party (founder + acceptor); later accepts join it. */
  accept(c, fromId) {
    const inv = this.invitations(c).find((i) => i.from === fromId);
    const founder = this.world.citizens.get(fromId);
    if (!inv || !founder) return { ok: false, reason: 'That invitation no longer stands.' };
    c.invitations = this.invitations(c).filter((i) => i !== inv);
    let g = this.of(founder.id).map((x) => x.group).find((x) => x.kind === 'party' && x.data?.founderId === founder.id && x.data?.purpose === inv.purpose);
    try {
      if (!g) {
        const id = `party_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
        this.create({ id, name: `${founder.name}'s party`, kind: 'party', public: true, purpose: inv.purpose, founderId: founder.id, maxSize: PARTY_MAX }, { origin: 'code' });
        g = this.get(id);
        this.join(id, founder.id, { role: 'leader' });
      }
      this.join(g.id, c.id, { role: 'member' });
    } catch (err) {
      return { ok: false, reason: err.message };
    }
    this.world.saveCitizen(c);
    this.world.perceive([founder.id], {
      kind: 'speech', text: `${ref(c)} agrees to join you.`, importance: 7, sourceId: c.id, roomId: c.location, data: { wake: true, addressed: true },
    });
    return { ok: true, group: g };
  }

  decline(c, fromId) {
    const before = this.invitations(c).length;
    c.invitations = this.invitations(c).filter((i) => i.from !== fromId);
    this.world.saveCitizen(c);
    this.world.logEvent('group', { action: 'decline', actorId: c.id, location: c.location, from: fromId });
    return before !== c.invitations.length;
  }

  // ---------- views ----------
  view(g) {
    return {
      id: g.id, name: g.name, kind: g.kind, public: g.public, origin: g.origin, data: g.data, createdAt: g.createdAt, dissolvedAt: g.dissolvedAt,
      members: this.members.filter((m) => m.groupId === g.id).map((m) => ({
        citizenId: m.citizenId, name: this.world.citizens.get(m.citizenId)?.name ?? m.citizenId, role: m.role, secret: m.secret,
        joinedAt: m.joinedAt, leftAt: m.leftAt, location: this.world.citizens.get(m.citizenId)?.location ?? null,
      })),
    };
  }

  list({ includeDissolved = true } = {}) {
    return [...this.groups.values()].filter((g) => includeDissolved || !g.dissolvedAt).map((g) => this.view(g));
  }

  #emit(g) {
    this.world.bus.emit('group', { id: g.id });
  }
}

function groupReason(g, other, role) {
  const p = pronounsOf(other);
  const S = p.subj === 'they' ? 'They' : p.subj[0].toUpperCase() + p.subj.slice(1);
  const is = p.subj === 'they' ? "'re" : "'s";
  switch (g.kind) {
    case 'family': return KIN_WORDS.has(String(role).toLowerCase()) ? `${S}${is} my ${role}.` : `${S}${is} family.`;
    case 'household': return 'We live under one roof.';
    case 'party': return `We set out together as a party${g.data?.purpose ? `, to ${String(g.data.purpose).replace(/^to /i, '')}` : ''}.`;
    case 'village': return `${S}${is} one of the village.`;
    case 'gang': return `${S}${is} one of us.`;
    default: return `We both belong to ${g.name}.`;
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s) ?? {};
  } catch {
    return {};
  }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
