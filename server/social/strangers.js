// Strangers (step 5.5): wariness from place, personality, visible cues and learned experience.
//
// strangerWariness(citizen, other, room) → 0..10 with its contributing parts. Shown in WHO IS HERE as words
// and reasons for people with familiarity < 2, never as numbers. The first encounter writes a
// 'first_impression' relationship event (Δtrust = (5 − wariness) × 0.4). A citizen's attitude towards
// strangers (data.strangerTrust, 0..1) LEARNS: a stranger who betrays them lowers it, good experiences
// with people met as strangers slowly raise it.
import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_DIR } from '../world/scenarios.js';
import { pronounsOf } from '../memory/words.js';

export const STRANGER_FAMILIARITY = 2;
const BETRAYAL_WINDOW_DAYS = 3;
const GOOD_WINDOW_DAYS = 5;

const PHRASES = [
  [2, 'seems harmless'],
  [4, "a stranger; you're a little guarded"],
  [6, "you're wary of {obj}"],
  [8, 'every instinct says to keep your distance'],
  [10, 'you feel real danger from {obj}'],
];

export class Strangers {
  constructor(world) {
    this.world = world;
    this.cues = loadCues();
    world.relationships.onEvent((ev) => this.#learn(ev));
  }

  reload() {
    this.cues = loadCues();
  }

  isStranger(viewer, other) {
    return (this.world.memory.rel(viewer.id, other.id)?.familiarity ?? 0) < STRANGER_FAMILIARITY;
  }

  /** Visible cues of `other` as `viewer` sees them: [{ key, weight, phrase }] */
  cuesOf(viewer, other) {
    const O = this.world.objects;
    const p = pronounsOf(other);
    const fill = (s, thing = '') => String(s).replace(/\{subj\}/g, p.subj).replace(/\{obj\}/g, p.obj).replace(/\{poss\}/g, p.poss).replace(/\{thing\}/g, thing);
    const out = [];
    for (const tag of other.persona?.appearanceTags ?? []) {
      const cue = this.cues.appearance[tag];
      if (cue) out.push({ key: `tag:${tag}`, weight: cue.weight, phrase: fill(cue.phrase) });
    }
    for (const o of O.carriedBy(other.id)) {
      const type = O.type(o);
      const name = o.data?.short ?? type?.name ?? 'thing';
      if (o.ownerId === viewer.id && !this.gaveIt(viewer.id, other.id, o.id)) {
        out.push({ key: `own:${o.id}`, weight: this.cues.ownObject.weight, phrase: fill(this.cues.ownObject.phrase, name), objectId: o.id });
        continue;
      }
      for (const tag of [...(type?.tags ?? []), ...(o.data?.tags ?? [])]) {
        const cue = this.cues.objectTags[tag];
        if (cue && cue.weight) out.push({ key: `obj:${o.id}:${tag}`, weight: cue.weight, phrase: fill(cue.phrase, `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`) });
      }
    }
    // public group marks carry the group's reputation
    for (const m of this.world.groups.knownMemberships(viewer, other)) {
      const w = Number(m.group.data?.wariness) || 0;
      if (!m.own && w) out.push({ key: `group:${m.group.id}`, weight: w, phrase: fill(w > 0 ? `{subj} is one of ${m.group.name}` : `{subj} is of ${m.group.name}`) });
    }
    return out;
  }

  /** Did `owner` hand this object to `holder` (then carrying it is no warning sign)? */
  gaveIt(ownerId, holderId, objectId) {
    const rows = this.world.db.prepare("SELECT actor_id, after FROM object_history WHERE object_id = ? AND action = 'give' ORDER BY id DESC LIMIT 10").all(objectId);
    return rows.some((r) => r.actor_id === ownerId && safeJson(r.after).holder === holderId);
  }

  /** → { value 0..10, parts: [{ key, weight, phrase? }], phrase, reasons: [phrases] } */
  wariness(viewer, other, room = this.world.rooms.get(viewer.location)) {
    const t = viewer.persona?.traits ?? {};
    const st = viewer.strangerTrust ?? 0.5;
    const danger = Number(room?.danger) || 0;
    const parts = [
      { key: 'base', weight: 3 },
      { key: 'place', weight: danger * 0.5, phrase: danger >= 3 ? 'this is a dangerous place' : null },
      { key: 'agreeableness', weight: (0.5 - (t.agreeableness ?? 0.5)) * 3, phrase: "you don't warm to people easily" },
      { key: 'neuroticism', weight: ((t.neuroticism ?? 0.5) - 0.5) * 3, phrase: 'you are quick to expect the worst' },
      { key: 'openness', weight: -((t.openness ?? 0.5) - 0.5) * 2 },
      ...this.cuesOf(viewer, other),
      { key: 'experience', weight: (0.5 - st) * 4, phrase: st < 0.45 ? "you've been burned by strangers before" : null },
    ];
    const value = Math.min(10, Math.max(0, parts.reduce((s, p) => s + p.weight, 0)));
    const p = pronounsOf(other);
    const phrase = PHRASES.find(([max]) => value <= max)[1].replace(/\{obj\}/g, p.obj);
    const reasons = parts.filter((x) => x.phrase && x.weight >= 0.3).sort((a, b) => b.weight - a.weight).slice(0, 3).map((x) => x.phrase);
    return { value: Math.round(value * 10) / 10, parts: parts.map((x) => ({ ...x, weight: Math.round(x.weight * 100) / 100 })), phrase, reasons };
  }

  /** WHO IS HERE text for a low-familiarity person: "you're wary of him: he keeps his hood up, this is a dangerous place". */
  line(viewer, other) {
    if (!this.isStranger(viewer, other)) return '';
    if (this.world.groups.isClose(viewer.id, other.id)) return '';
    const w = this.wariness(viewer, other);
    const p = pronounsOf(other);
    const S = p.subj[0].toUpperCase() + p.subj.slice(1);
    const head = w.value <= 2 ? `${S} ${w.phrase}` : w.value <= 4 ? `${S} is ${w.phrase}` : cap(w.phrase);
    return `${head}${w.value > 2 && w.reasons.length ? ` — ${w.reasons.join(', ')}` : ''}.`;
  }

  /** First encounter (no relationship row yet): the row and a first_impression event. */
  firstImpression(viewer, other, room) {
    if (this.world.memory.rel(viewer.id, other.id)) return null;
    if (this.world.groups.isClose(viewer.id, other.id)) return null;
    const w = this.wariness(viewer, other, room);
    const p = pronounsOf(other);
    const cues = this.cuesOf(viewer, other).filter((c) => c.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, 2)
      .map((c) => c.phrase.replace(new RegExp(`^${p.subj}('s| is| has)? `, 'i'), ''));
    const how = w.value <= 2 ? 'seemed harmless enough' : w.value >= 7 ? 'everything about ' + p.obj + ' put me on edge' : null;
    const bits = [...cues, how].filter(Boolean);
    const reason = `Met ${p.obj} at ${room?.name ?? 'some place'}${bits.length ? ` — ${bits.join(', ')}` : ''}.`;
    viewer.metStrangers = { ...(viewer.metStrangers ?? {}), [other.id]: this.world.now };
    this.world.saveCitizen(viewer);
    return this.world.relationships.change(viewer.id, other.id, { trust: (5 - w.value) * 0.4 }, {
      source: 'first_impression', reason, evidence: { wariness: w.value, roomId: room?.id ?? null }, quiet: true,
    });
  }

  // Learning from experience (§3.5).
  #learn(ev) {
    if (['seed', 'group', 'first_impression', 'consolidation'].includes(ev.source)) return;
    const c = this.world.citizens.get(ev.citizenId);
    const met = c?.metStrangers?.[ev.otherId];
    if (!c || met == null) return;
    const days = (this.world.now - met) / 1440;
    c.strangerTrust ??= 0.5;
    c.strangerLog ??= [];
    if (ev.dTrust <= -3 && days < BETRAYAL_WINDOW_DAYS) {
      c.strangerTrust = clamp(c.strangerTrust - 0.1);
      c.strangerLog.push({ at: this.world.now, value: c.strangerTrust, why: `betrayed by ${ev.otherId}` });
      this.world.memory.add(c.id, { kind: 'episodic', text: 'I trusted a stranger and regretted it.', importance: 6, about: [ev.otherId], placeId: c.location, source: { strangerTrust: true } });
    } else if (ev.dTrust >= 1 && days < GOOD_WINDOW_DAYS) {
      c.strangerGood = (c.strangerGood ?? 0) + 1;
      if (c.strangerGood >= 3) {
        c.strangerGood = 0;
        c.strangerTrust = clamp(c.strangerTrust + 0.03);
        c.strangerLog.push({ at: this.world.now, value: c.strangerTrust, why: 'strangers have treated me well lately' });
      }
    } else return;
    c.strangerLog = c.strangerLog.slice(-30);
    this.world.saveCitizen(c);
  }
}

function loadCues() {
  const f = path.join(CONTENT_DIR, 'cues.json');
  let raw = {};
  try {
    if (fs.existsSync(f)) raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (err) {
    console.warn(`[content] cues.json unreadable: ${err.message}`);
  }
  return {
    appearance: raw.appearance ?? {},
    objectTags: raw.objectTags ?? {},
    ownObject: raw.ownObject ?? { weight: 4, phrase: "{subj}'s carrying your {thing}" },
  };
}

const clamp = (v) => Math.min(0.95, Math.max(0.05, Math.round(v * 1000) / 1000));
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function safeJson(s) {
  try {
    return JSON.parse(s) ?? {};
  } catch {
    return {};
  }
}
