// Step 11 §3.8: the leak check, generalized from 5.5 to everything secret — secret ambitions, scheme contents, and the
// truths behind standing lies. It runs only on speech by someone who HAS a secret, to someone not already in on it, and
// only if the words mention a person, place or thing involved (a cheap name match first: no match, no call). Purpose
// `leak_check` (local profile when available, else light). An intentional confiding or confession is not a leak.
//   hint → the listener remembers something odd was said;  full → exposed (schemes), caught (lies), known (ambitions)
import { chatForTool } from '../llm.js';
import { ref } from '../memory/index.js';
import { namesIn } from './common.js';

const EVERY_MINUTES = 1;

export class LeakCheck {
  constructor(world) {
    this.world = world;
    this.last = new Map(); // speaker -> game minute of the last call
  }

  /** Secrets this speaker holds that this listener isn't in on: [{ kind, id, text, involved: Set(words) }] */
  secrets(c, listener) {
    const w = this.world;
    const S = w.scheming;
    const out = [];
    const words = (text, ids = []) => {
      const set = new Set(ids.map((id) => w.citizens.get(id)?.name.split(/\s+/)[0].toLowerCase()).filter(Boolean));
      for (const r of w.rooms.values()) if (String(text).toLowerCase().includes(r.name.toLowerCase().replace(/^the /, ''))) set.add(r.name.toLowerCase().replace(/^the /, ''));
      for (const t of w.objects.types.values()) if (new RegExp(`\\b${t.name}\\b`, 'i').test(text)) set.add(t.name.toLowerCase());
      for (const id of namesIn(w, text)) set.add(w.citizens.get(id).name.split(/\s+/)[0].toLowerCase());
      return set;
    };
    for (const a of S.ambitions.of(c.id).filter((x) => x.secrecy === 'secret')) out.push({ kind: 'ambition', id: a.id, text: a.text, involved: words(a.text, a.targetIds) });
    for (const s of [...S.schemes.ownedBy(c), ...S.schemes.joinedBy(c)]) {
      if (s.ownerId === listener.id || s.exposedTo.includes(listener.id) || s.accomplices.some((a) => a.citizen_id === listener.id && ['in', 'wavering'].includes(a.status))) continue;
      // the one behind it is involved too ("Anselm means to…"), unless that is the speaker
      out.push({ kind: 'scheme', id: s.id, text: `${w.memory.resolveNames(c, `{{c:${s.ownerId}}}`)} means to: ${s.goal} (steps: ${s.steps.map((st) => st.text).join('; ')})`, involved: words(`${s.goal} ${s.steps.map((st) => st.text).join(' ')}`, [...s.targetIds, ...(s.ownerId !== c.id ? [s.ownerId] : [])]) });
    }
    for (const l of S.lies.standingOf(c, 10)) {
      out.push({ kind: 'lie', id: l.id, text: `They told people "${l.said}", but the truth is: ${l.truth}`, involved: words(`${l.truth} ${l.said}`, l.aboutIds) });
    }
    return out;
  }

  /** After a line is spoken. Async; never blocks the speech. */
  async check(c, text, hearers, { skip = false } = {}) {
    const w = this.world;
    if (skip || !hearers.length) return;
    if (w.now - (this.last.get(c.id) ?? -Infinity) < EVERY_MINUTES) return;
    const low = String(text).toLowerCase();
    for (const o of hearers) {
      const relevant = this.secrets(c, o).filter((sec) => [...sec.involved].some((word) => word && low.includes(word)));
      if (!relevant.length) continue;
      this.last.set(c.id, w.now);
      let a = null;
      try {
        const tools = [{ type: 'function', function: { name: 'judge', description: 'Did the words give the secret away?', parameters: { type: 'object', properties: {
          leaked: { type: 'string', enum: ['none', 'hint', 'full'] }, which: { type: 'integer', description: 'The number of the secret it gave away (if any).' }, what: { type: 'string' },
        }, required: ['leaked'] } } }];
        const user = `A person holds these secrets:\n${relevant.map((s, i) => `${i + 1}. ${w.memory.resolveNames(c, s.text)}`).join('\n')}\n\nThey just said to someone who doesn't know them: "${text}"\n\nDid these words give a secret away: not at all (none), a hint someone might wonder about (hint), or plainly (full)? Call judge once.`;
        const r = await chatForTool(w.llm, { purpose: 'leak_check', tier: 'none', citizenId: c.id, tools, messages: [{ role: 'user', content: user }] }, 'judge');
        a = r.toolCalls?.find((x) => x.name === 'judge')?.arguments;
      } catch { return; }
      if (!a || a.leaked === 'none' || !['hint', 'full'].includes(a.leaked)) continue;
      const sec = relevant[Math.max(0, Math.min(relevant.length - 1, (Number(a.which) || 1) - 1))];
      const what = String(a.what ?? '').slice(0, 160);
      w.logEvent('leak', { actorId: c.id, to: o.id, kind: sec.kind, id: sec.id, leaked: a.leaked, what });
      if (a.leaked === 'hint') {
        w.memory.add(o.id, { kind: 'episodic', text: `${ref(c)} said something odd${what ? ` — ${what}` : ''}: "${String(text).slice(0, 120)}"`, importance: 4, about: [c.id], placeId: o.location, source: { leak: sec.kind, hint: true } });
        continue;
      }
      if (sec.kind === 'scheme') { const s = w.scheming.schemes.get(sec.id); if (s) w.scheming.schemes.expose(s, o, { how: 'told', from: c.id, reveal: 'full' }); }
      else if (sec.kind === 'lie') { const l = w.scheming.lies.get(sec.id); if (l) w.scheming.lies.caught(l, o, 'let slip'); }
      else w.memory.add(o.id, { kind: 'episodic', text: `${ref(c)} let slip what ${c.persona?.sex === 'female' ? 'she' : c.persona?.sex === 'male' ? 'he' : 'they'} really wants${what ? `: ${what}` : ''}.`, importance: 6, about: [c.id], placeId: o.location, source: { leak: 'ambition', ambitionId: sec.id } });
    }
  }
}
