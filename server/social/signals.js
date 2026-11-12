// Warning signs (step 5.5): detected in code, no LLM. Each produces a stimulus for whoever notices it and a
// 'signal' relationship event with a reason they can cite later.
//
//   followed    the same non-group person arrived within 5 game minutes after you in >= 3 of your last 4
//               room changes, within 90 game minutes                                   (6)  trust −1
//   property    you see someone carrying something you own that you never gave them     (8)  trust −2
//               …and you had already noticed it missing ("changed story")                    trust −2 extra, once
//   hiding      you saw someone hide a thing in somebody else's home                         trust −1 (−2 if it's yours)
//   intruder    you come home and find someone who isn't household, family or party     (7)  trust −1
//
// Per pair and sign: a cooldown of 60 game minutes; at most −3 trust per game day from signals.
import { ref } from '../memory/index.js';
import { pronounsOf } from '../memory/words.js';

const COOLDOWN = 60;
const DAILY_CAP = 3;
const FOLLOW_WINDOW = 5;
const FOLLOW_SPAN = 90;
const TRAIL = 4;

export class Signals {
  constructor(world) {
    this.world = world;
    this.last = new Map();   // `${a}>${b}|${sign}` -> game time
    this.spent = new Map();  // `${a}>${b}|${day}` -> trust taken today
  }

  /** Fire one sign: stimulus (optional) + relationship event, respecting cooldown and the daily cap. */
  fire(observer, other, sign, { text = null, importance = 6, trust = -1, reason, evidence = {}, force = false }) {
    const now = this.world.now;
    const key = `${observer.id}>${other.id}|${sign}`;
    if (!force && now - (this.last.get(key) ?? -Infinity) < COOLDOWN) return false;
    this.last.set(key, now);
    const dayKey = `${observer.id}>${other.id}|${Math.floor(now / 1440)}`;
    const used = this.spent.get(dayKey) ?? 0;
    const dTrust = -Math.min(Math.abs(trust), Math.max(0, DAILY_CAP - used));
    this.spent.set(dayKey, used + Math.abs(dTrust));
    if (this.spent.size > 5000) this.spent.clear();
    const ev = this.world.logEvent('signal', {
      actorId: observer.id, location: observer.location, otherId: other.id, sign, dTrust, text, ...evidence,
    });
    if (text) {
      this.world.perceive([observer.id], {
        kind: 'signal', text, importance, sourceId: other.id, roomId: observer.location,
        data: { sign, personal: true, eventId: ev.id, ...(evidence.objectId ? { objectId: evidence.objectId } : {}) },
      });
    }
    if (dTrust) {
      this.world.relationships.change(observer.id, other.id, { trust: dTrust }, {
        source: 'signal', reason, evidence: { sign, eventIds: [ev.id], ...(evidence.objectId ? { objectIds: [evidence.objectId] } : {}) },
      });
    }
    this.world.emotions?.onSignal?.(observer, other, sign, evidence);
    return true;
  }

  /** `c` just arrived in `roomId` (walking or put there). */
  onArrive(c, roomId, { walked = true } = {}) {
    const w = this.world;
    const room = w.rooms.get(roomId);
    if (!room) return;
    const now = w.now;
    const awake = (o) => o.activity.type !== 'sleeping' && o.activity.type !== 'collapsed';
    const others = w.citizensIn(roomId, { exceptId: c.id });

    // --- being followed: c arrives shortly after someone else did ---
    if (walked) {
      for (const a of others) {
        const lastEntry = (a.roomLog ?? []).at(-1);
        if (!lastEntry || lastEntry.room !== roomId || now - lastEntry.at > FOLLOW_WINDOW || !awake(a)) continue;
        if (w.groups.isClose(a.id, c.id)) continue;
        lastEntry.followers = [...new Set([...(lastEntry.followers ?? []), c.id])];
        const recent = (a.roomLog ?? []).slice(-TRAIL).filter((e) => now - e.at <= FOLLOW_SPAN);
        const hits = recent.filter((e) => (e.followers ?? []).includes(c.id)).length;
        if (recent.length >= 3 && hits >= 3) {
          this.fire(a, c, 'followed', {
            text: `${ref(c)} has turned up wherever you've gone this past hour.`, importance: 6, trust: -1,
            reason: `${ref(c)} kept turning up wherever I went.`,
          });
        }
        w.saveCitizen(a);
      }
      c.roomLog = [...(c.roomLog ?? []), { room: roomId, at: now, followers: [] }].slice(-TRAIL);
    }

    // --- intruder: c comes home and finds someone who doesn't belong there ---
    const isHome = (room.tags ?? []).includes('private') && (c.home === roomId || room.owner === c.id);
    if (isHome) {
      for (const o of others) {
        if (w.groups.isClose(c.id, o.id) || o.home === roomId) continue;
        this.fire(c, o, 'intruder', {
          text: `${ref(o)} is in your house.`, importance: 7, trust: -1, reason: `I came home and found ${ref(o)} in my house.`,
          evidence: { roomId },
        });
      }
    }
    this.checkProperty(roomId);
  }

  /** Anyone here carrying something that belongs to someone else here who never gave it to them? */
  checkProperty(roomId) {
    const w = this.world;
    const here = w.citizensIn(roomId);
    if (here.length < 2) return;
    for (const holder of here) {
      for (const o of w.objects.carriedBy(holder.id)) {
        const owner = o.ownerId && o.ownerId !== holder.id ? w.citizens.get(o.ownerId) : null;
        if (!owner || owner.location !== roomId || owner.activity.type === 'sleeping' || owner.activity.type === 'collapsed') continue;
        if (w.strangers.gaveIt(owner.id, holder.id, o.id)) continue;
        if (w.groups.shared(owner.id, holder.id, ['family', 'household']).length) continue;
        const thing = o.data?.short ?? w.objects.type(o)?.name ?? 'thing';
        const fired = this.fire(owner, holder, 'property', {
          text: `That's your ${thing} ${ref(holder)} is carrying.`, importance: 8, trust: -2,
          reason: `I saw ${ref(holder)} carrying my ${thing}.`, evidence: { objectId: o.id },
        });
        // "Changed story": they had already noticed it missing. Once per object and holder.
        owner.signalNotes ??= {};
        const noteKey = `${o.id}|${holder.id}`;
        if (fired && owner.missingNoted?.[o.id] != null && !owner.signalNotes[noteKey]) {
          owner.signalNotes[noteKey] = w.now;
          w.saveCitizen(owner);
          this.fire(owner, holder, 'property_missing', {
            trust: -2, force: true, reason: `My ${thing} had gone missing, and then I saw ${ref(holder)} with it.`, evidence: { objectId: o.id },
          });
        }
      }
    }
  }

  /** A concealment seen by others, in a room that is somebody else's home. */
  onConceal(actor, roomId, witnessIds, obj) {
    const w = this.world;
    const room = w.rooms.get(roomId);
    const ownerId = room?.owner ?? null;
    if (!room || !(room.tags ?? []).includes('private') || actor.home === roomId || ownerId === actor.id) return;
    const p = pronounsOf(actor);
    for (const id of witnessIds) {
      const o = w.citizens.get(id);
      if (!o) continue;
      const mine = ownerId === o.id || o.home === roomId;
      this.fire(o, actor, 'hiding', {
        trust: mine ? -2 : -1, evidence: { objectId: obj.id, roomId },
        reason: mine ? `I saw ${ref(actor)} hide something in my own house.` : `I saw ${ref(actor)} hide something in a house that isn't ${p.poss}.`,
      });
    }
  }

  /** Director's "simulate signal" button. */
  simulate({ citizenId, otherId, sign }) {
    const a = this.world.citizens.get(citizenId);
    const b = this.world.citizens.get(otherId);
    if (!a || !b) throw Object.assign(new Error('unknown citizen'), { status: 404 });
    const defs = {
      followed: { text: `${ref(b)} has turned up wherever you've gone this past hour.`, importance: 6, trust: -1, reason: `${ref(b)} kept turning up wherever I went.` },
      intruder: { text: `${ref(b)} is in your house.`, importance: 7, trust: -1, reason: `I came home and found ${ref(b)} in my house.` },
      property: { text: `That's your lantern ${ref(b)} is carrying.`, importance: 8, trust: -2, reason: `I saw ${ref(b)} carrying something of mine.` },
      hiding: { trust: -1, reason: `I saw ${ref(b)} hide something in a house that isn't theirs.` },
    };
    if (!defs[sign]) throw Object.assign(new Error(`sign must be one of ${Object.keys(defs).join(', ')}`), { status: 400 });
    return { fired: this.fire(a, b, sign, { ...defs[sign], force: true }) };
  }
}
