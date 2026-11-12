// How one citizen sees another, in words (step 5.5): the relationship, the reasons they could name,
// group tags, and wariness towards strangers. Used by the decision prompt and by reflections.
import { relationSentence, familiarityWord } from '../memory/words.js';
import { STRANGER_FAMILIARITY } from './strangers.js';

/**
 * → { tags: "(your household; from the village)" | '', text: "Someone you know well; … He told you the east passage was safe." }
 */
export function relationLine(world, viewer, other) {
  const rel = world.memory.rel(viewer.id, other.id);
  const tagList = world.groups.tagsFor(viewer, other);
  const tags = tagList.length ? ` (${tagList.join('; ')})` : '';
  const close = world.groups.isClose(viewer.id, other.id);
  const stranger = (rel?.familiarity ?? 0) < STRANGER_FAMILIARITY && !close;
  if (stranger) {
    // Low familiarity: what they look like to you matters more than a relationship you don't have yet.
    const head = rel ? `${cap(familiarityWord(rel.familiarity))}.` : 'A stranger to you.';
    const reasons = rel ? world.relationships.reasons(viewer.id, other.id, 2).filter((e) => e.source !== 'first_impression')
      .map((e) => sentence(world.memory.resolveNames(viewer, e.reason))).join(' ') : '';
    return { tags, text: [head, world.strangers.line(viewer, other), reasons].filter(Boolean).join(' '), stranger: true };
  }
  const why = world.relationships.reasonsText(viewer, other, rel);
  // When every reason has faded, the old summary goes too: the honest "couldn't say why" line stands instead.
  if (why.faded) {
    const base = relationSentence({ ...rel, summary: null }, other);
    return { tags, text: base.replace(/\.$/, ", though you couldn't say exactly why anymore."), stranger: false, faded: true };
  }
  return { tags, text: [relationSentence(rel, other), why.text].filter(Boolean).join(' '), stranger: false };
}

function sentence(s) {
  const t = String(s).trim();
  return /[.!?…"]$/.test(t) ? t : `${t}.`;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
