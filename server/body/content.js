// Step 7B: body content (content/body.json, conditions.json, bleeding.json, damage.json, ...) loaded once.
// Parts are expanded for each side and linked (parent / children / region / headMult).
import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_DIR } from '../world/scenarios.js';

const read = (f, fallback = {}) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, f), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[body] ${f} unreadable: ${err.message}`);
    return fallback;
  }
};

export function loadBodyContent() {
  const raw = read('body.json');
  const parts = new Map();
  for (const [key, p] of Object.entries(raw.parts ?? {})) {
    for (const side of p.sides ?? [null]) {
      const sub = (s) => (typeof s === 'string' && side ? s.replaceAll('{side}', side) : s);
      const id = sub(key);
      parts.set(id, {
        ...p, id, side, sides: undefined,
        label: sub(p.label), parent: sub(p.parent) ?? null, region: sub(p.region),
        under: (p.under ?? []).map(sub), hitWeight: p.hitWeight ?? 0, maxHealth: p.maxHealth ?? 10,
        bleedFactor: p.bleedFactor ?? raw.defaults?.bleedFactor ?? 1, vessels: p.vessels ?? raw.defaults?.vessels ?? {},
        headMult: sub(p.region) === 'head' ? raw.headMultiplier ?? 1.5 : 1, children: [],
      });
    }
  }
  for (const p of parts.values()) if (p.parent) parts.get(p.parent)?.children.push(p.id);
  const regions = {};
  for (const p of parts.values()) (regions[p.region] ??= []).push(p.id);

  const content = {
    parts, regions, raw,
    types: read('conditions.json').types ?? {},
    bleeding: read('bleeding.json'),
    damage: read('damage.json'),
    treatments: read('treatments.json'),
    accidents: read('accidents.json'),
    /** All descendants of a part (by parent links). */
    descendants(id) {
      const out = [];
      const stack = [...(parts.get(id)?.children ?? [])];
      while (stack.length) {
        const x = stack.pop();
        out.push(x);
        stack.push(...(parts.get(x)?.children ?? []));
      }
      return out;
    },
    /** A region name ("left_arm"), a side-less group ("head") or a part id → part ids. */
    resolveParts(name) {
      if (parts.has(name)) return [name];
      const alias = { arm_left: 'left_arm', arm_right: 'right_arm', leg_left: 'left_leg', leg_right: 'right_leg' }[name] ?? name;
      return regions[alias] ? [...regions[alias]] : [];
    },
    typeDef(type) {
      return this.types[type] ?? null;
    },
    /** Which limb kind: 'arm' | 'leg' | null. */
    limbOf(partId) {
      const r = parts.get(partId)?.region ?? '';
      return r.endsWith('_arm') ? 'arm' : r.endsWith('_leg') ? 'leg' : null;
    },
    isLeg(partId) {
      return this.limbOf(partId) === 'leg';
    },
    partLabel(partId) {
      return parts.get(partId)?.label ?? String(partId ?? 'body').replace(/_/g, ' ');
    },
  };
  return content;
}

/** [[max, text]] table lookup by severity. */
export function bySeverity(table, sev) {
  if (!Array.isArray(table) || !table.length) return '';
  for (const [max, text] of table) if (sev <= max) return text;
  return table.at(-1)[1];
}

/** Crawling takes this many times as long as walking (and tires three times as fast). */
export const CRAWL_FACTOR = 6;

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
