// Big Five traits (0–1) → words for the prompt. Three bands per trait.
// Nothing else reads the numbers yet; STEP 5 (emotions) will.

const BANDS = {
  openness: [
    'You prefer the familiar and distrust new ideas and new ways.',
    'You are curious about some things, but you like your habits.',
    'You are curious and imaginative, drawn to new ideas, people and places.',
  ],
  conscientiousness: [
    'You are disorganized and impulsive, and let things slide.',
    'You are reasonably dependable, though not always tidy or punctual.',
    'You are disciplined and orderly; you keep your word and finish what you start.',
  ],
  extraversion: [
    'You are reserved and drained by company; you prefer to be left alone.',
    'You enjoy company in moderation and need time to yourself too.',
    'You are outgoing and energized by people; silence makes you restless.',
  ],
  agreeableness: [
    'You are blunt, suspicious and quick to argue; you look out for yourself first.',
    'You are fair to people who are fair to you.',
    'You are kind and trusting, and you avoid conflict when you can.',
  ],
  neuroticism: [
    'You are calm and hard to rattle.',
    'You worry sometimes, but you keep your head.',
    'You are anxious and easily upset; small things prey on your mind.',
  ],
};

export function band(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return 1;
  if (v < 0.35) return 0;
  if (v > 0.65) return 2;
  return 1;
}

export function traitsToWords(traits = {}) {
  return Object.keys(BANDS).map((t) => BANDS[t][band(traits[t] ?? 0.5)]);
}
