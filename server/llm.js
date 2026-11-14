// LLM client for OpenAI-compatible endpoints (school GLM, vLLM, Ollama, llama.cpp, the mock).
// - PROFILES: several endpoints, each with its own concurrency limit (semaphore) and health
// - ROUTES: purpose -> chain of profiles; the first available one wins
// - TIERS: full / light / none set thinking on or off and max_tokens per call
// - abort (interrupts) + per-purpose timeouts (status 'timeout', separate from 'error' and 'aborted')
// - structured output (responseSchema → response_format json_schema) for background tasks
// - captures THINKING separately from the answer, logs every call (incl. profile + tier)
import { config } from './config.js';

// Token caps per tier (full / light / none) come from config: LLM_MAX_TOKENS_FULL/LIGHT/NONE, so an
// operator can tune them without touching code. Heavy background purposes write long tool calls after
// thinking, which is why PURPOSE_FULL_MAX overrides 'full' for them.
export const TIER_MAX_TOKENS = { ...config.llm.maxTokens };
export const PURPOSE_FULL_MAX = { habits: 6000, reflect: 4000, consolidate: 6000, bootstrap: 6000 };
// When a call runs out of tokens without a usable tool call, the retry (thinking off) gets this many.
export const RETRY_MAX = { decide: 600, habits: 3000, reflect: 1500, consolidate: 3000, bootstrap: 3000 };
// Cut-off ladder for citizen decisions (server/agents/think.js): one retry at the next higher cap.
export const CAP_ABOVE = { none: 'light', light: 'full' }; // step A6

/** True if the model ran out of tokens before producing a usable call to `toolName` (or any tool). */
export function ranOut(res, toolName = null) {
  if (res?.finishReason !== 'length') return false;
  const calls = res.toolCalls ?? [];
  const relevant = toolName ? calls.filter((t) => t.name === toolName) : calls;
  return !relevant.length || relevant.some((t) => !t.arguments || '_raw' in t.arguments);
}

/**
 * chat() for one-tool background calls: if the model runs out of tokens while thinking,
 * retry once with thinking off (tier 'none') and a purpose-sized budget.
 */
export async function chatForTool(llm, opts, toolName) {
  const first = await llm.chat(opts);
  if (!ranOut(first, toolName)) return first;
  return llm.chat({ ...opts, tier: 'none', maxTokens: RETRY_MAX[opts.purpose] ?? 1500 });
}
const HEALTH_EVERY_MS = 60_000;
const DEFER_RETRY_MS = 60_000;
const NO_LAST_RESORT = new Set(['score']); // local-only helpers: callers use a code fallback instead

class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  // Resolves when a slot is free. Rejects (without taking a slot) if `signal` aborts while queued.
  async acquire(signal) {
    signal?.throwIfAborted();
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise((resolve, reject) => {
      const entry = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = this.queue.indexOf(entry);
        if (i !== -1) this.queue.splice(i, 1);
        reject(signal.reason ?? new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
    });
    this.active++;
  }
  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
  get waiting() {
    return this.queue.length;
  }
}

// Some servers return thinking in a separate field, others inline as <think>...</think>.
function splitThinking(message) {
  let reasoning = message.reasoning_content ?? message.reasoning ?? null;
  let content = message.content ?? '';
  const match = typeof content === 'string' && content.match(/<think>([\s\S]*?)<\/think>/);
  if (match) {
    reasoning = [reasoning, match[1].trim()].filter(Boolean).join('\n');
    content = content.replace(match[0], '').trim();
  }
  return { reasoning, content };
}

export class LLM {
  constructor(db, bus, getGameTime) {
    this.db = db;
    this.bus = bus;
    this.getGameTime = getGameTime;
    this.profiles = new Map();
    for (const p of Object.values(config.llm.profiles)) {
      this.profiles.set(p.name, { ...p, sem: new Semaphore(p.maxConcurrent), available: true, checkedAt: null, lastError: null });
    }
    this.routes = config.llm.routes;
    this.byPurpose = new Map();
    this.warned = new Set();
    this.routeFilter = null; // (purpose, chain) => chain; the governor narrows routes under budget pressure
    this.insert = db.prepare(`INSERT INTO llm_calls
      (real_time, game_time, citizen_id, purpose, model, request, reasoning, content, tool_calls,
       status, error, duration_ms, prompt_tokens, completion_tokens, profile, tier, finish_reason, tier_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.healthTimer = setInterval(() => this.healthCheck(), HEALTH_EVERY_MS);
    this.healthTimer.unref?.();
    setTimeout(() => this.healthCheck(), 1000).unref?.();
  }

  stop() {
    clearInterval(this.healthTimer);
  }

  // ---------- routing ----------
  /** Profile names for a purpose, in order. Profiles not configured are permanently unavailable (skipped). */
  routeFor(purpose) {
    const chain = (this.routes[purpose] ?? [this.profiles.keys().next().value]).filter((name) => this.profiles.has(name));
    return this.routeFilter ? this.routeFilter(purpose, chain) : chain;
  }

  /** True if some profile on this purpose's route is up right now (callers pick a cheaper path otherwise). */
  isAvailable(purpose) {
    return this.routeFor(purpose).some((n) => this.profiles.get(n).available);
  }

  activeFor(purpose) {
    return this.byPurpose.get(purpose) ?? 0;
  }

  stats() {
    let active = 0;
    let waiting = 0;
    let max = 0;
    for (const p of this.profiles.values()) {
      active += p.sem.active;
      waiting += p.sem.waiting;
      max += p.sem.max;
    }
    return { active, waiting, maxConcurrent: max, profiles: this.profilesView() };
  }

  profilesView() {
    return [...this.profiles.values()].map((p) => ({
      name: p.name, baseUrl: p.baseUrl, model: p.model, available: p.available, checkedAt: p.checkedAt,
      lastError: p.lastError, active: p.sem.active, waiting: p.sem.waiting, maxConcurrent: p.sem.max,
      thinkingOff: p.thinking.none != null,
    }));
  }

  async healthCheck() {
    await Promise.all([...this.profiles.values()].map(async (p) => {
      try {
        const res = await fetch(`${p.baseUrl}/models`, {
          headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {},
          signal: AbortSignal.timeout(10_000),
        });
        p.available = res.ok;
        p.lastError = res.ok ? null : `GET /models → HTTP ${res.status}`;
      } catch (err) {
        p.available = false;
        p.lastError = err.cause?.code ?? err.message;
      }
      p.checkedAt = new Date().toISOString();
    }));
    this.bus.emit('llm_profiles', this.profilesView());
  }

  // ---------- the call ----------
  /**
   * @param {object} opts
   * @param {Array}  opts.messages
   * @param {Array} [opts.tools]
   * @param {string} opts.purpose          decides the route (profile chain) and timeout
   * @param {'full'|'light'|'none'} [opts.tier]  thinking on/off + max_tokens
   * @param {number} [opts.maxTokens]      overrides the tier's max_tokens
   * @param {string} [opts.tierReason]     step 10 (0.1): why a decide call runs at its tier (llm_calls.tier_reason)
   * @param {object} [opts.responseSchema] { name, schema } → structured JSON output (result.json)
   * @param {string} [opts.citizenId]
   * @param {AbortSignal} [opts.signal]
   * @param {object} [opts.params]         extra request params
   * @returns {Promise<{reasoning, content, toolCalls, usage, finishReason, json, profile, tier, callId}>}
   */
  async chat(opts) {
    const { purpose, signal } = opts;
    const chain = this.routeFor(purpose);
    if (!chain.length) throw unavailable(purpose, 'no configured profile on its route');
    const tried = new Set();
    for (;;) {
      signal?.throwIfAborted();
      const name = chain.find((n) => this.profiles.get(n).available && !tried.has(n));
      if (!name) {
        if (config.llm.deferrable.includes(purpose)) {
          // Deferrable background work waits until something on its route comes back.
          await sleep(DEFER_RETRY_MS, signal);
          await this.healthCheck();
          tried.clear();
          continue;
        }
        // Last resort for citizen-facing work: the health check may be stale, try the first profile anyway.
        if (!NO_LAST_RESORT.has(purpose) && !tried.has(chain[0])) {
          tried.add(chain[0]);
          return this.#call(this.profiles.get(chain[0]), opts);
        }
        throw unavailable(purpose, 'every profile on its route is down');
      }
      tried.add(name);
      const profile = this.profiles.get(name);
      try {
        return await this.#call(profile, opts);
      } catch (err) {
        if (err.code !== 'connection') throw err;
        profile.available = false; // can't connect: skip it until the next successful health check
        profile.lastError = err.message;
      }
    }
  }

  #thinkingFor(profile, tier) {
    if (!tier) return {};
    if (tier === 'none' && profile.thinking.none == null) {
      if (!this.warned.has(profile.name)) {
        this.warned.add(profile.name);
        console.warn(`[llm] profile "${profile.name}" can't switch thinking off: tier "none" runs like "light" with max_tokens ${TIER_MAX_TOKENS.none}`);
      }
      return profile.thinking.light ?? profile.thinking.full ?? {};
    }
    return (tier === 'full' ? profile.thinking.full : tier === 'light' ? profile.thinking.light : profile.thinking.none) ?? {};
  }

  async #call(profile, { messages, tools, purpose, citizenId = null, signal, params = {}, tier = null, tierReason = null, maxTokens = null, responseSchema = null }) {
    const body = {
      model: profile.model,
      messages,
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
      ...profile.extraBody,
      ...this.#thinkingFor(profile, tier),
      ...(maxTokens || tier ? { max_tokens: maxTokens ?? (tier === 'full' && PURPOSE_FULL_MAX[purpose] ? PURPOSE_FULL_MAX[purpose] : TIER_MAX_TOKENS[tier]) } : {}),
      ...(responseSchema ? { response_format: { type: 'json_schema', json_schema: { name: responseSchema.name, schema: responseSchema.schema, strict: true } } } : {}),
      ...params,
    };

    await profile.sem.acquire(signal); // aborted while queued = never sent, nothing to log
    this.byPurpose.set(purpose, this.activeFor(purpose) + 1);
    const started = Date.now();
    const gameTime = this.getGameTime();
    const timeoutMs = config.llm.timeouts[purpose] ?? config.llm.timeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    let result = null;
    let status = 'ok';
    let error = null;

    try {
      const signals = [timeoutSignal];
      if (signal) signals.push(signal);
      let res;
      try {
        res = await fetch(`${profile.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.any(signals),
        });
      } catch (err) {
        if (!signal?.aborted && !timeoutSignal.aborted) throw Object.assign(new Error(`can't reach ${profile.name}: ${err.cause?.code ?? err.message}`), { code: 'connection' });
        throw err;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
      }

      const json = await res.json();
      const choice = json.choices?.[0] ?? {};
      const message = choice.message ?? {};
      const { reasoning, content } = splitThinking(message);
      result = {
        reasoning,
        content,
        toolCalls: (message.tool_calls ?? []).map((tc) => ({
          id: tc.id,
          name: tc.function?.name,
          arguments: safeParse(tc.function?.arguments),
        })),
        usage: json.usage ?? null,
        finishReason: choice.finish_reason ?? null,
        json: responseSchema ? parseJsonContent(content) : null,
        profile: profile.name,
        tier,
      };
      return result;
    } catch (err) {
      status = signal?.aborted ? 'aborted' : timeoutSignal.aborted ? 'timeout' : 'error';
      error = status === 'timeout' ? `timed out after ${timeoutMs} ms` : err.message;
      if (status === 'timeout') throw Object.assign(new Error(error), { code: 'timeout' });
      throw err;
    } finally {
      profile.sem.release();
      this.byPurpose.set(purpose, this.activeFor(purpose) - 1);
      this.#log({ gameTime, citizenId, purpose, body, messages, tools, result, status, error, started, profile: profile.name, tier, tierReason });
    }
  }

  #log({ gameTime, citizenId, purpose, body, messages, tools, result, status, error, started, profile, tier, tierReason = null }) {
    try {
      const info = this.insert.run(
        new Date().toISOString(), gameTime, citizenId, purpose, body.model,
        JSON.stringify({ messages, tools, ...(body.max_tokens ? { max_tokens: body.max_tokens } : {}) }),
        result?.reasoning ?? null, result?.content ?? null,
        result ? JSON.stringify(result.toolCalls) : null,
        status, error, Date.now() - started,
        result?.usage?.prompt_tokens ?? null, result?.usage?.completion_tokens ?? null,
        profile, tier, result?.finishReason ?? null, tierReason,
      );
      if (result) result.callId = Number(info.lastInsertRowid);
      this.bus.emit('llm', {
        id: Number(info.lastInsertRowid), citizenId, purpose, status, durationMs: Date.now() - started, profile, tier, tierReason,
        outputTokens: result?.usage?.completion_tokens ?? 0, inputTokens: result?.usage?.prompt_tokens ?? 0,
      });
    } catch (err) {
      // e.g. the DB was already closed during shutdown; never let logging mask the call's own outcome
      console.warn(`[llm] could not log call: ${err.message}`);
    }
  }
}

function unavailable(purpose, why) {
  return Object.assign(new Error(`no LLM available for "${purpose}": ${why}`), { code: 'unavailable' });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    }, { once: true });
  });
}

function safeParse(s) {
  if (typeof s !== 'string') return s ?? {};
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

function parseJsonContent(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    const m = String(s).match(/\{[\s\S]*\}/);
    try {
      return m ? JSON.parse(m[0]) : null;
    } catch {
      return null;
    }
  }
}
