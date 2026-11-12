// Game-time wording shared by prompts and world texts.

export function clockTime(gameMinutes) {
  const m = ((gameMinutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
}

export function timeOfDay(gameMinutes) {
  const h = (((gameMinutes % 1440) + 1440) % 1440) / 60;
  if (h < 4) return 'the middle of the night';
  if (h < 6) return 'the small hours before dawn';
  if (h < 8) return 'early morning';
  if (h < 11) return 'morning';
  if (h < 13) return 'midday';
  if (h < 17) return 'afternoon';
  if (h < 20) return 'evening';
  if (h < 22) return 'late evening';
  return 'night';
}

export function relativeTime(minutesAgo) {
  const m = Math.max(0, minutesAgo);
  if (m < 2) return 'a moment ago';
  if (m < 7) return 'a few minutes ago';
  if (m < 50) return `about ${Math.max(5, Math.round(m / 5) * 5)} minutes ago`;
  if (m < 90) return 'about an hour ago';
  if (m < 60 * 20) return `about ${Math.round(m / 60)} hours ago`;
  const d = Math.max(1, Math.round(m / 1440));
  return `about ${d} day${d > 1 ? 's' : ''} ago`;
}

export function dayNumber(gameMinutes) {
  return Math.floor(gameMinutes / 1440) + 1;
}

/** "It's early morning (06:40)." */
export function nowPhrase(gameMinutes) {
  return `It's ${timeOfDay(gameMinutes)} (${clockTime(gameMinutes)}).`;
}
