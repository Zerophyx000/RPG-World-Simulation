// Loads .env (if present) and exposes typed config with defaults.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Real environment variables win over .env
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));

const env = (key, fallback) => (process.env[key] === undefined || process.env[key] === '' ? fallback : process.env[key]);
const num = (key, fallback) => Number(env(key, fallback));

function parseJson(key) {
  const raw = env(key, '');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`[config] ${key} is not valid JSON, ignoring it`);
    return {};
  }
}

// Like parseJson, but returns `fallback` when the variable is not set at all (null = "not configured").
function parseJsonOr(key, fallback) {
  const raw = env(key, '');
  if (!raw) return fallback;
  if (raw.toLowerCase() === 'none') return null;
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`[config] ${key} is not valid JSON, ignoring it`);
    return fallback;
  }
}

// ---------- LLM profiles ----------
// LLM_PROFILES=school,local  →  LLM_SCHOOL_BASE_URL, LLM_SCHOOL_MODEL, ... per profile.
// Without LLM_PROFILES the old single LLM_* block becomes a profile called "school".
// Thinking switches per tier (merged into the request body):
//   *_THINKING_ON (full), *_THINKING_LIGHT (light; default = OFF, see README), *_THINKING_OFF (none; "none" = can't switch off)
// Measured on the school GLM: {"reasoning_effort":"low"} really switches thinking off, while
// {"chat_template_kwargs":{"enable_thinking":false}} only moves the reasoning into the answer text.
const DEFAULT_THINKING_OFF = { reasoning_effort: 'low' };

function legacyProfile() {
  const off = parseJsonOr('LLM_THINKING_OFF', DEFAULT_THINKING_OFF);
  return {
    name: 'school',
    baseUrl: env('LLM_BASE_URL', 'http://localhost:4000/v1').replace(/\/+$/, ''),
    apiKey: env('LLM_API_KEY', ''),
    model: env('LLM_MODEL', 'glm-5.3'),
    maxConcurrent: num('LLM_MAX_CONCURRENT', 8),
    extraBody: parseJson('LLM_EXTRA_BODY'),
    thinking: { full: parseJsonOr('LLM_THINKING_ON', {}), light: parseJsonOr('LLM_THINKING_LIGHT', off), none: off },
  };
}

function loadProfiles() {
  const names = env('LLM_PROFILES', '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!names.length) return { school: legacyProfile() };
  const out = {};
  for (const name of names) {
    const P = `LLM_${name.toUpperCase()}_`;
    // the school profile falls back to the old LLM_* variables
    const legacy = name === 'school' ? legacyProfile() : null;
    const off = parseJsonOr(`${P}THINKING_OFF`, legacy ? legacy.thinking.none : null);
    out[name] = {
      name,
      baseUrl: env(`${P}BASE_URL`, legacy?.baseUrl ?? '').replace(/\/+$/, ''),
      apiKey: env(`${P}API_KEY`, legacy?.apiKey ?? ''),
      model: env(`${P}MODEL`, legacy?.model ?? ''),
      maxConcurrent: num(`${P}MAX_CONCURRENT`, legacy?.maxConcurrent ?? 2),
      extraBody: parseJsonOr(`${P}EXTRA_BODY`, legacy?.extraBody ?? {}) ?? {},
      thinking: { full: parseJsonOr(`${P}THINKING_ON`, {}) ?? {}, light: parseJsonOr(`${P}THINKING_LIGHT`, off), none: off },
    };
    if (!out[name].baseUrl) console.warn(`[config] profile "${name}" has no ${P}BASE_URL`);
  }
  return out;
}

const DEFAULT_ROUTES = {
  decide: ['school'], habits: ['school'], reflect: ['school'], consolidate: ['school'], bootstrap: ['school'],
  observer: ['local', 'school'], director_text: ['local', 'school'], score: ['local'], test: ['school'],
  keeper: ['local', 'school'], // step 5: the room keeper (falls back to code rules when nothing is up)
  persona_traits: ['school'], ambitions: ['school'], scheme: ['school'], leak_check: ['local', 'school'], // step 11
};

// DATA_DIR lets tests or a second world run against another folder.
const dataDir = path.resolve(ROOT, env('DATA_DIR', 'data'));

export const config = {
  // step 10 (0.5): 'live' = the world meant to last. It refuses to start under --watch (npm run dev), so half-written code
  // and new migrations never reach it while someone is editing server/. Update it only through scripts/deploy.sh.
  worldRole: env('WORLD_ROLE', 'dev') === 'live' ? 'live' : 'dev',
  port: num('PORT', 3000),
  host: env('HOST', '0.0.0.0'),
  dataDir,
  dbFile: path.join(dataDir, 'world.db'),
  publicDir: path.join(ROOT, 'public'),
  migrationsDir: path.join(ROOT, 'server', 'migrations'),

  llm: {
    // legacy single-endpoint view (thinking test, scripts); the real routing uses `profiles`
    baseUrl: env('LLM_BASE_URL', 'http://localhost:4000/v1').replace(/\/+$/, ''),
    apiKey: env('LLM_API_KEY', ''),
    model: env('LLM_MODEL', 'glm-5.3'),
    maxConcurrent: num('LLM_MAX_CONCURRENT', 8),
    timeoutMs: num('LLM_TIMEOUT_MS', 120000),
    extraBody: parseJson('LLM_EXTRA_BODY'),
    profiles: loadProfiles(),
    routes: { ...DEFAULT_ROUTES, ...parseJson('LLM_ROUTES') },
    timeouts: { observer: 300000, consolidate: 240000, keeper: 60000, ...parseJson('LLM_TIMEOUTS') }, // purpose -> ms
    deferrable: ['observer', 'director_text'],      // queued and retried when no profile is up
    // Output-token caps per tier: full/light are roomy enough for thinking + a tool call, 'none' stays tiny.
    maxTokens: { full: num('LLM_MAX_TOKENS_FULL', 3000), light: num('LLM_MAX_TOKENS_LIGHT', 1000), none: num('LLM_MAX_TOKENS_NONE', 300) },
  },

  // Step 7B: body, injuries, illness and death.
  body: {
    lethal: env('LETHAL', 'true') !== 'false',            // false: dying means permanent unconsciousness (debugging)
    healTimeScale: num('HEAL_TIME_SCALE', 1.0),           // 1 = realistic; 0.1 = ten times faster
    illnessRate: num('ILLNESS_RATE', 0.5),                // infections, fevers, chills
    accidentRate: num('ACCIDENT_RATE', 1.0),
    criticalGraceMinutes: num('CRITICAL_GRACE_MINUTES', 15), // 0 = fully realistic bleeding
    criticalSlowdown: num('CRITICAL_SLOWDOWN', 1.0),      // < 1: the clock runs slower while a critical window is open
    emergencySlowdown: num('EMERGENCY_SLOWDOWN', 1.0),    // step 10: < 1: slower while a fight is on or a room with people in it burns
  },

  // Step 8: spots. Walking between spots before an action that needs proximity (SPOT_WALKING=false: act from where you stand; tests).
  spots: { walking: env('SPOT_WALKING', 'true') !== 'false' },

  // Token budget governor: output tokens per rolling real hour, per profile (0 = off).
  governor: {
    budgetPerHour: num('TOKEN_BUDGET_OUTPUT_PER_HOUR', 1000000), // step 9.5: 1M
    profiles: env('GOVERNOR_PROFILES', 'school').split(',').map((s) => s.trim()).filter(Boolean),
  },

  observer: {
    minIntervalSeconds: num('OBSERVER_MIN_INTERVAL_REAL_SECONDS', 180),
    conversationsPerCitizens: num('OBSERVER_CONVERSATIONS_PER_CITIZENS', 10),
  },

  clock: {
    dayLengthRealMinutes: num('DAY_LENGTH_REAL_MINUTES', 45),
  },

  // Real-time reading floor for conversations: the next line in a conversation is held
  // until the previous one could have been read. SPEECH_CHARS_PER_SECOND=0 disables it.
  // Automatic speed-up while the whole village is asleep or busy (world/quiet.js).
  quiet: {
    enabled: env('QUIET_SPEEDUP', 'true') !== 'false',
    maxSpeed: num('QUIET_MAX_SPEED', 20),
  },

  // Starting scenario (content/scenarios/<id>), used when seeding an empty world and by reseed.
  scenario: env('SCENARIO', 'village'),

  speech: {
    charsPerSecond: num('SPEECH_CHARS_PER_SECOND', 15),
    minSeconds: num('SPEECH_MIN_SECONDS', 2),
  },

  // step A6: every addressed speech decision is expected at tier full; true also console.warns a violation.
  debug: {
    tierCheck: env('DEBUG_TIER_CHECK', 'false') === 'true',
  },
};
