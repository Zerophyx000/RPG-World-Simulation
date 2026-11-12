// Relationship numbers → words. Citizens never see numbers about how they feel.

export function affinityWord(a) {
  if (a <= -4) return 'hate';
  if (a <= -2) return 'dislike';
  if (a < -0.5) return 'are cool towards';
  if (a < 0.5) return 'feel nothing much either way about';
  if (a < 2) return 'like';
  if (a < 4) return 'are fond of';
  return 'love';
}

export function trustWord(t) {
  if (t <= -4) return "wouldn't trust them as far as you could throw them";
  if (t <= -2) return "don't trust them";
  if (t < -0.5) return 'are wary of them';
  if (t < 0.5) return null; // nothing to say
  if (t < 2) return 'trust them a little';
  if (t < 4) return 'trust them';
  return 'trust them completely';
}

export function familiarityWord(f) {
  if (f < 0.3) return 'a stranger to you';
  if (f < 1.5) return "someone you've only just met";
  if (f < 4) return 'an acquaintance';
  if (f < 7) return 'someone you know fairly well';
  return 'someone you know well';
}

/**
 * "You know her well and like her, but you don't trust her. 'She'd sell her own mother a stale loaf.'"
 * Pronouns come from the other person's persona.
 */
export function relationSentence(rel, other) {
  if (!rel) return 'A stranger to you.';
  const p = pronounsOf(other);
  const fam = familiarityWord(rel.familiarity);
  const aff = affinityWord(rel.affinity);
  const tr = trustWord(rel.trust);
  const objFix = (s) => s.replace(/\bthem\b/g, p.obj);
  let s = `${cap(fam)}; you ${aff} ${p.obj}`;
  if (tr) s += `${rel.affinity >= 0.5 && rel.trust < 0 ? ', but you' : ' and you'} ${objFix(tr)}`;
  s += '.';
  if (rel.summary) s += ` "${rel.summary}"`;
  return s;
}

export function pronounsOf(o) {
  const sex = String(o?.persona?.sex ?? '').toLowerCase();
  if (sex.startsWith('f')) return { subj: 'she', obj: 'her', poss: 'her' };
  if (sex.startsWith('m')) return { subj: 'he', obj: 'him', poss: 'his' };
  return { subj: 'they', obj: 'them', poss: 'their' };
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
