// Leak check (step 5.5): a citizen's prompt must never contain another citizen's secret goals or a group
// membership this citizen can't know — nor (step 9.5) a death this citizen hasn't witnessed, found or been told of. assertNoLeak() throws; with DEBUG_LEAK_CHECK=true every decision
// prompt is checked and a leak is logged as an error event (the think still runs).

/** Returns a list of leaks (empty = clean). `prompt` is the full text given to citizen `citizenId`. */
export function findLeaks(world, prompt, citizenId) {
  const text = String(prompt ?? '').toLowerCase();
  const viewer = world.citizens.get(citizenId);
  const leaks = [];
  if (!viewer) return leaks;
  for (const o of world.citizens.values()) {
    if (o.id === citizenId) continue;
    const secretAmbitions = world.scheming ? world.scheming.ambitions.of(o.id).filter((a) => a.secrecy === 'secret').map((a) => a.text) : [];
    for (const g of [...(o.persona?.secretGoals ?? []), ...secretAmbitions]) {
      const needle = String(g).trim().toLowerCase();
      if (needle.length >= 12 && text.includes(needle)) leaks.push({ kind: 'secretGoal', of: o.id, text: g });
    }
  }
  const mine = new Set(world.groups.of(citizenId).map((m) => m.group.id));
  for (const g of world.groups.groups.values()) {
    if (g.dissolvedAt || mine.has(g.id)) continue;
    const hiddenMembers = world.groups.membersOf(g.id).filter((m) => !g.public || m.secret);
    if (!hiddenMembers.length) continue;
    // A non-public group's name has no business in an outsider's prompt at all.
    if (!g.public && text.includes(g.name.toLowerCase())) leaks.push({ kind: 'secretGroup', groupId: g.id, text: g.name });
  }
  // step 9.5: a death the viewer doesn't know about (not witnessed, not found and checked, not told) must not be named
  for (const d of world.citizens.values()) {
    if (d.alive || d.id === citizenId || world.deaths?.knows(viewer, d.id)) continue;
    const n = escapeRe(d.name.toLowerCase());
    // statements of the death itself ("Jonas is dead", "Jonas (dead)", "Jonas's body", "the death of Jonas") — not
    // any sentence where the name happens to stand near a word like "death" (a citizen's own words about another death)
    const near = new RegExp(`\\b${n}\\b\\s*(\\(dead|is dead|was dead|has died|died|is gone for good|was killed|lies dead)|\\b(death of|body of|grave of|corpse of|mourn(?:ing)? for|grie(?:f|ving) for|buried|bury)\\s+${n}\\b|\\b${n}['’]s (body|grave|corpse|death|burial|funeral)\\b`, 'i');
    const m = near.exec(text);
    if (m) leaks.push({ kind: 'unknownDeath', of: d.id, text: m[0].slice(0, 80) });
  }
  return leaks;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function assertNoLeak(world, prompt, citizenId) {
  const leaks = findLeaks(world, prompt, citizenId);
  if (leaks.length) throw new Error(`prompt leak for ${citizenId}: ${leaks.map((l) => `${l.kind} "${l.text}"`).join('; ')}`);
}
