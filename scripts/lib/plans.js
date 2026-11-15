// Step 11.5: the planning calls of a run, read from its database — every `scheme` call and every consolidation whose
// input held a grievance — with the choice, the why, the grievance text and the A1 voice mark. Shared by
// scripts/export-run.js (Part E) and scripts/diagnose-plans.js (A1). Read-only.
import { markVoice } from './voice.js';

const J = (s, d = {}) => { try { return JSON.parse(s); } catch { return d; } };

/** The grievance block of a planning prompt, or null when there was none. */
export function grievanceIn(request) {
  const text = (J(request).messages ?? []).map((m) => String(m.content ?? '')).join('\n');
  const m = /#+ ?(WHAT WAS DONE TO YOU|GRIEVANCES?|WHAT THEY DID TO YOU)[^\n]*\n([\s\S]*?)(?=\n#+ |$)/i.exec(text);
  const body = m?.[2]?.trim();
  return body && !/^\(?(nothing|none)\b/i.test(body) ? body : null;
}

const argsOf = (c) => {
  const tc = J(c.tool_calls, []);
  return tc.map((x) => (typeof x.arguments === 'string' ? J(x.arguments) : x.arguments ?? J(x.function?.arguments))).find(Boolean) ?? J(c.content, {});
};

/** @returns rows { c (the llm_calls row), grievance, choice, why, refused (true when nothing was planned / added), voice } */
export function planningRows(db, from = -1e12, to = 1e12) {
  const cols = db.prepare('PRAGMA table_info(llm_calls)').all().map((x) => x.name);
  const tr = cols.includes('tier_reason') ? 'tier_reason' : 'NULL AS tier_reason';
  const calls = db.prepare(`SELECT id, real_time, game_time, citizen_id, purpose, profile, tier, ${tr}, status, reasoning, content, tool_calls, request, completion_tokens
    FROM llm_calls WHERE purpose IN ('scheme', 'consolidate') AND status = 'ok' AND game_time BETWEEN ? AND ? ORDER BY id`).all(from, to);
  const rows = [];
  for (const c of calls) {
    const grievance = grievanceIn(c.request);
    if (c.purpose === 'consolidate' && !grievance) continue;
    const a = argsOf(c);
    let choice; let why; let refused;
    if (c.purpose === 'scheme') {
      // a plan with a goal and no steps, or no tool call at all, was cut off by the token cap (step 11 logged it as "no plan")
      const cut = !a.choice && !a.no_plan && !(Array.isArray(a.steps) && a.steps.length);
      choice = a.choice ?? (a.no_plan ? 'no_plan' : cut ? `cut off (${c.completion_tokens ?? '?'} tokens${a.goal ? ', goal without steps' : ', no tool call'})` : 'scheme');
      why = a.why ?? a.why_not ?? (a.goal ? `goal: ${a.goal}` : '');
      refused = choice === 'no_plan' || cut || ['let_go', 'wait', 'wait_and_watch'].includes(choice);
    } else {
      const raw = a.ambition_changes ?? [];
      // step 11 shape: { add: [], update: [], achieve: [], abandon: [], transform: [] } (an array of { op } is read too)
      const ch = Array.isArray(raw) ? raw : Object.entries(raw ?? {}).flatMap(([op, arr]) => (Array.isArray(arr) ? arr : []).map((x) => ({ op, text: x.text ?? x.into?.text ?? x.note ?? (x.id != null ? `#${x.id}` : ''), why: x.why ?? x.note ?? '' })));
      choice = ch.length ? ch.map((x) => `${x.op}${x.text ? `: ${x.text}` : ''}`).join(' · ') : 'no ambition change';
      why = ch.map((x) => x.why).filter(Boolean).join(' · ');
      if (a.choice) { choice = a.choice; why = a.why ?? why; } // step 11.5 consolidations may answer a grievance with a choice too
      refused = !ch.some((x) => ['add', 'transform'].includes(x.op));
    }
    rows.push({ c, grievance, choice, why, refused, voice: markVoice(`${why}\n${c.reasoning ?? ''}`) });
  }
  return rows;
}
