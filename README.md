# Agent World

A persistent RPG world where LLM-driven citizens live, think, remember, fight and die.

**Step 5 (this version): room state, objects and the room keeper.** Rooms now hold real objects with a state and a place: a ground truth that stays put whether anyone watches or not. Citizens see only what they'd plausibly notice (a surface view), can examine, search, take, put (openly or hidden), give and use things, and carry up to two. A narrow LLM, the room keeper, proposes what a free-form "use" does; code checks every proposal. Citizens never create objects. When they come back, they notice what changed ("there are fewer flour sacks by the oven than when you last looked").

**Step 4: memory, relationships, and built to scale.** Citizens remember (subjective first-person memories, a core self-image, "on my mind"), have directed relationships, only know names they've heard, reflect after conversations (gated so it scales), and consolidate their day in their sleep. On the scale side: model profiles with routing (school GLM + optional local model), tiered thinking, day plans carried out by code, a token budget governor, batched observer runs and a Usage tab.

**Step 3: needs, status and finding your way.** Citizens get a body (hunger, fatigue, health with graded levels they only notice when a level is crossed), places serve food and beds, and most newcomers don't know where anything is: they have to explore or ask. Director events can now *do* things through composable effects. The clock speeds up by itself when everyone sleeps.

**Step 2.5: dialogue fixes, director events v2, conversation pacing, the observer UI.** Short conversational turns, rare interrupts, located events with lasting effects, real-time reading pace, and a UI with a roster, chat panels with thoughts, a timeline, a relationship graph and storylines.

**Step 2: citizens, rooms and the thinking loop.** Five LLM citizens live in a small village of rooms. They perceive what happens around them, think, and act through tool calls (move, speak, do, wait). The director (you) can inject events. Built on step 1: game clock, persistence, migrations, live UI, and an LLM client that captures the model's thinking.

## Stack (deliberately minimal)

| Part | Choice | Why |
|---|---|---|
| Backend | Node.js 22.13+, plain JavaScript, **zero npm dependencies** | Same language as the frontend, nothing to install or break, easy for AI to work on |
| Database | SQLite via Node's built-in `node:sqlite` | One file (`data/world.db`), crash-safe (WAL), trivial backups |
| Live updates | Server-Sent Events | Built into browsers and Node, no WebSocket library needed |
| Frontend | Plain HTML/CSS/JS modules, no build step | Edit a file, refresh the browser |
| LLM | Any OpenAI-compatible API | School GLM, vLLM, Ollama, llama.cpp, or the included mock |

Everything lives in this one folder:

```
agent-world/
├── server/
│   ├── main.js          start, graceful shutdown
│   ├── config.js        reads .env
│   ├── db.js            SQLite + migrations + backups
│   ├── clock.js         continuous game clock (pause/speed, persisted)
│   ├── world.js         single owner of world state; wires the modules below together
│   ├── world/           rooms, citizens, needs, places, perception, actions, conversations, director, quiet, scenarios,
│   │                    objects (ground truth + surface view), object-actions (take/put/give/examine/search/use)
│   ├── keeper/          the room keeper: proposes object changes, code validates (with a no-LLM fallback)
│   ├── agents/          scheduler (who thinks when), think, prompt (buildMessages), tools, traits
│   ├── llm.js           LLM client: thinking capture, concurrency limit, abort, logging
│   ├── readmodels.js    read-only queries for the UI (timeline, conversations, interactions)
│   ├── observer/        out-of-world observer agent (UI only, never seen by citizens)
│   ├── memory/          memories, relationships, names, witness, reflect, retrieve, consolidate, bootstrap
│   ├── http.js          static files + JSON API + live stream
│   └── migrations/      numbered schema changes (never edit old ones)
├── public/              frontend: app.js (boot, SSE, router), store.js, colors.js, util.js, views/*.js
├── content/             world.md, rooms.json, object-types.json, objects.json, needs.json, needs-text.json,
│                        director-presets.json, scenarios/<id>/ (citizens.json, objects.json, scenario.md/json)
├── scripts/
│   ├── mock-llm.js      fake LLM for offline development
│   ├── deploy.sh        pull + restart without touching the world
│   └── agent-world.service   systemd unit
└── data/                world.db + backups (created at runtime, not in git)
```

## Run it

```bash
cp .env.example .env      # then set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
npm start                 # or: npm run dev  (auto-restarts on server code changes)
```

Open http://localhost:3000. The world starts **paused** on day 1 at 06:00; press Resume.

No school server handy? Run `npm run mock-llm` in a second terminal and keep `LLM_BASE_URL=http://localhost:4000/v1`. The mock picks random valid tool calls, so the village runs without a real model. Options: `MOCK_DELAY_MS` (default 400; use 5000 to test interrupts), `MOCK_FAIL_RATE` (0–1, HTTP 500s), `MOCK_INVALID_RATE` (0–1, bad tool arguments to test the retry path).

`DATA_DIR=some/folder` runs the server against another world database, e.g. a throwaway test world.

## The village (step 2)

`content/` holds the starting world. It is only read to **seed empty tables**; a populated world is never re-seeded on start.

- `world.md`: common knowledge, part of every citizen's system prompt.
- `rooms.json`: 8 rooms around the square. Exits are directed, so both directions are listed.
- `scenarios/village/citizens.json`: Greta (baker), Tomas (smith), Lena (herbalist), Anselm (tavern keeper) and Jonas (shy apprentice), with debts, an old friendship and a secret between them. Greta and Tomas start together in the tavern.

To start over after editing `content/`, use **Director → Wipe and reseed** (or `POST /api/director/reseed {"confirm":"WIPE"}`). It writes a backup to `data/backups/` first.

### How a citizen lives

Every citizen is always in one activity: `idle`, `thinking`, `moving`, `doing`, `waiting` or `talking`. Things they perceive (stimuli, with importance 1–10) land in their **inbox**. The scheduler starts a think when they are idle, when something important (≥ 5) happens while they wait or work, or when they are spoken to in a conversation. A think builds the prompt (`agents/prompt.js`), offers only the tools that make sense right now (`agents/tools.js`), and hands the chosen tool call to `world.applyAction()`, which validates it again before anything changes. Code decides *when* someone thinks; the model always decides *what* they do.

- **Interrupts:** a stimulus with importance ≥ 8 aborts an in-flight think (at most once per 5 game minutes per citizen); the citizen then thinks again with the new stimulus.
- **Pause** aborts all in-flight thinks; the citizens go back to `idle` with their inboxes kept.
- **Restarts:** citizens and conversations are written to SQLite on every change. A citizen saved mid-think simply thinks again after a restart.
- **Inspector tab:** inner thought, model reasoning, inbox, conversation transcript, the exact prompt the citizen sees, and their LLM calls.

## Step 2.5 in short

**Dialogue.** People talk in turns of one or two sentences (max 220 characters, cut at a sentence end, never mid-word; cut lines are logged with `truncated: true`). The limit is enforced but not shown in the tool schema, because models treat a visible `maxLength` as a target. Speech habits are "flavor, not a script". Citizens may only use things described as present. `do` phrases are cleaned up to third person ("Greta is counting the flour sacks").

**Interrupts are rare.** A think is aborted only when the citizen is addressed directly (`say` with `to`), or for a director/physical event of importance ≥ 8 *in their own room* (or a whisper ≥ 8); at most once per 5 game minutes. Cheaper alternative: if 3+ lines were spoken in the citizen's conversation while they were thinking about a `say`, they think once more with the fresh transcript (`rethink_stale` event).

**Director events v2.** `POST /api/director/event` takes `{ roomId, radius, importance, texts: {here, near, far}, roomEffect: {text, durationGameMinutes}, damage: {hp} }`. Distance = room hops (BFS over exits): 0 → `here` at full importance, 1 → `near` at −2, 2..radius → `far` at −4 (min 3). `{room}` in any text becomes the room's name. Room effects stay in the room's description until they expire (citizens who arrive later see them too). Damage lowers `needs.hp` for people in the room (step 3 uses it). Presets live in `content/director-presets.json`; the Director tab can also have the LLM write `near`/`far` from a `here` text.

**Reading pace.** A real-time floor per conversation: after a line, the next line in that conversation waits `max(SPEECH_MIN_SECONDS, chars / SPEECH_CHARS_PER_SECOND)` real seconds. Thinks still run meanwhile; only applying the next `say` waits ("about to speak" / "…" bubble). Pausing freezes the floor. `SPEECH_CHARS_PER_SECOND=0` disables it.

**Observer.** One out-of-world LLM agent (`server/observer/`) writes a running report for the UI: a headline, directed relationships (warmth −5..5, tension 0..5, label, note) and storylines with stable ids. It runs after every conversation ends, every game hour if ≥ 10 new events happened, and on demand (Refresh button); never while paused (except on demand). **Its output never reaches citizens**: nothing in `server/agents/` or `server/world/` imports it; it is wired up in `main.js`. Each report row stores the full merged state, so the Relationships time slider just loads rows.

**UI.** Roster (left, always on: latest inner thought per citizen; click = inspector, shift-click = filter), inspector drawer (right), and views: World (map with effects and walkers), Conversations (live chat panels with each speaker's thought under their line; past conversations with transcripts), Timeline (SVG swimlanes; wheel = zoom, drag = pan), Relationships (SVG graph + time slider), Story (observer storylines), Events (readable sentences, filter chips), LLM, Director. Keys: space = pause/resume, 1–8 = views, Esc = close.

## Step 5 in short

### Objects: ground truth

- **Types are content** (`content/object-types.json`, 28 types, loaded on every boot): states, allowed transitions, affordances, surface templates, `portable`/`size` (1 or 2 hands), `container`, `concealable`, and keyword `rules` for the code fallback (`"light": {"from": ["cold"], "to": "lit"}`).
- **Instances are state** (`objects` table, migration 005): room **or** holder (exactly one, checked after every change and on boot), placement (`on / in / behind / under / beside` another object, or the floor), state, visibility (`obvious / noticeable / hidden`), search difficulty, owner, surface and true texts, `origin` (`content / director / code`, never a citizen).
- **Seeding**: `content/objects.json` (furniture) and `content/scenarios/<id>/objects.json` (owned things: Greta's flour sacks, her ledger, the key under her bed, Jonas's dice…) are inserted **once per id** and never overwritten, so a live world keeps its moved, broken and hidden things, and new objects can be added by deploying.
- **One write path**: `world.objects.change(id, patch, {actorId, action})` validates, writes, appends `object_history` (before / after / witnesses), works out who saw it and sends them the perception. A citizen's action is seen by everyone awake in the room (no stealth yet: hiding things means doing it alone). A silent director change is only seen by people where the object ends up, and only if it isn't hidden there.

### Two views

- **True view**: everything (code, keeper, director UI, observer).
- **Surface view** (`objects.perceiveRoom`): obvious things always; noticeable things if known, after 5+ visits, or with a seeded 40% per visit; hidden things (and anything behind / under something or in a closed container) only if this citizen knows exactly where it is. Rooms have `detail: sparse | normal | rich` (5 / 8 / 12 things listed, the rest is "the usual clutter of a bakery"); things they own, carry or recently handled are always listed.
- **Prompt**: WHAT'S HERE and YOU'RE CARRYING blocks, each line with a handle like `[flour_sack#k2p0]` (aliases, so real ids can't leak whose something is). WHO IS HERE says what others carry. New world rule: only things listed can be touched; you can't produce objects; searching is how you find hidden things.

### Tools (only offered when they apply, enums = valid handles only)

`examine` (1–3 min: the true text, the real state, what's inside an open container, noticeable things close by) · `search(target?)` (5–20 min by room detail; per hidden thing `clamp(0.85 − 0.08·difficulty + 0.1·conscientiousness + 0.05·earlier searches here, 0.05, 0.95)`, +0.2 around a specific thing; locked containers stay shut; others see you poking around) · `take` (2 hands; a barrel or chest needs both; full containers must be emptied first) · `put(object, relation?, anchor?, conceal?)` · `give(object, to)` · `use(object, intent)` · `do` gets an optional `target`. Day plans can name a thing for a `do` step (`"thing": "the flour sacks"`).

### Noticing changes

On arrival the surface view is compared with the citizen's last snapshot of that room: things missing ("fewer flour sacks by the oven"), changed state, moved, and new *obvious* things that arrived since (never "new" noticeable things that were merely missed). Owners also notice their things missing from where they belong (`data.home`), even without a snapshot. Importance: own things 7, things they handled 5, else 3. The notice becomes a witnessed memory (≥ 7 also on their mind), which is what drives suspicion, questions and searches.

### The room keeper (`server/keeper/`)

Purpose `keeper`, route `local → school`, tier `none`, structured JSON output. It is asked for `use`, targeted `do` and concealing `put` only, never for perception. It only proposes: code checks the new state against the type's transitions (and again against the state *now*), corrects `in` for non-containers to `behind`, clamps difficulty to 1–8, trims texts, and logs invalid proposals as `keeper` events. A concealment may leave a subtle clue on the hiding place ("one stone slightly out of line"), which goes away when the thing is moved. **Fallback** (nothing on the route, governor red, an error, or the keeper slower than 10 game minutes): keyword rules per type for `use`, no change for `do`, the first fixed anchor / behind / hidden / difficulty 4 for concealment.

### Director, observer, UI

- Director events take `objectChanges: [{ objectId | type | types, state?, visibility?, surfaceText? }]` (`"state": "@broken"` = the type's broken state). The explosion preset now really breaks the hearth, shutters, tables…; the fire burns shutters, tables, baskets, letters.
- The observer reads object events as `[ground truth]` lines (who really did what, and whether anyone saw it), keeping "what happened" and "what they believe" apart. It still never writes.
- **World view**: an object strip on every room card, toggled between the **true view** (hidden things dashed, with their placement) and one citizen's **surface view**. Click any object (here, in events, in the inspector) for its card: both texts, placement, owner, who thinks it is where (mismatches marked), and the history with actors and witnesses ("unseen"), plus a director editor (state, visibility, difficulty, owner, location, placement, texts, reset).
- **Inspector**: two carrying slots, **known objects** ("they think" vs "really", wrong beliefs highlighted: perfect for following a theft), **last seen** snapshots per room. **Director tab**: create objects from a type, type browser, object changes in the event form. **Events**: an *object* category with readable lines ("Jonas hides a flour sack behind the hearth — unseen"). **Usage**: keeper calls.

## Step 4 in short

### Scale

**Profiles and routing** (`server/llm.js`). `LLM_PROFILES=school,local` defines several endpoints (each with its own concurrency limit and a health check every minute, see `/api/llm/profiles`); `LLM_ROUTES` maps each purpose to a chain of profiles. Without `LLM_PROFILES` the old `LLM_*` block is the `school` profile, and everything works with it alone. Background work (observer, director texts) prefers `local` and falls back to `school`; the reflection `score` only runs on `local` and is simply skipped (code fallback) when there is none. Per-purpose timeouts (`LLM_TIMEOUTS`) are logged as `timeout`. Every call logs its `profile` and `tier`.

**Tiers** (`agents/tiers.js`). Each decision is `full` (thinking on, 2,000 tokens: addressed, important, director events, after waking, severe needs), `light` (600: conversation turns, people who matter coming and going, plan snags) or `none` (300, "act on instinct": routine). Measured on the school GLM: `{"reasoning_effort":"low"}` really turns thinking off, `enable_thinking:false` doesn't (the reasoning lands in the answer), and thinking-on at 600 tokens runs out before the tool call. So `light` uses the off switch by default (`*_THINKING_LIGHT`), and any call that runs out of tokens without a tool call gets one cheap retry with thinking off.

**Day plans** (`agents/plan.js`). After the first morning wake-up (and once for every citizen after deploying) they make a plan (`make_plan`, up to 12 steps: travel, do, eat, visit, wait_until, sleep). Code carries it out without LLM calls; a stimulus that matters pauses it (the prompt shows YOUR PLAN, with `continue_plan`, `revise_plan`, `abandon_plan`), and it resumes by itself on the next calm moment. A failed step or finding the person to visit triggers a `light` decision.

**Governor** (`agents/governor.js`). `TOKEN_BUDGET_OUTPUT_PER_HOUR` per rolling real hour (default 500k, `0` = off). Yellow (≥ 70%): light → none, full capped at 1,200, no stale rethinks, background work only on `local`, 3 game minutes between a citizen's thinks. Red (> 100%): full → light unless addressed/≥ 9, 6 minutes, reading floor ×1.5. It never pauses the world. Shown in the header and the Usage tab; `POST /api/governor {budgetPerHour}` changes the budget live.

**Observer batching.** Reports after N ended conversations (N = citizens / `OBSERVER_CONVERSATIONS_PER_CITIZENS`), every game hour with enough events, or on a big moment (director event ≥ 9, collapse, death), never more often than `OBSERVER_MIN_INTERVAL_REAL_SECONDS` (Refresh ignores both).

### Memory

- **Memories** (`memories` table): first person, subjective. Witnessed events become memories by code (importance × how involved they were or how much they care about who was involved); conversation participants get a reflection afterwards instead; bystanders remember overhearing once. ≥ 7 also lands **on my mind**.
- **Relationships** (`relationships` table) are directed: affinity, trust, familiarity, name knowledge, last seen, a summary in their words. **No row = a stranger.** The prompt shows them in words ("you know him well and like him, but you don't trust him"), never numbers.
- **Names**: you only know a name if you heard it (someone says their own name, `introduce_yourself`, overhearing someone being addressed). Otherwise people are "a tall and stiff-backed man", in prompts, stimuli and tool choices. Names of people you rarely see fade.
- **Reflection gating** (`memory/reflect.js`) per participant: code rules first (full if it clearly mattered, template if it was small talk), then a significance score on the local model, or a line-count fallback without one. `template` = a short code-written memory, `light`/`full` = a `remember` call (1 or 3 memories, relationship changes ±1 or ±3). Logged as `reflection_gate`.
- **Retrieval** (`memory/retrieve.js`): up to 5 memories chosen by importance × strength × (people present, same place, recency), with coarse time labels ("yesterday", "a few days ago"). Being recalled keeps a memory strong.
- **Honest forgetting**: the world rules say a citizen only remembers what is listed; unknown shared pasts are admitted, asked about or knowingly bluffed.
- **Sleep consolidation** (`memory/consolidate.js`): falling asleep (≥ 12 game hours since the last one, or ≥ 8 new memories) rewrites the **core memory** (end of the system prompt, so the prefix stays cacheable all day), merges the day into a few lasting memories, fades trivia, turns old minor memories into vague gists, updates relationship summaries. Decay once per game day; below importance × strength 1 a memory is forgotten (kept for the UI).
- **Seeds and bootstrap**: scenario citizens may carry `memories`, `relationships`, `coreMemory` (the village has them). For a live world: `POST /api/director/bootstrap-memories` writes a core memory, 5–10 memories and relationships per citizen from their backstory (one call each). A village from before step 4 gets plain "we know each other" rows on boot until then.

### UI

Usage tab (stacked output tokens per purpose, budget line, governor, per-purpose table, profiles, reflection paths). Inspector: plan with ✓/→, on their mind, **memory constellation** (time arc; size = importance, opacity = strength, colour = who it's about, ★ consolidated, dashed = told, blurred = gist; click to pin, filter by person / today, show forgotten), core memory with history diff, relationships with bars and summaries, **Nights** (what each consolidation did). Roster: plan progress line. Relationship graph: "What X believes" next to the observer view, with a compare mode.

## Step 3 in short

**Needs.** `hunger` and `fatigue` (0–100) and `hp` change over *game* time in code (`world/needs.js`); all rates, levels and reminder intervals are in `content/needs.json`, the bodily wording in `content/needs-text.json`. A citizen is only told when a need **crosses a level** (peckish → hungry → starving → ravenous → dying of hunger; sleepy → tired → exhausted → collapsing; hurting → badly hurt → critical), plus reminders at bad levels (`remindEvery` game minutes). Peckish/sleepy are below the scheduler's threshold: they only colour the next prompt. The prompt gets a **HOW YOU FEEL** block and, at level 3+, an "Above all, you are starving." line at the very top. At *exhausted*, `do`/`wait` are capped at 30 minutes. At fatigue 100 people drop asleep where they stand; at hp 0 they collapse (not lethal unless `lethal: true`). Someone in a room with food can `feed` them; the director can revive.

**Places.** Rooms have `services` (`food`, `bed`) and an `appearance` (how they look to someone who doesn't know them). Rooms are content: they are upserted from `rooms.json` on every boot (runtime state like effects is kept), so adding a service is just a deploy. Citizens have `knownPlaces`: locals know everything, newcomers only what they have **visited** or been **told** (`tell_about_place`). Unknown exits are shown by appearance; a **PLACES YOU KNOW** block lists what they know; "You don't know where to find food around here." appears when it matters. New tools: `eat`, `sleep` (bed = good sleep, anywhere else = rough), `travel_to` (any known place, the route is found by BFS and walked room by room; something important on the way stops the trip), `tell_about_place`, `feed`.

**Sleep.** Sleepers only wake for importance ≥ 7 (the body: only severe hunger/pain, never tiredness); 4–6 is remembered as "While you slept you vaguely heard: …". `world.hooks.onSleepStart/onWake` are the step-4 hooks for dreams and memory.

**Quiet speed-up.** When nobody is thinking or talking and everyone is asleep/busy/walking, the clock multiplies itself 1 → 2 → 4 → 8 → `QUIET_MAX_SPEED` (one step every 2 real seconds) and snaps back to 1× the moment a think starts or anything with importance ≥ 5 happens. A tick never jumps past the next scheduled event (a timer, a need crossing), so timers fire exactly. Shown in the clock as `1× (quiet: 8×)`.

**Scenarios.** `SCENARIO=village` (the step-2 locals) or `newcomers` (four travellers who don't know the village, one busy local). Reseed accepts a `scenario`. A step-2 world keeps running as `village`: existing citizens get default needs and know every place.

### Director effects

Events can now **do** things. Any event (or `POST /api/director/apply` without an event) takes `effects`:

```json
{ "roomId": "tavern", "radius": 1, "importance": 8,
  "texts": { "here": "A ceiling beam cracks and crashes down!" },
  "effects": [
    { "type": "damage", "target": "here", "amount": 15 },
    { "type": "mark", "target": "here", "text": "covered in plaster dust", "minutes": 120 },
    { "type": "roomService", "service": "bed", "enabled": false, "minutes": 240, "reason": "the upstairs is wrecked" },
    { "type": "blockExit", "to": "square", "minutes": 30, "reason": "rubble in the doorway" },
    { "type": "knowPlace", "target": "pell", "place": "bakery", "notify": "You remember the smell of bread near the square." },
    { "type": "goal", "target": "ilse", "text": "Find out why the beam fell" }
  ] }
```

Types: `damage`, `heal`, `needs` (set/add hunger, fatigue, hp), `move`, `sleep`, `wake`, `collapse`, `revive`, `knowPlace`, `forgetPlace`, `mark`/`unmark` (temporary change to how someone looks, visible to others), `goal`, `trait`, `persona` (appearance, personality, backstory, speech style, occupation), `roomService`, `blockExit`/`unblockExit`, `whisper`. **Target**: `here` / `near` / `far` / `reached` / `everyone` / a citizen id / a list of ids. **Notify**: the text the affected citizen perceives; `false` = silent; omitted = a sensible default for noticeable effects, but only for people the event text didn't already reach. The Director tab has a builder for all of this, presets that use it (rockfall, kitchen fire, free bread…), needs sliders for everyone, and each inspector has an "Act on …" panel with quick buttons.

## Updating without wiping the world

The world is never reset by a deploy:

1. **State is always on disk.** The clock saves every 5 seconds and on shutdown; everything else is written to SQLite as it happens. Pausing or stopping the server freezes game time, and it continues exactly where it stopped.
2. **Schema changes are migrations.** To add a table or column, create a new file such as `server/migrations/002_citizens_memory.sql`. On the next start it runs once, inside a transaction, after a backup is written to `data/backups/`. **Never edit a migration that has already run.** For data transformations, use a `.js` migration exporting `up(db)`.
3. **Flexible rows.** Tables have a `data` JSON column for most fields, so adding a new citizen property usually needs no migration at all. Give it a default in code when reading old rows.

On the server, a deploy is:

```bash
./scripts/deploy.sh       # git pull → restart → world saved → migrations → resumed
```

One-time server setup: copy the project folder (or `git clone` it), install Node 22.13+, create `.env`, then install the systemd unit (instructions are at the top of `scripts/agent-world.service`).

## Thinking

The citizens are meant to actually think. The LLM client separates the model's **thinking** from its **answer** (it handles both `reasoning_content` fields and inline `<think>` tags) and stores both for every call in `llm_calls`. In the UI:

- **Thinking test** tab: send a situation, see the thinking and the answer separately. Use it to check that your endpoint has thinking enabled.
- **LLM calls** tab: every call with its prompt, thinking, answer, tool calls and timing. This becomes the citizen inspector later.

If the thinking box stays empty, the server isn't returning reasoning. For GLM served by vLLM, thinking is usually switched on per request:

```
LLM_EXTRA_BODY={"chat_template_kwargs":{"enable_thinking":true}}
```

Check your school's docs for the exact flag if that doesn't work.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | clock, LLM queue stats, recent events |
| POST | `/api/clock` | `{"action":"pause"}`, `{"action":"resume"}`, `{"action":"speed","value":5}` |
| GET | `/api/stream` | live Server-Sent Events: `clock` (+ LLM load), `event`, `llm`, `citizen`, `conversation`, `room`, `observer`, `world`, `object` |
| GET | `/api/world` | rooms (incl. map position, active effects) + citizen summaries + active conversations |
| GET | `/api/citizens/:id` | full citizen: persona, inbox, activity, thoughts, prompt preview, last 10 LLM calls |
| POST | `/api/citizens` | create a citizen (same shape as `content/citizens.json` entries) |
| POST | `/api/director/event` | located event v2 (see above); legacy `{roomId, text, importance?}` still works; `roomId: "*"` = everyone |
| GET | `/api/director/presets` | ready-made events from `content/director-presets.json` |
| POST | `/api/director/event-texts` | `{roomId, here}` → LLM-written `{near, far}` for the director to edit |
| POST | `/api/director/clear-effect` | `{roomId, effectId?}`: remove one (or all) room effects |
| POST | `/api/director/whisper` | `{citizenId, text, importance?}`: only that citizen perceives it |
| POST | `/api/director/memory` | `{citizenId, action: "add", text, importance, about?}` or `{citizenId, action: "forget", memoryId}` |
| POST | `/api/director/consolidate` | `{citizenId}`: consolidate now |
| POST | `/api/director/relationship` | `{citizenId, otherId, affinity?, trust?, familiarity?, nameConfidence?, summary?}` |
| POST | `/api/director/bootstrap-memories` | `{citizenIds?}`: core memory + seed memories + relationships for citizens without memories (runs in the background) |
| GET | `/api/citizens/:id/memories` | core memory, on my mind, all memories (`?forgotten=0` to hide forgotten) |
| GET | `/api/citizens/:id/consolidations` | the nights |
| GET | `/api/citizens/:id/beliefs` | that citizen's relationship rows |
| GET | `/api/llm/profiles` | profile health |
| GET | `/api/llm/usage` | `?minutes=180&bucket=10`: tokens per bucket/purpose/profile, reflection paths, governor |
| GET/POST | `/api/governor` | state / `{budgetPerHour}` |
| POST | `/api/director/apply` | `{effects, roomId?, radius?}`: effects without a perceived event |
| GET | `/api/director/effect-types` | the effect types the server knows |
| POST | `/api/director/needs` | `{citizenId, hunger?, fatigue?, hp?}`: set values (levels update on the next tick and announce themselves) |
| POST | `/api/director/revive` | `{citizenId}`: a collapsed citizen comes to (hp 30%, hunger ≤ 60) |
| GET | `/api/director/scenarios` | active scenario + the ones in `content/scenarios/` |
| POST | `/api/director/reseed` | dev only, `{"confirm":"WIPE", "scenario"?}`: backup, wipe citizens + rooms, seed a scenario |
| GET | `/api/rooms/:id/objects` | `?view=true` (everything) or `?view=surface&citizen=<id>` (what they perceive, with the prompt lines) |
| GET | `/api/objects/:id` | one object + history (actors, witnesses) + who thinks it is where |
| GET | `/api/object-types` | the types from `content/object-types.json` |
| POST | `/api/director/objects` | create an instance: `{id, type, room \| holder, placement?, state?, visibility?, difficulty?, owner?, name?, surfaceText?, trueText?}` (origin `director`) |
| PATCH | `/api/director/objects/:id` | `{state?, visibility?, searchDifficulty?, ownerId?, roomId?, placement?, holderId?, surfaceText?, trueText?, notify?}` through `objects.change()` |
| POST | `/api/director/objects/reset` | `{objectId}`: back to its content definition (dev tool) |
| GET | `/api/events` | `?limit=&before=&types=a,b` event log, newest first |
| GET | `/api/events/:id` | one event (speech events include their `conversationId`) |
| GET | `/api/conversations` | `?active=1\|0&citizen=&limit=` active (live) and past (from `conversation_end`) |
| GET | `/api/conversations/:id` | one conversation with all lines (incl. each speaker's thought) |
| GET | `/api/timeline` | `?from=&to=` (game minutes): activity spans per citizen, point events, conversation bands |
| GET | `/api/relationships` | `?from=&to=`: addressed speech counts per direction |
| GET | `/api/relationships/lines` | `?a=&b=&until=`: last lines between two citizens |
| GET | `/api/observer/latest` | latest observer report + status |
| GET | `/api/observer/history` | `?limit=`: id, game time, headline per report |
| GET | `/api/observer/:id` | one full report |
| POST | `/api/observer/run` | run the observer now |
| POST | `/api/llm/test` | `{"prompt":"..."}` → `{reasoning, content, toolCalls}` |
| GET | `/api/llm/calls` | recent LLM calls |
| GET | `/api/llm/calls/:id` | full call incl. prompt and thinking |

## Rules for future steps

- Time-based systems use **elapsed game minutes** from the clock tick, never real seconds, so speed changes can't break them.
- All world changes go through `World`, which owns the state, so async LLM results can't conflict.
- Every LLM call goes through `world.llm.chat()` so it's rate-limited, abortable and logged.
- Citizens never create objects. `world.objects.change()` is the only write path for an existing object; the keeper only proposes, code validates.
