# Agent World

A persistent RPG world where LLM-driven citizens live, think, remember, fight and die.

**Step 6 (this version): emotions, mood and contagion.** Citizens now feel: twelve emotions (joy, sadness, fear, anger, disgust, shame, guilt, pride, affection, gratitude, envy, jealousy) that come from code appraisal and from the model's own self-report, decay at different rates with personality, sit on top of a slow mood, show on a face unless they are masked, and spread through a room. Feelings change only how the world is presented to a citizen (perception, framing, memory, what others see) — never what they do — and step 6 adds no new LLM calls.

**Step 5.5: trust with reasons, groups and strangers.** Every change in how one citizen sees another is stored with a reason they can name and the evidence behind it. Groups (family, household, village, guild, faction, party, secret gangs) give in-group trust. Strangers are met with a wariness that depends on the place, the citizen's personality, what the stranger looks like and carries, and what strangers have done to them before. Code spots warning signs (being followed, someone carrying your property, an intruder, things hidden in other people's homes). Citizens can have secret goals nobody else sees.

**Step 5: room state, objects and the room keeper.** Rooms now hold real objects with a state and a place: a ground truth that stays put whether anyone watches or not. Citizens see only what they'd plausibly notice (a surface view), can examine, search, take, put (openly or hidden), give and use things, and carry up to two. A narrow LLM, the room keeper, proposes what a free-form "use" does; code checks every proposal. Citizens never create objects. When they come back, they notice what changed ("there are fewer flour sacks by the oven than when you last looked").

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
│   ├── social/          relationships (reasons, the one write path), groups + parties, strangers, warning signs, leak check
│   ├── emotions/        emotions, mood, appraisal rules, self-report parsing, presentation (present.js), contagion
│   ├── agents/          scheduler (who thinks when), think, prompt (buildMessages), tools, traits
│   ├── llm.js           LLM client: thinking capture, concurrency limit, abort, logging
│   ├── readmodels.js    read-only queries for the UI (timeline, conversations, interactions)
│   ├── observer/        out-of-world observer agent (UI only, never seen by citizens)
│   ├── memory/          memories, relationships, names, witness, reflect, retrieve, consolidate, bootstrap
│   ├── http.js          static files + JSON API + live stream
│   └── migrations/      numbered schema changes (never edit old ones)
├── public/              frontend: app.js (boot, SSE, router), store.js, colors.js, util.js, views/*.js
├── content/             world.md, rooms.json, object-types.json, objects.json, needs.json, needs-text.json,
│                        director-presets.json, emotions.json, appraisals.json, cues.json,
│                        scenarios/<id>/ (citizens.json, objects.json, scenario.md/json)
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

**UI.** Roster (left, always on: latest inner thought per citizen; click = inspector, shift-click = filter), inspector drawer (right), and views: Map (step 8: the living map, the default) and List (the old room cards), Conversations (live chat panels with each speaker's thought under their line; past conversations with transcripts), Timeline (SVG swimlanes; wheel = zoom, drag = pan), Relationships (SVG graph + time slider), Story (observer storylines), Events (readable sentences, filter chips), LLM, Director. Keys: space = pause/resume, 1–9 = views (map: arrows/WASD pan, +/- zoom, F follow, 0 fit), Esc = close.

## Step 9 in short (a living world)

Step 8 put the world on screen; step 9 makes it feel alive and shows the simulation. Everything is still drawn by code, everything is visual only (the map never changes the world and never reaches a citizen), and there are no new LLM calls.

- **Layers.** `public/art/scene.js` draws a frame in fixed phases and hands a frame context `F` to the layers in `public/render/` (`update`, `ground`, `entities`, `overEntities`, `light`, `screen`; see the scene header). Layers: `traces`, `lighting` (+ `effects`), `depth`, `ambient`, `particles`, `story`, `subjective`. A layer that throws is reported once and skipped.
- **Quality.** `public/render/quality.js`: low / medium / high plus a switch per feature (particles, cast shadows, ambient occlusion, worn paths, clutter, ambient life, idle life, secondary motion, flicker, decals, overlays), remembered per viewer, in the ⚙ panel on the map. Low: no particles, no cast shadows, no wear, no ambient life. 60 fps with 50+ citizens on every level.
- **Motion** (`public/render/animator.js`, client-side, no LLM). Idle life: blinks, breathing (faster when afraid, in shock or out of breath), weight shifts and small turns, glances at arrivals and speakers, personality flavour (extraverts look around more, neurotic people fidget, conscientious ones stand straighter). Conversations: everyone faces the speaker, listeners nod (agreeable, or fond of the speaker) or cross their arms (distrust, anger), speakers gesture, whispers lean in, shouts push out, someone leaving turns away first. Activity poses from `content/art/activity-poses.json` (the targeted object's type first, then keywords, then busy hands): hammering with sparks, kneading with flour, sweeping with a broom, eating with a bowl, reading, rummaging, kneeling to treat, sitting on benches. Body language from the expressed emotion, readable at 0.5×: sadness slumps, anger leans in with fists, fear trembles and backs away, joy stands tall and bounces, shame looks down and away. Capes and long hair trail when walking and flutter in the wind; 8-frame walk and run cycles; a half turn passes a middle direction. Doors swing open as people pass; a tended fire burns brighter.
- **Depth and light** (`public/render/lighting.js`, `depth.js`, `effects.js`). Dithered drop shadows; cast shadows that follow the sun (west in the morning, east in the evening, short at noon, none at night, outdoors only); ambient occlusion along walls and around furniture (per chunk, rebuilt when furniture changes); the south walls of buildings stand in front of the people behind them (the selected citizen shows as an outline through the wall); nights are dark with light falling off in dithered bands, fires and candles flicker and warm what is near them, houses with a fire or people awake in the evening get lit windows with light spilling outside; chimney smoke drifts with the wind.
- **Traces.** Worn paths: the server raises a wear map along every trip's tile path (computed with the same A* as the client) and lets it fade ~3% a game day; grass turns trampled, patchy and finally into dirt where people really walk. Decals: soot, scorch and rubble after blasts and fires, puddles after rain (they shrink while they dry), bloodstains (longer on wood and stone than on grass); stored with position and time and faded by game time, so they survive restarts. Clutter from `content/art/clutter.json` (shelves of loaves, tool racks, mugs and kegs, rugs and pots: decor only, never objects, never in prompts), scattered and sooty after a blast. Ambient life: birds that fly off when someone comes near, cats that wander and sleep by a lit hearth, chickens outside the homes, fireflies at night, dust motes indoors by day.
- **Story visuals.** Through their eyes (key S, or the HUD): the world as the followed citizen's prompt sees it, from `GET /api/citizens/:id/perception` (built with the same functions as the prompt): only what they perceive, strangers named by their look, a vignette narrowing on the target of their anger, dark edges and a red-outlined threat when afraid, glowing reminders in grief, darkness with voice markers and sounds as words when blind, "…" for others' speech when deaf, a jittering double image when concussed. Story overlays in god view: tension, affection, envy and jealousy lines (`GET /api/map/social`), watching lines, event pins that fade over three days, and a storyline chosen in the Story view ("show on map") highlighted with its people and places; a rumor-pulse hook waits for the knowledge step. Director cam (key D): follows what matters most from `GET /api/interest` (critical bleeding first, then fresh dramatic events, tense conversations, storylines), holds 8 s unless something of importance 9+ happens, frames whole conversations, shows a caption; any manual pan or zoom pauses it. Replay (key R): any stretch of the last 24 game hours from the logs (`GET /api/replay`: every position change is now a `position` event with its tile path), 1×-60×, pause, scrub, back to live; the world keeps running meanwhile.
- **On-screen UI** (`public/views/map-ui/`): a conversation panel next to the speakers of the selected citizen's conversation (last 6 lines, → addressee, whispers masked in plain view, thoughts in god view, typing…, pin / expand / close, the reason when it ends; pinned panels stack); a HUD card (activity and target, place, needs and vitality/blood bars, feeling, status, the critical countdown, thought, follow / their eyes / inspector); toasts for important events (bottom-left, filterable); a watch list of up to 6 portraits (top-right, a red pulse when something happens to them); search (🔍 or `/`); hover cards with feeling and conversation partner; keys F follow, S their eyes, D director cam, R replay, G god view, T true view, digits pick the dock tab, Esc clears the selection; a critical-moment pill in the top bar.
- **Deferred** (the presentation layer): a dialogue box with portraits and typewriter text (the conversation panel draws through a replaceable `lineRenderer`; `character.js` has `portrait()`), procedural sound (`public/render/audio.js` `onEvent(event)` is called for every live event and does nothing yet), mood colour grading.
- **Checks.** `scripts/checks/*.mjs` are small self-check scripts (motion, traces and replay on the server, the visual layers); run one with `node scripts/checks/<name>.mjs <repoRoot>`.

## Step 8 in short (the visual world, code-drawn)

The room cards became a living, zoomable map. **Everything is drawn by code** (no downloaded art, no image or font files: `public/art/` is pure functions producing pixel buffers; a test checks that none ship). The same renderer runs in the browser (cached offscreen canvases, smoothing off, integer scales) and in Node (a software target that writes PNGs).

- **Spots (the light position system).** `content/maps/<region>.json` gives every room a footprint (building) or area (outdoors), its doors, and a few named **spots** ("by the oven", "at the counter") with adjacency and entries. A citizen is *at* a spot (`c.spot`). Before an action that needs proximity (`say` to someone, `take`, `eat`, `sleep`, ...) code walks them to the right spot; the walk costs game minutes (0.3 near, 0.8 across, divided by the `moving` capacity, so a limp is slower) and is re-validated on arrival. The LLM never chooses spots or tiles. `SPOT_WALKING=false` turns the walking off. Rooms stay authoritative: travel times between rooms come from the room exits, maps only draw them. `/api/maps` serves the files; the boot check (`validateMaps`) throws if a room has no footprint, an exit no door, spots overlap or are unreachable. `/map-preview.html` draws the maps with spots, doors and adjacency and runs the same check.
- **Room layouts are hand-placed.** Each room in the map file lists its `furniture`: `{ "object": id, "at": [x, y, w, h] }` (a footprint on the floor, in tiles) or `{ "object": id, "wall": [x, y] }` (set into that wall tile: doors, shutters). Furniture blocks its tiles (portable things don't), spots are the open floor in front of it, and the boot check fails if a piece is off the floor, overlaps another or a spot, or cuts a spot off. Objects without an entry (new ones, things put down somewhere) are placed automatically on their spot.
- **Movement on the map is tile-based.** The simulation gives each person a target (their spot's tile, a point along a trip, a bed); a mover walks the drawn figure there tile by tile with A* around walls and furniture, at a walking pace (slower with a limp), catching up when the target runs ahead and jumping only for very long distances (director moves). Trip progress never runs backwards when the clock is corrected. Sleepers lie in a bed of their room (their own first), tucked in. Someone who can't stand (crawling only, can't move, paralyzed, a broken unsplinted leg) lies on the floor and crawls when they move.
- **Volume and hearing.** `say` has `volume`: `whisper` (heard in words only at the same spot; near spots hear "whispers something", across the room "talking quietly"), `normal` (whole room, one importance lower across the room) and `shout` (also the neighbouring rooms: "is shouting from <room>"). WHO IS HERE gets one short position phrase per person ("right next to you", "by the oven, across the room from you"); WHAT'S HERE says where an object is when it is not where they stand. No new LLM calls anywhere in this step.
- **Characters** (`public/art/character.js`): about 44 px, four directions, poses idle, walk, sit, lie, crawl, work, carry. A region-coded template ties the picture to the step-7 part tree. Layers: skin and hair from `persona.look` (or a stable derived look), garments by the parts they `cover` (state: worn, torn with holes, rags; bloodied), injuries (blood by bleeding, bandages, splints, slings, burns, bruises, scars, missing parts, peg leg, eye patch), pallor from blood loss, flush from fever, and the **expressed** (masked) emotion as the face. Only what a bystander could see is drawn: internal damage never shows. `server/world/appearance.js` is the read-only payload (`GET /api/looks`, and `look` on every citizen in `/api/world`). Content: `persona.look { build, skin, hair {style,color}, facial, eyes, colors {garmentType: ramp} }`.
- **Objects** (`public/art/objects.js`, recipes in `content/art/objects/*.json`): one recipe per type, states add or remove shapes (lit fire, torn sack, bent tongs), generic `broken`/`smashed`/`wrecked` damage on any type is unmistakable (split down a crack, one half sagging, a chunk missing, soot, splinters on the floor), `overturned` tips the sprite on its side, other types fall back to a drawing by tag. Fire and glow are listed on the sprite so the scene can animate them.
- **Tiles and maps.** 32x32 procedural tiles with seeded noise and neighbour autotiling (path edges, shores, wall caps and fronts), cached 16x16 chunks, water in 4 frames. Roofs fade when you zoom in, hover or select someone inside. `content/art/palette.json` is the master palette and `content/art/STYLE.md` the style contract.
- **Effects.** Chimney smoke from lit hearths, ovens and forges, animated flames, rubble, fire and smoke from room effects (by their text), bloodstains (a room effect with `visual {kind:'bloodstain', spot, at}`, three days, fading), rain (an outdoor room effect that mentions rain), a blast flash with camera shake (an explosion director event), day/night tint with light sources punching through.
- **Overlays.** Names, a task tag ("baking bread…"), speech bubbles (a spoken line stays for its reading time, matching the server's reading floor), god-view thought bubbles, emotion and status icons (sleep, bleeding, pain, the critical countdown in minutes), selection ring; text and icons at double size from zoom 1. **Overview vs focus:** for people you are not focused on, speech, thoughts and tasks are one-line summaries; the selected or hovered person gets the full text. Thought bubbles: off, selected only, or all (summaries).
- **The Map tab** (`public/views/map.js`, the default view): drag or arrows/WASD to pan, wheel or +/- to zoom (0.25 to 4, integer steps), `F` follows the selected citizen, `0` fits the map, jump to a room, minimap (click or drag), regions when there are several maps, click a person for the inspector, an object to open it, hover for a tooltip, a screenshot button (PNG). **True view vs surface view** of objects (what everything is vs what one citizen would notice) and **god view vs plain view** (thoughts, hidden things and feelings vs what a visitor sees). At zoom 0.25 people are dots. The old room cards are the **List** tab. Any other view can be docked next to the map (dock selector). The Map view only reads the store.
- **Dev tools.** `/art.html` (the whole art gallery), `/map-preview.html`, `node scripts/map-shot.js --room bakery --zoom 2 --time 12:00 --out shot.png` (a PNG of the map from a running server, or from a saved `--state`), the screenshot button in the Map tab.
- **Rules kept.** The map never changes the world and never reaches a citizen; positions are derived (spot, stable tile, walk progress by game minutes); no image assets; 60 fps with 50+ citizens (frame cost about 1.5 ms in headless Edge).

## Step 7B in short (body, injuries, illness and death)

Everything lives in `server/body/`; `world.body` is the one writer. All numbers are content: `content/body.json` (the part tree), `conditions.json`, `bleeding.json`, `damage.json`, `treatments.json`, `accidents.json`, `supplies.json`.

- **The body.** A part tree down to eyes, ears, jaw, hands, feet, organs and spine (`maxHealth`, `hitWeight`, `vital`, `internal`, a vessel map per wound depth). Part health is *derived* from the active conditions, so healing gives it back. From it come capacities (consciousness, sight, hearing, speech, breathing, heart, each hand, moving, eating) and status effects as thresholds on them (blind, deaf, mute, one-handed, limping, crawling only, paralyzed, unconscious, in shock, concussed, dying). **No aging**: death comes from injury, illness or starvation only.
- **Blood and vitality.** `blood` (0-100 %) drains only by bleeding; its stages (mild, moderate, severe, critical) cut consciousness and clotting. `vitality` replaces step-3 HP (`needs.hp` mirrors it): +1/h awake, +3/h asleep, drained by starvation, organ damage, fever, shock and critical blood loss. Death: blood < 35 %, vitality 0 or a vital part destroyed (`LETHAL=false`: permanent unconsciousness instead).
- **Conditions** are rows in the `conditions` table (migration 010): type, part, severity, geometry (length, depth, gape, vessel), clot, infection, treatments, flags, lasting-effect tags (`curable_by`). Existing worlds start from the current HP (a bruise "earlier injuries" for the missing part).
- **Bleeding** is per wound: vessel x size x gape x part x activity x (1 - clot) x treatment. Clotting is shared between wounds (several open wounds keep each other open), slowed by size and blood loss, and re-opened by walking on a leg wound. Internal bleeding ignores pressure, wraps, bandages and tourniquets. **Critical grace window** (`CRITICAL_GRACE_MINUTES`): a survivable bleed (a limb with a tourniquet in reach, a neck or torso wound for packing) takes at least that long to reach 35 %, everyone present gets an importance-10 stimulus and tier full, and the UI shows a countdown; two major arteries at once, a destroyed heart or too much in total get no window. Quiet speed-up never runs while anyone bleeds over 5 %/h.
- **Healing** runs at realistic speed (`HEAL_TIME_SCALE`): a deep cut about two weeks, a splinted and set shin 6-8 weeks. Rest, food and treatment quality change the speed; fractures and dislocations don't heal untreated; serious eye, ear and organ damage and the spine are beyond rest (a `healFloor` or nothing). Lasting effects (scar, chronic pain, limp, reduced sight) become permanent conditions. `world.body.heal / restorePart / setRegen` are the hooks for future (RPG) healing; `allowPermanent` only works for a source in the condition's `curableBy`.
- **Infection and illness** (`ILLNESS_RATE`, default low, non-contagious): wounds accumulate infection by how they were treated (untreated, cleaned, bandaged, cauterized); an infection brings fever after 24 game hours, and a fever can kill. Standing in rain or cold without shelter can give a chill (more with torn clothes, exhaustion, sleeping rough).
- **Damage API** `world.body.damage(id, { damageType, part, amount, cause, sourceId })` (cut, pierce, blunt, burn, crush, blast; a part, `random` or a region): the covering garment wears down first (armor will hook in here), then conditions are generated with wound geometry, a vessel roll and a derived severity, plus an organ roll for deep torso and skull hits. Accidents, director events and later weapons all use it. Director presets carry damage *profiles* (the explosion: blasts, burns, temporary ear damage, concussion).
- **Clothing.** Garments are objects (tunic, trousers or skirt, boots, cloak, hood or cap, gloves) with `placement.relation: 'worn'` (no carry slot), seeded once per citizen. They lose state when hit (intact, worn, torn, rags, destroyed), get `bloodied` over a bleeding wound (`wash_clothes` at water clears it) and show in WHO IS HERE as visible cues.
- **Treatment.** `treat(wound, method)`, one wound at a time. Improvised care is limited: pressure, a strip torn from a garment (the garment drops a state and is bloodied), keeping still, a tourniquet that slips. With real supplies (bandage rolls, herbs, needle, spirits, splints; objects that lose state and are restocked at the healer's by code, never created) there are also rinse, bandage, pack, splint, set, stitch, cauterize, herbs and amputate. Quality = method fit x supplies x the patient's state x a roll (no skills yet); a wrong method says "it does nothing". `examine_person` shows visible conditions in full and internal ones as vague hints (`detectChance()` is where a doctor skill plugs in); what the treater knows decides what `treat` offers. An awake patient can `refuse_treatment`; carrying needs `accept_help`. Caring leaves a relationship event, refusing the opposite. Aids (crutch, splint, sling, peg leg, eye patch) are seeded objects; there is no crafting.
- **Perception (physical exceptions to "present, don't force").** The prompt gives the top three conditions as sensation and location (never a diagnosis), functional limits ("You can't put weight on your right leg") and an urgency line. Blind: people are voices, objects only by memory and touch. Deaf: "says something you can't hear". Mute: `gesture` replaces `say`. Can't walk: `crawl_to` (6x the time, costs vitality). No hands: no take, give or use. Unconscious: no LLM calls and a memory gap afterwards. Each removed option says why.
- **Accidents** (`ACCIDENT_RATE`): burns at hot things, cuts from tools, falls in dangerous rooms, stumbles when limping. Risk = base x carelessness (fatigue, strong emotion, pain, concussion or shock) x practice (provisional `persona.practiced`: hot, tool, danger) x room, through the damage API.
- **Death.** In one go: thinks aborted, conversation and party ended, plans cleared, a body object created (the only thing code creates), carried things dropped beside it (worn garments stay on the body), witnesses told (importance 10), grief for those who loved them (long half-life). The dead stay in memories as "(dead)".
- **UI.** Inspector body panel (SVG figure coloured by health with an internal-organs layer, condition icons, garments and aids drawn on, capacities, conditions with healing and infection bars, treatments), roster chips (bleeding, fracture, fever, unconscious, dead), lying chips on the map, timeline markers and a vitality overlay, Director body card (click a part, hit or condition, heal, kill, revive, regeneration, rate sliders). `content/test-days/injury-day.json` is the Part B test day.

## Step 7A in short (fixes from the day-2/3 test logs)

- **Structured feelings.** The optional `feeling` on every tool is an object, not text to parse: `{ emotion (enum of the 12), target (people here or felt about, or "none"), direction: stronger|weaker, amount: 1|2|3, why }`. Reflection `feelings` and consolidation `lingering` use the same fields. Words outside the list go through `content/emotion-synonyms.json` (anxiety → fear, curiosity → joy at half strength, suspicion → fear at the target plus a −0.5 trust event with the why as reason; body states like tiredness are ignored). Anything still unknown is logged as `emotion_unmapped`, not as an error.
- **Sleep and collapse.** No body reminders while sleeping or collapsed (only pain crossing to critical gets through). At the top fatigue level a citizen falls asleep where they stand within 30 game minutes ("Tomas sways and slumps down.", their conversation ends). Woken within an hour while still exhausted: "You were only asleep a moment…", `sleep` is listed first, and they nod off again after 20 minutes unless something important (≥ 7) happens after the wake-up. A deliberate physical exception to "citizens decide".
- **Your own things.** Taking, putting or giving something you own (or any tool or valuable) leaves a first-person memory ("I left my hammer on the counter in the bakery."). An owned thing missing from its place gives "Your hammer isn't here. Last you saw, you left it …" (importance 3, no anger or suspicion) when the citizen knows where it went; only when they don't is it the old importance-7 alarm. Forgetting through memory decay still allows the false-accusation story.
- **Distinct names.** Several objects of one type in a room are told apart by state, then placement, then owner, then an ordinal ("the second full flour sack"); next to one of its own kind it is "beside the other flour sack". A content `name` is used verbatim.
- **Event log.** One line per object action (the result, with the inner thought); a same-minute set-off and arrival read "Kael goes to the bakery". "show raw" in the Events view shows every event as stored.
- **Reasoning and cut-offs.** The inspector shows the full reasoning of the last decision from `llm_calls` (the roster's trimmed text is marked as shortened). `llm_calls.finish_reason` (migration 009) is stored for every call; the Usage tab shows the cut-off rate per tier (red above 5 %), addressed speech decided below full (`tier_violation`, a console warning too with `DEBUG_TIER_CHECK=true`) and cut-off retries. Default caps: full 3,000, light 1,000, none 300 tokens (`LLM_MAX_TOKENS_FULL/LIGHT/NONE`). A decision that runs out of tokens without a tool call is retried once at the next cap up (none → light → full → full × 1.5, `retry_cutoff` event) instead of falling back to instinct.
- **Clearer context.** YOUR PLAN shows today's steps with clock times (✓ 07:00–11:00 baked…, → now: …). PLACES YOU KNOW shows walking minutes, room damage the citizen has actually seen, notable known objects (a broken bed) and when they last looked. When tired or hungry, HOW YOU FEEL names the nearest bed or food they know.
- **Test days.** `content/test-days/*.json` are timed director scripts (`at`: minutes after start or "HH:MM"; the director operations as action types; `chance` / `pick` resolved by a seeded PRNG). Director → Test days runs one with a seed; reseed the scenario first and reuse the seed to replay a day across model or prompt changes. `calm-day` is the baseline, `chaos-day` the busy one. Alternate them when tuning.

## Step 6 in short

### The emotion model

Emotions are content (`content/emotions.json`): each type has an aimed rule (which entries need a person or a thing to be about), a valence, a half-life in game hours and a contagion rate. All of it lives in code as numbers; a citizen is never shown a number, only words.

| Emotion | Aimed | Valence | Half-life | Contagious |
|---|---|---|---|---|
| joy | optional | + | 4 h | 0.25 |
| sadness | optional | − | 24 h | 0.1 |
| fear | optional | − | 1 h | 0.35 |
| anger | optional | − | 3 h | 0.25 |
| disgust | required | − | 6 h | 0.1 |
| shame | none | − | 24 h | — |
| guilt | optional | − | 72 h | — |
| pride | optional | + | 8 h | — |
| affection | required | + | 6 h | 0.1 |
| gratitude | required | + | 24 h | — |
| envy | required | − | 48 h | — |
| jealousy | required | − | 24 h | — |

- A citizen carries at most **12 entries**, one per (type, target, about); anything that decays under 0.5 is dropped.
- A bump raises with **diminishing returns**: `i + d·(1 − i/12)`, and always clamps to 0..10.
- **Decay** is exponential with the type's half-life × a personality factor (negative feelings: `0.6 + 0.8·neuroticism`; positive: `0.7 + 0.6·extraversion`) × a mood factor (in a low mood negative feelings last up to 1.5× longer and positive ones fade up to 1.5× faster; the reverse in a high mood).
- **Rumination**: meeting again (not seen for 30+ game minutes) or recalling the target of an aimed negative feeling at 3 or more adds +0.5, at most once per 30 game minutes per entry, and never above 7: brooding alone does not make a feeling intense.
- **History** lands in the `emotion_log` table (migration 008): an hourly `sample` (all entries + mood), a `bump` row for every change of 1 or more, `decay_out` when an entry fades out, and `mood` rows at night or from the director. Samples older than 30 game days are thinned to one per game day. Migration 008 also adds `memories.emotion` and `memories.valence`.

### Where feelings come from

- **Code appraisal** (`content/appraisals.json`, `server/emotions/appraise.js`): plain world events become bumps, no LLM call. `own_object_missing` (anger at the likely suspect + sadness), `own_object_taken_seen` and `own_object_hidden_seen` (anger at the thief), `followed` (fear), `wary_stranger_present` (a slow fear, capped, for a wariness-7 stranger you keep standing next to), `intruder` and `property` (anger + fear), `trust_broken` / `trust_broken_by_loved` (anger, or sadness when it was someone with affinity ≥ 3), `gift_received` (gratitude + affection), `own_act_witnessed` (shame at being caught) and `own_act_witnessed_guilt` (guilt for the agreeable or conscientious), `close_one_hurt` (fear + sadness for someone close who collapsed or was hurt), `director_event_here` (fear, scaled by the event's importance), `plan_finished` (joy + pride at the end of a plan) and `need_severe_hourly` (a slow sadness when the body is worn down).
- **Modulation**: every type has a personality rule (fear shrinks with openness, anger with low agreeableness, guilt and shame with conscientiousness, joy with extraversion, all negative feelings with neuroticism). Anger at someone you like is dampened (`angerPerAffinity`), and a need at level 3+ makes anger 1.5× touchier (irritability).
- **Envy** (`persona.covets`: object types, tags or roles): seeing someone carry a coveted thing (not family, not their own thing) gives intensity `2 + 2·(1 − agreeableness) + 0.5·envy bumps in the last 3 days`, with a 60-minute cooldown. Only a *new* sight counts: someone taking or receiving the thing in front of you, or seeing them with it again after 6 game hours; working next to it all day is not a fresh pang every hour. Self-reports about the same person merge into that entry. Coveting the leadership of a group counts too: envy at whoever was made leader or head.
- **Jealousy**: attachment is affinity ≥ 4. Members of one family or household are never rivals. Triggers: the beloved and a rival in a two-person conversation of 6+ lines you overhear, walking in on the two of them alone together, gifts passed between them, a party forming without you. Intensity `2 + 3·neuroticism − 0.3·trust in the beloved + 1` if their affection is openly showing, ×0.5 secondhand (you only heard about it), 60-minute cooldown.
- **Lasting envy / jealousy**: still at 5+ for more than half of the day's hourly samples, it hardens at consolidation into a relationship event (−1 affinity, with a reason) — feelings slowly becoming attitudes.
- **Self-report**: every decision tool carries an optional `feeling` string, explained once in the system prompt, in the format `<emotion> <+N or -N> [at <person>]: <why>` (e.g. `anger +2 at Tomas: he lied to my face again`). It is a string rather than an object so that adding it to every tool costs ~10 tokens per tool instead of ~80. Parsed leniently (`report.js`): synonyms accepted (afraid → fear, guilty → guilt…), changes clamped to ±3, and only people the citizen knows can be targets. Reflections get `feelings` (up to 3) and consolidation gets `lingering` (up to 3) plus a `mood_shift` of −2..+2.

### Mood

- A slow layer per citizen: `valence` −5..+5 and `tension` 0..10, each with a personality **baseline** (valence `1.5·(extraversion − 0.5) − 2·(neuroticism − 0.5)`, tension `3 + 4·(neuroticism − 0.5)`).
- Every game hour it drifts 10% of the way towards the current balance of feeling; at night the model's `mood_shift` is applied and the mood is then pulled 15% per day back towards the baseline.
- The prompt shows mood in words, never numbers: "Everything feels grey and heavy today.", "You are wound tight; small things set your teeth on edge.", and after two days away from the baseline "You've felt low for days now."
- **Mood-congruent recall**: when |valence| ≥ 1.5, memories of the same colour score × `1 + 0.15`, and memories of the opposite colour × `1 − 0.075`.

### Present, don't force

`server/emotions/present.js` shapes every decision prompt. Every effect only compresses, emphasises, reorders or colours; nothing removes information the citizen needs, removes a tool or picks one.

| Emotion (threshold) | What changes in the prompt |
|---|---|
| any (top 3) | HOW YOU FEEL: body lines in the second person, never numbers, plus the cause and masking ("You're keeping it off your face.") |
| anger ≥ 6, target present | the target gets their full line (with what they just did), everyone else is compressed into one line |
| fear ≥ 6 | threats first and in full, neutral people compressed; RIGHT NOW spells out the ways out (and that the exit may lead towards the danger) |
| sadness ≥ 5, aimed | reminders of the person: their things here ("it catches at you"), their place |
| jealousy ≥ 4 | the pair's interactions come first in WHAT JUST HAPPENED, plus a plain line that the two of them are here together |
| envy ≥ 3 | WHO IS HERE notes what they have ("Your eyes keep going to …: they have it and you don't.") |
| disgust ≥ 5 | a note on the person ("Everything about him grates on you.") |
| joy ≥ 6, or mood ≥ 2 | people you like come first, gifts in WHAT JUST HAPPENED rank higher |
| shame ≥ 5 | who saw it, and "You feel eyes on you." |
| mood | one framing sentence at the top of RIGHT NOW when far from the baseline, or tense |

- **Tool framing** changes only the order (emotion-congruent tools first) and adds a short note to a description ("say — say what's on your mind"); the set of tools never changes. An instruction clause ("Your heart is pounding. It's hard to think past the danger.") appears at intensity ≥ 7.
- **Tiers**: an intense (≥ 7) emotion about the people or the kind of event that triggered the think **raises** the tier to full, when the triggering stimulus matters (importance ≥ 5). It never lowers one — unless `EMOTION_PARAM_EFFECTS=true` (off by default, experiments only), where overwhelming anger or fear (≥ 8) lowers the tier one step and raises the temperature by 0.15 above `EMOTION_PARAM_BASE_TEMPERATURE` (default 0.7).
- **Memory encoding**: a memory laid down while a feeling (≥ 2) is up about the same people or from the same event gets `+ min(3, intensity/3)` importance and is tagged with the emotion and its valence. Emotional memories fade at the next slower band.

### Expression, masking, contagion

- **Composure** = `0.5 + 0.3·(conscientiousness − 0.5) − 0.4·(neuroticism − 0.5) + 0.2·(0.5 − extraversion)`, clamped to 0.1..0.9. **Expressed** = `max(0, intensity − composure·4)`; at intensity ≥ 8 at least 40% shows whatever they do.
- **Cues** (what others read off a face) start at expressed ≥ 3, and in the emotion's own words ("Kael looks angry, jaw set, glaring at Tomas"). Close observers (familiarity ≥ 6) notice a feeling from expressed 1.5, and a masked strong feeling as "seems to be hiding something".
- **`hide_feelings`** is offered when a feeling is at 5 or more and someone is awake in the room; for 45 game minutes that feeling (or all of them) shows less. The feeling itself does not change, and people who know them well may still notice.
- **Contagion** runs every 10 game minutes per room: each expresser at expressed ≥ 4 of a contagious type nudges everyone else awake there by `rate × (expressed − 3) × susceptibility × closeness × crowd`, with rates fear 0.35, anger 0.25, joy 0.25, sadness 0.1, disgust 0.1. Susceptibility is personality + low composure, closeness is a little affinity, crowd grows with other expressers of the same type (max ×2). Aimed contagion only lands on people who know the target (and not on the target themself). Caps: +2 per type per citizen per game hour, and never above 7 from contagion alone. Crossing a band (4 or 7) sends a stimulus ("The anger in the room has swept you up.") and makes the room glow in the world view. `EMOTION_CONTAGION=false` (or the Director toggle) turns it off.
- **Open anger** (expressed ≥ 5) also makes strangers warier of you (+1: "he looks angry").
- **Witnessed theft**: a bystander who sees someone take a thing that belongs to a third person (not given by the owner, not family or household) gets a `theft_seen` warning sign about them (trust −1, same cooldown and daily cap as the step 5.5 signs). The owner instead gets the `property` sign and the anger appraisal.

### UI

- **Roster**: a ring in the dominant emotion's colour (brighter the stronger), plus an eye for envy and a broken heart for jealousy at 4+.
- **Inspector Emotions panel**: one bar per entry with target, cause, source, how much shows (a tick on the bar) and a 🎭 for masks; a "What others see" line with the cues as another citizen in the room would read them; composure; and the mood line with valence, tension, both baselines, how long the mood has been off, and a small SVG chart with night markers.
- **Timeline**: lanes tinted by the dominant emotion of each hourly sample, with diamond markers for bumps of 3 or more (cause on hover).
- **Relationship graph**: an *emotions* overlay draws aimed emotions as animated arcs in the emotion's colour; a jealousy arc shows the beloved as a dot on the arc.
- **World view**: a room glows briefly in the emotion's colour when contagion crosses a band ("anger spreading").
- **Director**: an *Emotions and mood* card — change a feeling with a cause, set valence and tension, a contagion toggle, and an appraisal log of which rule caused what.
- **Events**: an *emotion* category (contagion band crossings, envy / jealousy crossing 4).

## Step 5.5 in short

### Trust with reasons

- **One write path**: `world.relationships.change(a, b, { affinity, trust, familiarity }, { reason, source, evidence })` (`server/social/relationships.js`). It applies the clamps, updates the `relationships` row and inserts a `relationship_events` row. **A change without a reason throws**; writing the values any other way throws too. Sources: `reflection | witness | signal | first_impression | group | director | seed | consolidation`. Mere encounters share one aggregated row per pair per game day.
- The reflection tool's `relationships[]` items have a required `reason`.
- **In the prompt** (WHO IS HERE, reflections, consolidation): each person's line gets up to two reasons, chosen by size of the change × how strong the reason still is: *"Kael — you don't trust him. He told you the east passage was safe, and it wasn't."*
- **Reasons fade, values stay.** Nightly, reasons decay like memories (big changes slowest). If the stance is clear but nothing nameable is left, the prompt says so: *"…and you don't trust him, though you couldn't say exactly why anymore."* Two or more faded reasons about one person are compressed into one citable summary (*"He's let me down more than once."*).
- **Live worlds**: migration 007 gives every existing relationship one `seed` reason (its summary, or "We've known each other for years."). A startup check repairs any relationship left without one.

### Groups (`server/social/groups.js`)

Tables `groups` and `group_members`. Groups come from content (`content/groups.json`, `content/scenarios/<id>/groups.json`, seeded once per id), the director, or code (parties). Joining writes `group` reasons towards every other member ("We live under one roof.", "She's my sister."), with deltas by kind (family +3 trust / +2 liking / +4 familiarity … village +0.5 / 0 / +0.5). Leaving reverses nothing by itself.

Who knows a membership: your own groups and their members always (secret ones too); other people's only for public groups with a non-secret membership, once you know their name. The prompt gets a **YOUR GROUPS** block and tags in WHO IS HERE ("(your household)", "(your party)", "(from the village)" for outsiders looking at villagers).

**Parties** are the only groups citizens form: `propose_party(people, purpose)` sends invitations (importance 8, pending 60 game minutes), `accept_invitation` creates the party (max 6) or joins it, `decline_invitation` says the refusal out loud, `leave_group` leaves (a party under 2 members dissolves). Day plans have a `follow(person, minutes)` step: code keeps the citizen with that person, about a minute behind, with no LLM calls.

### Strangers (`server/social/strangers.js`)

For people with familiarity < 2, `strangerWariness` (0–10) = 3 + room danger × 0.5 + personality (agreeableness, neuroticism, openness) + visible cues + learned experience. Cues come from `content/cues.json`: appearance tags on the persona (`hooded`, `armed`, `foreign`, `masked`…), tags on carried objects (`weapon`), public group marks, and **carrying something of yours** (+4, unless you gave it to them). The prompt shows it as words with the top reasons, never numbers: *"Every instinct says to keep your distance — this is a dangerous place, he keeps his hood up."* Rooms have `danger` (0–10); the new **old mine entrance** behind the smithy has 5.

The first meeting writes a `first_impression` reason (Δtrust = (5 − wariness) × 0.4). `strangerTrust` (0–1, starts 0.5) **learns**: a stranger who betrays you within 3 game days costs 0.1 and leaves a memory; three good experiences with people met as strangers add 0.03.

### Warning signs (`server/social/signals.js`)

| Sign | Detected when | Stimulus | Δtrust |
|---|---|---|---|
| followed | the same non-group person arrived within 5 game minutes after you in ≥ 3 of your last 4 room changes, within 90 minutes | "…has turned up wherever you've gone this past hour." (6) | −1 |
| property | you see someone carrying something you own and never gave them | "That's your lantern … is carrying." (8) | −2 (−2 more, once, if you had already noticed it missing) |
| hiding | you saw someone hide a thing in a home that isn't theirs | (the witnessed action) | −1 (−2 in your own home) |
| intruder | you come home and find someone who isn't household, family or party | "… is in your house." (7) | −1 |

Per pair and sign there is a 60-minute cooldown, and signals take at most 3 trust per game day. Each is logged as a `signal` event and becomes a reason.

### Secret goals

`persona.secretGoals` appear only in that citizen's own prompt ("Your private aims (nobody knows these)"). The observer and the director UI may read them (🔒). `server/social/leak.js` has `assertNoLeak(prompt, citizenId)`; `DEBUG_LEAK_CHECK=true` checks every decision prompt and logs a leak as an error event. **Kael** (village scenario, `"active": false`) is a hooded newcomer with a cover story, a secret aim to steal something valuable and a secret gang membership; the director brings him in from the Director tab.

### UI

Inspector: group chips, 🔒 secret goals, relationships with their top reasons and a full **reason timeline** (source, deltas, fading, links to the conversation / event / object), a **Strangers** section (learned trust with history, wariness breakdown bars for strangers present). **Groups** tab (director's view, secret groups and memberships marked 🔒, parties with purpose and where members are). Relationship graph: an edge shows each side's own reasons; a filter highlights signal-driven distrust. Director: relationship change with a reason, simulate a sign, appearance tags / secret goals / covets, trust in strangers, room danger, group editor, activating dormant characters. Events: a *social* category.

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
| GET | `/api/stream` | live Server-Sent Events: `clock` (+ LLM load), `event`, `llm`, `citizen`, `conversation`, `room`, `observer`, `world`, `object`, `group`, `emotion_room` |
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
| POST | `/api/director/relationship` | `{citizenId, otherId, affinity?, trust?, familiarity?}` (absolute) or `{dAffinity?, dTrust?, dFamiliarity?}`, with `reason`; also `nameConfidence?, summary?` |
| GET | `/api/citizens/:id/emotions` | current entries + mood + what shows (per-viewer cue lines, composure, masks) |
| GET | `/api/citizens/:id/emotions/history` | `?from=&to=&limit=` rows from `emotion_log` (sample, bump, decay_out, mood) |
| POST | `/api/director/emotion` | `{citizenId, type, target?, about?, delta, cause}`: change a feeling (source `director`) |
| POST | `/api/director/mood` | `{citizenId, valence?, tension?}`: set the slow mood directly |
| GET | `/api/emotions/types` | the 12 types from `content/emotions.json`, contagion on/off, param effects |
| GET | `/api/emotions/appraisals` | `?limit=` recent bumps across the village: which rule caused what |
| GET | `/api/emotions/aimed` | aimed emotions ≥ 2 across everyone, for the relationship graph overlay |
| POST | `/api/director/contagion` | `{enabled}`: turn the contagion pass on or off live |
| POST | `/api/director/bootstrap-memories` | `{citizenIds?}`: core memory + seed memories + relationships for citizens without memories (runs in the background) |
| GET | `/api/citizens/:id/memories` | core memory, on my mind, all memories (`?forgotten=0` to hide forgotten) |
| GET | `/api/citizens/:id/consolidations` | the nights |
| GET | `/api/citizens/:id/beliefs` | that citizen's relationship rows |
| GET | `/api/llm/profiles` | profile health |
| GET | `/api/llm/usage` | `?minutes=180&bucket=10`: tokens per bucket/purpose/profile, reflection paths, governor; step 7A: `cutoffs` per tier, `addressedBelowFull`, `retryCutoff` |
| GET | `/api/director/test-days` | test-day scripts `[{name, description, actions}]` |
| POST | `/api/director/test-days/run` | `{name, seed?}`: run a test day (seed returned; one run at a time) |
| POST | `/api/director/test-days/stop` | stop the running test day |
| GET | `/api/director/test-days/status` | `{running, name, seed, startedAt, done, total, next}` |
| GET/POST | `/api/governor` | state / `{budgetPerHour}` |
| POST | `/api/director/apply` | `{effects, roomId?, radius?}`: effects without a perceived event |
| GET | `/api/director/effect-types` | the effect types the server knows |
| POST | `/api/director/needs` | `{citizenId, hunger?, fatigue?, hp?}`: set values (levels update on the next tick and announce themselves) |
| POST | `/api/director/revive` | `{citizenId}`: a collapsed citizen comes to (hp 30%, hunger ≤ 60) |
| GET | `/api/director/scenarios` | active scenario + the ones in `content/scenarios/` |
| POST | `/api/director/reseed` | dev only, `{"confirm":"WIPE", "scenario"?}`: backup, wipe citizens + rooms, seed a scenario |
| GET | `/api/citizens/:id/relationships/:otherId/events` | the reason timeline for one pair, plus the line as it appears in the prompt |
| GET | `/api/citizens/:id/wariness?other=` | wariness breakdown (debug) |
| GET / POST | `/api/groups` | list / create (director): `{name, kind, public?, purpose?, members?}` |
| GET / PATCH | `/api/groups/:id` | one group / `{name?, public?, purpose?, add: [{id, role?, secret?}], remove: [id], dissolve?}` |
| GET | `/api/relationships/signals` | pairs where warning signs cost trust |
| GET / POST | `/api/director/inactive`, `/api/director/activate` | dormant scenario characters / `{id, location?}` brings one in |
| POST | `/api/director/signal` | `{citizenId, otherId, sign}`: simulate followed / property / intruder / hiding |
| POST | `/api/director/stranger-trust`, `/persona-list`, `/room-danger` | `{citizenId, value}` · `{citizenId, field: appearanceTags\|secretGoals\|covets, values}` · `{roomId, danger}` |
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
| GET | `/api/timeline` | `?from=&to=` (game minutes): activity spans per citizen, point events, conversation bands, `emotions: { samples, bumps }` (lanes tinted by the dominant emotion, bumps ≥ 3 as markers) |
| GET | `/api/relationships` | `?from=&to=`: addressed speech counts per direction |
| GET | `/api/relationships/lines` | `?a=&b=&until=`: last lines between two citizens |
| GET | `/api/observer/latest` | latest observer report + status |
| GET | `/api/observer/history` | `?limit=`: id, game time, headline per report |
| GET | `/api/observer/:id` | one full report |
| POST | `/api/observer/run` | run the observer now |
| POST | `/api/llm/test` | `{"prompt":"..."}` → `{reasoning, content, toolCalls}` |
| GET | `/api/llm/calls` | recent LLM calls; `?citizenId=&purpose=&limit=` filter; rows carry `finish_reason`, `has_reasoning` |
| GET | `/api/llm/calls/:id` | full call incl. prompt and thinking |
| GET | `/api/looks` | step 8: how every citizen looks right now (garments with colour, visible wounds, missing parts, aids, pallor, expression); polled by the map |
| GET | `/api/maps` | step 8: the map files (footprints, doors, spots, adjacency, decor) |
| GET | `/api/art` | step 8: the palette and the object drawing recipes (`content/art`) |
| GET | `/api/wear` | step 9: the worn-path map per region (a 0..255 value per tile) |
| GET | `/api/decals` | step 9: lasting marks still visible (soot, scorch, rubble, puddles, blood) with position and faded intensity |
| GET | `/api/citizens/:id/perception` | step 9: what the citizen's prompt is built from (people with labels and emphasis, perceived objects, senses, the dominant feeling) for the subjective camera |
| GET | `/api/map/social` | step 9: expressed emotions, directed relationship and feeling lines between people on the same map, who watches whom |
| GET | `/api/interest` | step 9: what the director camera should look at (scored focuses with captions) |
| GET | `/api/replay?from=&to=` | step 9: the state at `from` and the time-ordered position, line, object, effect and activity events (game minutes, 24 h max) |
| GET | `/api/citizens/:id/body` | step 7B: parts (health, missing), capacities, status, vitality, blood, active and permanent conditions, garments, aids, critical window |
| GET | `/api/citizens/:id/conditions` | active conditions; `?all=1` includes resolved ones |
| POST | `/api/director/injure` | `{citizenId, type, part, severity | amount, cause}`: a damage type (cut, pierce, blunt, burn, crush, blast + `amount`) or a condition type (+ `severity`; optional `geometry`, `vessel`, `depth`, `length`, `gape`) |
| POST | `/api/director/heal` | `{citizenId, conditionId?, partId?, amount?}`: external healing (permanent conditions stay) |
| POST | `/api/director/kill` | `{citizenId, cause?}` testing only; `/api/director/revive` revives the unconscious (vitality 30, conditions stay) |
| POST | `/api/director/regen` | `{citizenId, multiplier, until?}`: the natural regeneration multiplier |
| GET/POST | `/api/body/rates`, `/api/director/body-rates` | accident rate, illness rate, heal time scale, critical grace minutes (live) |
| POST | `/api/director/test-day` | `{file | name, seed}`: the A8 runner under the plan's name (see `/api/director/test-days`) |

## Rules for future steps

- Time-based systems use **elapsed game minutes** from the clock tick, never real seconds, so speed changes can't break them.
- All world changes go through `World`, which owns the state, so async LLM results can't conflict.
- Every LLM call goes through `world.llm.chat()` so it's rate-limited, abortable and logged.
- Relationship values change only through `world.relationships.change()`, always with a reason. Secret goals and secret memberships never reach another citizen's prompt.
- Citizens never create objects. `world.objects.change()` is the only write path for an existing object; the keeper only proposes, code validates.
- Body state changes only through `world.body` (`damage`, `injure`, `treat`, `heal`): conditions are table rows with a logged cause. Physical limits (unconscious, blind, can't walk) are the one deliberate exception to "present, don't force", and each removed option states its reason. The only objects code creates are corpses.
- Emotions change only how the world is presented to a citizen (perception, framing, memory, what others see). Code never picks an action, skips a call or removes a tool because of a feeling.
