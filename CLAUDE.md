# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

The rules, commands and quirks above (from AGENTS.md) apply in full. This file adds the big-picture map you need before you change anything. `README.md` is the feature-level reference: one "Step N in short" section per feature step, plus the full HTTP API table.

## Run and verify (short version)

There is no build, no test suite and no linter. You verify a change by running it against a throwaway world with the mock LLM:

```bash
npm run mock-llm                              # terminal 1: fake LLM on :4000
DATA_DIR=../tmp-world npm run dev             # terminal 2: server on :3000, restarts on server/ changes
curl -X POST localhost:3000/api/clock -H 'Content-Type: application/json' -d '{"action":"resume"}'
```

You can check most behaviour through the JSON API (`/api/world`, `/api/citizens/:id`, `/api/events?types=…`, `/api/llm/calls`) or through the Inspector and Events tabs. The mock picks random valid tool calls, so it shows that something runs without crashing. It does not show that the citizens behave well.

## How the pieces fit

**Boot (`server/main.js`)**: open the DB → run pending migrations (backup first) → `new World(db)` → `world.start()` → HTTP server. The observer is created here and nowhere else.

**`World` (`server/world.js`)** owns all state: `rooms` and `citizens` Maps in memory, written through to SQLite. It creates every subsystem and passes itself in (`new Memory(this)`, `new Relationships(this)`, `new Objects(this)`, `new Emotions(this)`, `new Scheduler(this)`…). Subsystems reach each other through `world.*`, not through imports of each other's state. `world.bus` (an EventEmitter) carries `clock`, `event`, `citizen`, `conversation`, `room`, `llm`, `memory`, `observer`, `governor`… `server/http.js` relays each of these as an SSE message of the same name.

**The tick** (`World.#tick`, run from `clock.onTick` with *elapsed game minutes*) runs in this order: bodies/needs → co-presence → `resolveTimers` (finished walks, `do`/`wait`, meals) → room effects and director state expire → held conversation lines released → conversation tick → physical tick (step 10: holds, fights, fire) → scheming tick (step 11: traits and ambitions jobs, due scheme steps, late contradictions) → emotions tick → deaths tick (bodies seen, news to break, own mortality, dread, decay) → habits (generate missing, judge strength) → intentions fade → quiet speed-up → `scheduler.run()` → periodic needs flush. The clock's `horizonFn` (`quiet.nextEventAt()`) keeps a sped-up tick from jumping past a due timer.

**A citizen's decision loop:**
1. Something happens → `world.perceive(ids, stimulus)` pushes a stimulus (importance 1–10, built in `world/perception.js`) into each citizen's `inbox`. The source of the stimulus sets `data.interrupt` when it is allowed to abort a think.
2. `agents/scheduler.js` decides **who** thinks **when**: a habit carried out by code in a calm moment (no LLM, at most twice in a row, step 9.5 `agents/habits.js`), or a decision. It never decides what a citizen does. There are no day plans: intentions (`agents/intentions.js`) are edited inside decisions and only ever acted on by the citizen.
3. `agents/think.js`: `tiers.js` chooses `full`/`light`/`none` → `prompt.js` `buildMessages()` (pure, reads only; the section order is set so the server's prefix cache gets hits) → `tools.js` `buildTools()` (only the tools that apply right now; enums hold only valid handles) → `world.llm.chat()` → `validateCall`.
4. The result goes back to `world.completeThink()` → `world.applyAction()` → `world/actions.js` (plus `world/object-actions.js` for objects), which validates again against the state *as it is now* before changing anything. A think can be stale or aborted; `world.isCurrentThink(c, t)` guards against that.

`runtimes` (per-citizen in-flight think, seq, last interrupt) live in memory only. A citizen saved as `thinking` goes back to `idle` on boot, with its inbox merged back in.

**Single write paths.** Besides the AGENTS.md rules, each kind of state has one entry point:
- relationships: `world.relationships.change(a, b, deltas, { reason, source, evidence })`. It throws without a reason. Values are clamped there, and the call also writes a `relationship_events` row.
- objects: `world.objects.change(id, patch, { actorId, action })`. It checks the type's transitions, writes `object_history` and works out who witnessed the change.
- body (`server/body/`, step 7B): `world.body` owns parts, conditions, blood, vitality, healing, treatment and death. Part health is derived from conditions; every wound goes through `body.damage()` (garments first). Physical limits are the one exception to "present, don't force". The only objects code creates are corpses, graves (step 9.5) and meal portions handed over by a food service from its real stock (step 11.5, `world/meals.js`). Starving is days without food (`body/starvation.js`, `c.needs.fedAt`), not the hunger meter, which is only the urge.
- scheming (`server/scheming/`, step 11): `world.scheming.ambitions.add/change` (every change keeps a history entry with a why), `schemes.create/save/applyDecision/expose`, `lies.record/verdict/caught/confess`, `traits.set`. Nothing there carries out a step or tells a lie for anyone.
- emotions (`server/emotions/`, step 6): they change how the world is *presented* to a citizen (perception, framing, memory, what others see). They never choose an action, skip an LLM call or remove a tool.

**Ground truth vs. what a citizen believes.** Many systems keep two views apart: objects (true view vs. `perceiveRoom` surface view), names (known only once heard), places (`knownPlaces`), relationships (directed; no row means a stranger). The prompt never shows numbers, only words, and it refers to objects by alias handles (`[flour_sack#k2p0]`) so that real ids, which reveal ownership, can't leak. Secret goals and secret group memberships must never appear in another citizen's prompt. `social/leak.js` checks this when `DEBUG_LEAK_CHECK=true`.

**LLM layer (`server/llm.js`).** Calls carry a `purpose` (`decide`, `habits`, `reflect`, `consolidate`, `bootstrap`, `observer`, `director_text`, `score`, `keeper`, `test`). `LLM_ROUTES` maps each purpose to a chain of profiles (`school`, `local`). The first available profile wins, and `governor.filterRoute` narrows the chain under budget pressure. A purpose with no available profile throws "unavailable", and callers fall back to code: reflection templates, the keeper's keyword rules, a line-count significance score. Every call is logged to `llm_calls` with its reasoning, profile and tier.

**Memory (`server/memory/`)**: `witness` (events → memories by code), `reflect` (after conversations, gated), `retrieve` (prompt selection), `consolidate` (on falling asleep, via `world.hooks.onSleepStart`; rewrites the core memory, which sits at the end of the system prompt), `bootstrap` (seeds memories from scenario backstories).

**Frontend (`public/`)**: `app.js` boots, opens the SSE stream and routes between views. `store.js` is the single client-side state, with topic subscriptions. Each tab is a `views/*.js` module that exports `mount()`, is registered in `VIEWS` in `app.js`, and subscribes to store topics. `util.js` has `api()` and other DOM helpers.

**The map (step 8)**: `public/art/` is pure, DOM-free code that draws everything: `pixels.js` buffers, `palette.js`, `font.js`, `tiles.js`, `objects.js` (recipes from `content/art/objects`), `character.js` (built on the step-7 part tree), `layout.js` (positions), `scene.js` (the frame), `overlays.js`, and `target.js` (CanvasTarget for the browser, ImgTarget for Node). Because it is DOM-free, the server imports parts of it (`mapdata.js` for the boot check, `character.js` `deriveLook`) and `scripts/map-shot.js` renders PNGs with it. Server side: `server/world/maps.js` (spots: citizens have `c.spot`; walking to what an action needs is a `doing` activity of kind `walk`) and `server/world/appearance.js` (the read-only look payload). `public/views/map.js` only reads the store. No image or font files may ship; every visual comes from one producer function so hand-made art could replace it.

**The living map (step 9)**: `scene.js` draws in fixed phases and passes a frame context `F` to the layers in `public/render/` (registered in `layers.js`; the phases and every field of `F` are documented in the scene header). People are posed by `public/render/animator.js` (pose, frame, direction, offsets and character modifiers from activity, conversation, expressed emotion and traits). On-map UI modules live in `public/views/map-ui/` and export `mount(container, api)` → `{ update(S, frame), unmount() }`, with `api` = `mapApi` in `views/map.js`. Graphics quality (`render/quality.js`) gates every visual extra. Server side: trips report through `world.hooks.onTripStart/onTrip` with a tile path from `world.maps.tilePath()` and feed `world.wear` (worn paths) and `world.positions` (`position` events for replay); room effects feed `world.decals`; the read models for the map (`/api/map/social`, `/api/interest`, `/api/citizens/:id/perception`, `/api/replay`) live in `server/ui/` (which may read `observer_reports`, never import the observer). `scripts/checks/*.mjs` are self-check scripts.

**Action and reaction (step 10)**: `server/physical/` — `world.physical` (tools `act_on`, `get_up`, `handle`, `force_door`; the contest; consequences; fire) and `world.altercations` (fights). Every act resolves through `combatProfile()` and weapon profiles (`server/physical/README.md`); every wound goes through `world.body.damage()`; the actor's deeds and intent, the victim's wariness and the witnesses' memories are what make acts stick. Caring for someone you attacked within the hour needs a `reason`.

**Ambitions, schemes and deception (step 11)**: `world.scheming` (`server/scheming/`, facade `index.js`). Two traits (honesty, cunning; words in the prompt), ambitions (generated once, changed only in sleep with a reason), schemes (planned only at reflection or in sleep through `plan_scheme`, where `no_plan` is a full answer; steps fall due by code (tier trigger `scheme_step`), the citizen reports progress through the optional `scheme` field), accomplices (`say` + `confide`, `proposal` answers, commitment at reflection), and lies (`deceive { truth, kind, why, check }` on say / tell_news / put / give / handle → a `lies` row; `trust_claim` verdicts, tells, contradictions against the event log, `lie_caught`, `confess`). The optional fields come from `scheming.toolFields(c)`, and the prompt blocks YOUR AMBITIONS / YOUR PLAN / YOUR STORIES from `scheming.promptBlocks`. Truths, secret ambitions and scheme contents must never reach another citizen's prompt: `leakcheck.js` judges speech that touches a secret, and `social/leak.js` guards prompts. Conversation lines carry a director-only `mark` (lie / confide / confess); prompts read only a line's text.

**Darker sides (step 11.5)**: the planning calls (`scheme`, `ambitions`, reflection, the ambition part of consolidation) use author framing (`scheming/author.js`: a static author preface, then the character in third person) and read grievances in plain words (`scheming/grievances.js`). A grievance gets five equal choices (confront, get_even, go_to_others, wait_and_watch, let_go) with a required in-character `why`; `schemes.applyChoice` is the one place an answer is applied (intention, scheme, or a remembered let-go). Personas carry flaws, a worst self and `grudge`. A crime comes from the actor's intent: `care` never, `defend` against an aggressor never (`consequences.crimeFor`). The scheme harness (`scripts/scheme-eval.js`) runs the real planning prompt on fixtures without a world.

**Death that matters (step 9.5)**: `world.deaths` (`server/death/`) owns what a death means to the living — who knows (`data.knownDeaths`: nobody knows until they witness it, examine the body or are told), grief and fear at the moment of learning, own-mortality checks, village dread, the "X doesn't know yet" prompt — and `customs.js` the body's decay and the customs (tend, vigil, burial in the chapel yard: code creates the grave, gatherings). Anything that names a death in a prompt must go through `world.deaths.knows()` (use `plainRef` / `{{p:id}}` for "Greta is dead" sentences); the leak check (`social/leak.js`) catches the rest. Service stock lives in `world/stock.js`.

## Content and scenarios

`content/` holds world data, not code: `world.md` (common knowledge in every prompt), `rooms.json`, `object-types.json` (loaded on every boot), `objects.json`, `needs*.json`, `cues.json`, `emotions.json`/`appraisals.json`, `director-presets.json`, and `scenarios/<id>/` (`citizens.json`, `groups.json`, `objects.json`, `scenario.json|md`). Object and group instances are seeded **once per id** and never overwritten. That is why adding a new id to content reaches a live world, while editing an existing one does not.

## Conventions seen in the code

- Every module opens with a header comment that explains its role and its invariants. Keep those headers up to date when you change what a module does.
- Feature work is organised as numbered "steps". Comments and `.env.example` tag code with the step that added it (`// step 5.5: …`). When you finish a step, the README gets a new "Step N in short" section and new rows in the API table.
- New per-citizen or per-object fields go in the `data` JSON column, with a default applied when old rows are read (see `World.#load` for the backfill pattern).
