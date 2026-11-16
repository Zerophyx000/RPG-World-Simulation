// Step 11.5 (A2): author framing for the planning calls (scheme, ambitions, reflection, and the ambition part of
// consolidation). Instead of "You are Kael…", the model writes as the author of one villager's inner life: true to the
// character, including their worst sides, neither softened nor made worse. The output format does not change — the
// fields are still in the character's own voice, first person.
//
// authorSystemPrompt(world, c): AUTHOR_RULES (static, identical for every call and every citizen, so the server's
// prefix cache keeps working) → the village's common knowledge (static) → the character, in third person → their own
// core memory (first person, labelled as theirs). Decisions keep the second-person system prompt (agents/prompt.js).
import { traitsToWords } from '../agents/traits.js';
import { pronouns } from '../world/citizens.js';
import { traitWords, flawWords } from './traits.js';

export const AUTHOR_RULES = `You are the author of one villager's inner life in a story about a village. The villager is described below. Write what they truly want, feel and plan, in their own voice (first person inside every field you fill in). Stay true to them, including their worst sides. People in this village hold grudges, envy each other, steal, lie and sometimes hurt each other. A story where everyone forgives and talks it out is false to these people. Don't soften the villager, and don't make them worse than they are: a kind person can let a thing go, and a vindictive one can still decide the risk is too high. What they choose comes from who they are and what was done to them.

Only what the villager knows is written below; never use anything else. Never show numbers in their words.`;

// The fixed second-person sentences of agents/traits.js and scheming/traits.js, in third person ("he" form; she / a
// name for others is substituted). Anything not listed goes through a simple fallback.
const THIRD = {
  'You prefer the familiar and distrust new ideas and new ways.': 'He prefers the familiar and distrusts new ideas and new ways.',
  'You are curious about some things, but you like your habits.': 'He is curious about some things, but he likes his habits.',
  'You are curious and imaginative, drawn to new ideas, people and places.': 'He is curious and imaginative, drawn to new ideas, people and places.',
  'You are disorganized and impulsive, and let things slide.': 'He is disorganized and impulsive, and lets things slide.',
  'You are reasonably dependable, though not always tidy or punctual.': 'He is reasonably dependable, though not always tidy or punctual.',
  'You are disciplined and orderly; you keep your word and finish what you start.': 'He is disciplined and orderly; he keeps his word and finishes what he starts.',
  'You are reserved and drained by company; you prefer to be left alone.': 'He is reserved and drained by company; he prefers to be left alone.',
  'You enjoy company in moderation and need time to yourself too.': 'He enjoys company in moderation and needs time to himself too.',
  'You are outgoing and energized by people; silence makes you restless.': 'He is outgoing and energized by people; silence makes him restless.',
  'You are blunt, suspicious and quick to argue; you look out for yourself first.': 'He is blunt, suspicious and quick to argue; he looks out for himself first.',
  'You are fair to people who are fair to you.': 'He is fair to people who are fair to him.',
  'You are kind and trusting, and you avoid conflict when you can.': 'He is kind and trusting, and he avoids conflict when he can.',
  'You are calm and hard to rattle.': 'He is calm and hard to rattle.',
  'You worry sometimes, but you keep your head.': 'He worries sometimes, but he keeps his head.',
  'You are anxious and easily upset; small things prey on your mind.': 'He is anxious and easily upset; small things prey on his mind.',
  "Lying doesn't come easily to you; you've never been good at it, and it gnaws at you when you do.": "Lying doesn't come easily to him; he's never been good at it, and it gnaws at him when he does.",
  "You've always found it easy to say what suits you, true or not.": "He's always found it easy to say what suits him, true or not.",
  "You're good at telling people what they want to hear and at keeping your stories straight.": "He's good at telling people what they want to hear and at keeping his stories straight.",
  "You're no schemer: you say things plainly and you'd trip over a story of your own making.": "He's no schemer: he says things plainly and he'd trip over a story of his own making.",
  'You never forget a wrong; you carry it for years and you mean to see it paid.': 'He never forgets a wrong; he carries it for years and he means to see it paid.',
  'A wrong stays with you a long time.': 'A wrong stays with him a long time.',
  "You don't hold grudges; a wrong fades from you quickly.": "He doesn't hold grudges; a wrong fades from him quickly.",
};

/** A "he" sentence for this citizen: she / her for women; for anyone else the name as subject and they / their. */
function forPerson(text, c) {
  const p = pronouns(c);
  if (p.subj === 'he') return text;
  if (p.subj === 'she') return text.replace(/\bHe\b/g, 'She').replace(/\bhe\b/g, 'she').replace(/\bhimself\b/g, 'herself').replace(/\b(him|his)\b/g, 'her').replace(/\bHis\b/g, 'Her');
  return text.replace(/^He's\b/, `${c.name}'s`).replace(/^He\b/, c.name).replace(/\bhe's\b/g, `${c.name}'s`).replace(/\bhe'd\b/g, `${c.name}'d`).replace(/\bhe\b/g, c.name)
    .replace(/\bhimself\b/g, 'themselves').replace(/\bhim\b/g, 'them').replace(/\bhis\b/g, 'their');
}

/** A second-person sentence in third person (the fixed ones exactly; others by a simple fallback). */
export function toThird(sentence, c) {
  if (THIRD[sentence]) return forPerson(THIRD[sentence], c);
  const he = ` ${sentence}`.replace(/\bYou are\b/g, 'He is').replace(/\byou are\b/g, 'he is').replace(/\bYou're\b/g, "He's").replace(/\byou're\b/g, "he's")
    .replace(/\bYou've\b/g, "He's").replace(/\byou've\b/g, "he's").replace(/\bYou'd\b/g, "He'd").replace(/\byou'd\b/g, "he'd")
    .replace(/\byourself\b/gi, 'himself').replace(/\bYour\b/g, 'His').replace(/\byour\b/g, 'his').replace(/\b(You|you)\b/g, 'him').trim();
  return forPerson(he, c);
}

/** The character sheet, in third person. */
export function characterSheet(world, c) {
  const p = c.persona ?? {};
  const bits = [p.age != null ? `${p.age} years old` : null, p.sex, p.occupation ? `the ${p.occupation}` : null].filter(Boolean);
  const lines = [`${c.name}${bits.length ? `, ${bits.join(', ')}` : ''}.`];
  if (p.appearance) lines.push(`Appearance: ${p.appearance}`);
  const personality = [p.personality, ...traitsToWords(p.traits).map((s) => toThird(s, c)), ...traitWords(c).map((s) => toThird(s, c))].filter(Boolean).join(' ');
  if (personality) lines.push(`Personality: ${personality}`);
  const flaws = flawWords(c).map((x) => x.replace(/^Your faults:/, 'Faults:').replace(/^At your worst:/, 'At worst:'));
  lines.push(...flaws);
  if (p.backstory) lines.push(`Story: ${p.backstory}`);
  const home = world.rooms.get(c.home);
  lines.push(home ? `Home: ${home.name}.` : 'No home here yet.');
  return lines.join('\n');
}

/** The system prompt of a planning call (author framing). */
export function authorSystemPrompt(world, c) {
  const blocks = [`# HOW THIS WORKS\n${AUTHOR_RULES}`];
  if (world.worldText) blocks.push(`# WHAT EVERYONE AROUND HERE KNOWS\n${world.worldText}`);
  blocks.push(`# THE VILLAGER: ${c.name.toUpperCase()}\n${characterSheet(world, c)}`);
  if (c.coreMemory) blocks.push(`# WHAT ${c.name.toUpperCase()} KNOWS ABOUT ${pronouns(c).obj === 'them' ? 'THEMSELVES' : pronouns(c).obj === 'her' ? 'HERSELF' : 'HIMSELF'} (in ${pronouns(c).poss} own words)\n${c.coreMemory}`);
  return blocks.join('\n\n');
}
