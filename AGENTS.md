# AGENTS.md

A persistent LLM-driven RPG world: plain Node.js ESM server, SQLite via built-in `node:sqlite`, SSE-driven UI in `public/`, **zero npm dependencies**. The README is the deep reference (architecture, API, all features) — this file holds only the rules you would otherwise get wrong.

## Run and verify

- Node **≥ 22.13** (`engines`). No build step, no tests, no lint, no CI — verification means running it.
- Setup: `cp .env.example .env`. The default `LLM_BASE_URL=http://localhost:4000/v1` points at the mock, so it works out of the box.
- `npm start` · `npm run dev` (auto-restart, watches **`server/` only**) · `npm run mock-llm` (second terminal: fake OpenAI-compatible LLM on :4000 that picks random valid tool calls).
- Never experiment against the default `data/world.db` (it is live world state, gitignored). Use a throwaway world: `DATA_DIR=some/tmp/folder npm start`.
- Mock knobs: `MOCK_DELAY_MS` (5000 to test interrupts), `MOCK_FAIL_RATE`, `MOCK_INVALID_RATE` (exercise retry paths).
- Self-checks (step 9 / 9.5): `node --disable-warning=ExperimentalWarning scripts/checks/<name>.mjs .` (motion, traces-server, visual, death): small scripts with PASS/FAIL lines, throwaway data dirs, no LLM.
- Smoke test: UI at http://localhost:3000 starts paused on day 1 06:00 → resume via `POST /api/clock {"action":"resume"}` or the Resume button.
- `node scripts/export-events.js --format md --day 3 --out day3.md` exports events + LLM reasoning from a db file (read-only; same as the Events tab's Export / `GET /api/export`).
- `node scripts/tokens.js 60` prints per-purpose/profile LLM usage (calls, tokens, duration) for the last N real minutes — quick sanity check without the Usage tab. Read-only, but reads `data/world.db`, so run it from the repo root and don't point it at a throwaway world by accident.

## Hard architecture rules

From README "Rules for future steps"; breaking them breaks invariants the code relies on:

- **All world mutations go through `World`** (`server/world.js` is the single owner of state). Async LLM results never write state directly — they hand an action to World, which validates it first.
- **Every LLM call goes through `world.llm.chat()`** — that is where rate limits, aborts, logging and profile routing live.
- **All time is elapsed game minutes from the clock tick** — never real seconds. Real-time rate changes constantly (pause, speed, quiet speed-up 1×→20×).
- **Citizens never create objects.** `world.objects.change()` is the only write path for existing objects; the room keeper (`server/keeper/`) only *proposes*, code validates against `content/object-types.json` transitions.
- **The observer (`server/observer/`) is wired up in `main.js` only.** Nothing in `server/world/` or `server/agents/` may import it — its output must never reach citizens.

- **The art is code** (step 8): no image, sprite or font files anywhere; `public/art/` draws everything. Modules in `public/art/` must stay DOM-free (the server and Node scripts import them); browser-only code lives in `target.js` (CanvasTarget) and `public/views/`. Citizens never choose spots or tiles: spots are position state owned by World, walking is code.
- Look at the map without a browser: `node scripts/map-shot.js --room bakery --zoom 2 --out shot.png` (a PNG from a running server).

## Persistence and content

- Migrations are forward-only, numbered files in `server/migrations/`. **Never edit one that has already run** — add a new file; data transformations go in a `.js` migration exporting `up(db)`. A backup is written to `data/backups/` before pending migrations run.
- Most citizen/object fields sit in a flexible `data` JSON column — a new property usually needs **no migration**, just a default when reading old rows.
- `content/` seeds only **empty** tables, so content edits don't show in a live world. Exception: rooms are upserted from `rooms.json` on every boot (runtime state kept). To test seeding changes: `POST /api/director/reseed {"confirm":"WIPE","scenario":"village|newcomers"}` (backs up first; dev only).
- The world survives restarts and deploys: state is written continuously, the clock every 5 s. `scripts/deploy.sh` (server only) = `git pull --ff-only` + `systemctl restart agent-world`; shutdown saves, migrations run on next start.

## Quirks

- `.env` is parsed by `server/config.js` (not dotenv); real environment variables win over `.env` values.
- `node:sqlite` is experimental → npm scripts pass `--disable-warning=ExperimentalWarning`; keep that flag when running `node server/main.js` by hand.
- Frontend (`public/`) is plain ES modules with no build step — edit and refresh the browser; `npm run dev` doesn't watch it.
- Thinking capture on GLM/vLLM: `{"reasoning_effort":"low"}` really turns thinking off; `enable_thinking:false` does not (the reasoning just moves into the answer). The `light` tier therefore defaults to thinking off — with thinking on, a 600-token call runs out before the tool call. Empty reasoning box → check the "Thinking test" tab / `LLM_EXTRA_BODY`.
- The 220-char speech limit is enforced in code but deliberately absent from the tool schema — models treat a visible `maxLength` as a target.
