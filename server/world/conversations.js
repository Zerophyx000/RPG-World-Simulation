// Conversations: lifecycle, persistence and pacing.
//
// conversation = {
//   id, roomId, participants: [ids], everParticipants: [ids],
//   lines: [{ speakerId, toId, text, thought, gameTime, eventId }],
//   startedAt, lastLineAt, sinceTurn: {id: n},
//   held: [{ citizenId, call, queuedAt }],   // decided lines waiting for the reading floor
//   floorUntilReal, floorRemainingMs          // real-time reading floor (ms epoch / frozen remainder while paused)
// }
//
// Kept in memory and saved to world_state['conversations'] on every change, so a
// restart mid-conversation resumes. All activity/stimulus changes go back through World.
import { getState, setState } from '../db.js';
import { IMPORTANCE } from './perception.js';
import { config } from '../config.js';
import { ref } from '../memory/index.js';

export const SOFT_CAP_LINES = 16;
export const HARD_CAP_LINES = 30;
export const SILENCE_END_MINUTES = 30;
export const CUT_IN_EVERY_LINES = 3;
export const TRANSCRIPT_LINES = 12;

export class Conversations {
  constructor(world) {
    this.world = world;
    this.map = new Map();
    this.nextId = 1;
  }

  load() {
    const saved = getState(this.world.db, 'conversations', null);
    this.map.clear();
    if (saved && Array.isArray(saved.list)) {
      this.nextId = saved.nextId ?? 1;
      for (const conv of saved.list) {
        conv.held ??= [];
        conv.floorUntilReal ??= 0;
        this.map.set(conv.id, conv);
      }
    }
  }

  save() {
    setState(this.world.db, 'conversations', { nextId: this.nextId, list: [...this.map.values()] });
  }

  clear() {
    this.map.clear();
    this.save();
  }

  get(id) {
    return id ? this.map.get(id) ?? null : null;
  }

  of(c) {
    return this.get(c?.conversationId);
  }

  list() {
    return [...this.map.values()];
  }

  // Repair after boot: drop participants that no longer exist / point elsewhere; end too-small conversations.
  reconcile() {
    const { citizens } = this.world;
    for (const conv of this.list()) {
      conv.participants = conv.participants.filter((id) => {
        const c = citizens.get(id);
        return c && c.alive && c.conversationId === conv.id && c.location === conv.roomId;
      });
      conv.held = conv.held.filter((h) => conv.participants.includes(h.citizenId));
      if (conv.participants.length < 2) this.end(conv, 'dissolved');
    }
    for (const c of citizens.values()) {
      if (c.conversationId && !this.map.has(c.conversationId)) {
        c.conversationId = null;
        if (c.activity.type === 'talking') this.world.setActivity(c, { type: 'idle' });
        else this.world.saveCitizen(c);
      }
    }
    this.save();
  }

  #create(roomId) {
    const now = this.world.now;
    const conv = {
      id: `conv${this.nextId++}`,
      roomId,
      participants: [],
      everParticipants: [],
      lines: [],
      startedAt: now,
      lastLineAt: now,
      sinceTurn: {},
      held: [],
      floorUntilReal: 0,
      flags: {}, // { high: [ids], learned: [ids] } — feeds the reflection gate
    };
    this.map.set(conv.id, conv);
    return conv;
  }

  #join(conv, c) {
    if (!conv.participants.includes(c.id)) conv.participants.push(c.id);
    if (!conv.everParticipants.includes(c.id)) conv.everParticipants.push(c.id);
    conv.sinceTurn[c.id] = 0;
    c.conversationId = conv.id;
    // A citizen mid-think keeps thinking; a mover is not in the room. Everyone else is now talking.
    if (c.activity.type !== 'thinking' && c.activity.type !== 'moving') {
      this.world.setActivity(c, { type: 'talking', detail: { conversationId: conv.id } });
    } else {
      this.world.saveCitizen(c);
    }
  }

  /**
   * Record a spoken line. Starts / joins conversations as needed.
   * @returns {null | { conv, toId, cutIn: string[] }}  null if the line is not part of any conversation
   *   toId: who the line is effectively addressed to (explicit, or implicitly the last other speaker)
   *   cutIn: participants whose "cut in" turn came up (every few lines)
   */
  recordLine(speaker, text, addressee, { thought = null, eventId = null, volume = 'normal', mark = null } = {}) {
    let conv = this.of(speaker);
    if (addressee) {
      const theirs = this.of(addressee);
      if (theirs && theirs !== conv) {
        if (conv) this.leave(speaker, { reason: 'switched' });
        conv = theirs;
      } else if (!conv) {
        conv = this.#create(speaker.location);
      }
      this.#join(conv, speaker);
      this.#join(conv, addressee);
    }
    if (!conv) return null;

    const now = this.world.now;
    const toId = addressee?.id ?? this.#implicitAddressee(conv, speaker.id);
    conv.lines.push({ speakerId: speaker.id, toId, text, thought: thought || null, gameTime: now, eventId, ...(volume !== 'normal' ? { volume } : {}), ...(mark ? { mark } : {}) }); // step 9: volume for the map; step 11: a director-only mark (lie / confide / confess) — prompts read only the text
    conv.lastLineAt = now;
    this.#setFloor(conv, text);

    const cutIn = [];
    for (const id of conv.participants) {
      if (id === speaker.id || id === toId) {
        conv.sinceTurn[id] = 0;
        continue;
      }
      conv.sinceTurn[id] = (conv.sinceTurn[id] ?? 0) + 1;
      if (conv.sinceTurn[id] >= CUT_IN_EVERY_LINES) {
        conv.sinceTurn[id] = 0;
        cutIn.push(id);
      }
    }
    this.save();
    this.#emit(conv, { line: conv.lines.at(-1) });
    return { conv, toId, cutIn };
  }

  // Called after a line has been perceived, so the cap message arrives after the last line.
  enforceCap(conv) {
    if (conv && this.map.has(conv.id) && conv.lines.length >= HARD_CAP_LINES) this.end(conv, 'cap');
  }

  // Unaddressed line inside a conversation: aimed at whoever spoke last (other than the speaker),
  // or the only other participant.
  #implicitAddressee(conv, speakerId) {
    for (let i = conv.lines.length - 1; i >= 0; i--) {
      const id = conv.lines[i].speakerId;
      if (id !== speakerId && conv.participants.includes(id)) return id;
    }
    return conv.participants.find((id) => id !== speakerId) ?? null;
  }

  // ---------- pacing: the real-time reading floor ----------

  /** The conversation a line by `speaker` (to `addressee`) would land in, if any. */
  targetFor(speaker, addressee) {
    return this.of(speaker) ?? (addressee ? this.of(addressee) : null);
  }

  /** True while the previous line is still "being read" or earlier lines are queued. */
  isFloorBusy(conv) {
    if (!conv || !pacingEnabled()) return false;
    return conv.held.length > 0 || Date.now() < conv.floorUntilReal;
  }

  hold(conv, c, call) {
    conv.held.push({ citizenId: c.id, call, queuedAt: this.world.now });
    this.save();
    this.#emit(conv, {});
  }

  hasHeldLine(c) {
    const conv = this.of(c);
    return Boolean(conv?.held.some((h) => h.citizenId === c.id));
  }

  /** Release at most one held line per conversation whose floor has passed (oldest first). */
  releaseDue(apply) {
    const now = Date.now();
    for (const conv of this.list()) {
      if (!conv.held.length || now < conv.floorUntilReal) continue;
      const next = conv.held.shift();
      this.save();
      apply(next); // applies the say, which sets the next floor
      if (this.map.has(conv.id)) this.#emit(conv, {});
    }
  }

  // Pausing freezes the floor: remember what was left, restore it on resume.
  freezeFloors() {
    const now = Date.now();
    for (const conv of this.list()) conv.floorRemainingMs = Math.max(0, (conv.floorUntilReal ?? 0) - now);
    this.save();
  }

  thawFloors() {
    const now = Date.now();
    for (const conv of this.list()) {
      if (conv.floorRemainingMs != null) conv.floorUntilReal = now + conv.floorRemainingMs;
      delete conv.floorRemainingMs;
    }
    this.save();
  }

  #setFloor(conv, text) {
    if (!pacingEnabled()) return;
    const { charsPerSecond, minSeconds } = config.speech;
    const seconds = Math.max(minSeconds, String(text).length / charsPerSecond) * (this.world.governor?.floorFactor() ?? 1);
    conv.floorUntilReal = Date.now() + seconds * 1000;
  }

  // ---------- leaving / ending ----------

  /** Remove a citizen from their conversation. Ends it if fewer than 2 remain. */
  leave(c, { reason = 'left' } = {}) {
    const conv = this.of(c);
    c.conversationId = null;
    if (c.activity.type === 'talking') this.world.setActivity(c, { type: 'idle' });
    else this.world.saveCitizen(c);
    if (!conv) return;
    conv.participants = conv.participants.filter((id) => id !== c.id);
    this.#dropHeld(conv, (h) => h.citizenId === c.id, 'You stepped away before you could say it.');
    delete conv.sinceTurn[c.id];
    if (conv.participants.length < 2) {
      this.end(conv, reason, { leaverId: c.id });
    } else {
      this.world.perceive(conv.participants, {
        kind: 'system',
        text: `${ref(c)} is no longer part of the conversation.`,
        importance: 4,
        sourceId: c.id,
        roomId: conv.roomId,
      });
      this.save();
      this.#emit(conv, {});
    }
  }

  /** End a conversation: notify remaining participants, log the transcript. */
  end(conv, reason, { leaverId = null } = {}) {
    if (!this.map.has(conv.id)) return;
    this.#dropHeld(conv, () => true, 'You were about to speak, but the conversation is over.');
    this.map.delete(conv.id);
    const { world } = this;
    const leaver = leaverId ? world.citizens.get(leaverId) : null;
    const text = {
      cap: "You've talked yourselves out. The conversation is over.",
      silence: 'Nobody has said anything for a while; the conversation has petered out.',
      left: leaver ? `${ref(leaver)} has ended the conversation with you.` : 'The conversation is over.',
      moved: leaver ? `${ref(leaver)} walked away, so your conversation is over.` : 'The conversation is over.',
    }[reason] ?? 'The conversation is over.';

    const remaining = conv.participants.map((id) => world.citizens.get(id)).filter(Boolean);
    for (const c of remaining) {
      if (c.conversationId === conv.id) c.conversationId = null;
      if (c.activity.type === 'talking') world.setActivity(c, { type: 'idle' });
      else world.saveCitizen(c);
    }
    if (remaining.length) {
      world.perceive(remaining.map((c) => c.id), {
        kind: 'system', text, importance: IMPORTANCE.system, roomId: conv.roomId, data: { conversationId: conv.id },
      });
    }

    const name = (id) => world.citizens.get(id)?.name ?? id;
    const ev = world.logEvent('conversation_end', {
      location: conv.roomId,
      conversationId: conv.id,
      reason,
      participants: conv.everParticipants.map((id) => ({ id, name: name(id) })),
      startedAt: conv.startedAt,
      endedAt: world.now,
      lines: conv.lines.map((l) => ({ ...l, speaker: name(l.speakerId), to: l.toId ? name(l.toId) : null })),
    });
    this.save();
    world.bus.emit('conversation', { id: conv.id, roomId: conv.roomId, ended: true, reason, eventId: ev.id });
    world.onConversationEnd?.(conv, { reason, leaverId }); // reflections (memory/reflect.js)
  }

  // Held lines that can no longer be spoken: tell the would-be speaker, free them up.
  #dropHeld(conv, match, text) {
    const keep = [];
    for (const h of conv.held) {
      if (!match(h)) {
        keep.push(h);
        continue;
      }
      const c = this.world.citizens.get(h.citizenId);
      if (!c) continue;
      this.world.logEvent('action_stale', {
        actorId: c.id, location: c.location, tool: 'say', args: h.call?.arguments, reason: text,
      });
      if (c.activity.type === 'talking' && c.activity.detail?.held) this.world.setActivity(c, { type: 'idle' });
      this.world.perceive([c.id], { kind: 'system', text, importance: 4, roomId: c.location });
    }
    conv.held = keep;
  }

  tick(now) {
    for (const conv of this.list()) {
      if (now - conv.lastLineAt >= SILENCE_END_MINUTES && !conv.held.length) this.end(conv, 'silence');
    }
  }

  /** Public shape for the API/UI (participant names resolved). */
  view(conv) {
    const name = (id) => this.world.citizens.get(id)?.name ?? id;
    return {
      id: conv.id,
      roomId: conv.roomId,
      participants: conv.participants,
      everParticipants: conv.everParticipants,
      startedAt: conv.startedAt,
      lastLineAt: conv.lastLineAt,
      active: true,
      held: conv.held.map((h) => ({ citizenId: h.citizenId })),
      lines: conv.lines.map((l) => ({ ...l, speaker: name(l.speakerId), to: l.toId ? name(l.toId) : null })),
    };
  }

  #emit(conv, extra) {
    this.world.bus.emit('conversation', {
      id: conv.id,
      roomId: conv.roomId,
      participants: conv.participants,
      held: conv.held.map((h) => ({ citizenId: h.citizenId })),
      ended: false,
      ...extra,
    });
  }
}

function pacingEnabled() {
  return config.speech.charsPerSecond > 0;
}
