# Create a scenario: a guide for AI agents

You are an AI agent working in the **RPG-World-Simulation** repository. The user has given you this file because they want a
new **scenario**: a starting cast of citizens, their relationships, memories, groups and belongings, the text that sets the
scene, the place they live in, and how every one of them looks on the map.

Follow the phases below in order. **Phase 1 is a single message to the user. After they answer, do Phases 2 to 5 without
stopping to ask again**, unless something in their answer is impossible or contradicts itself (see "When to ask again").

Read `AGENTS.md` and `CLAUDE.md` first if you have not already. Their rules apply in full. The ones that matter most here:

- Never touch `data/world.db` (the live world). You test in a throwaway world (`DATA_DIR=...`).
- `content/` seeds **empty** tables only. A new scenario is seen only in a fresh world or after a reseed.
- No image, sprite or font files. **Sprites are data**: a citizen's look is the `persona.look` block; object art is a JSON
  recipe drawn by code.
- Never edit an old migration. A scenario needs no migration at all.
- **Never commit.** A new scenario stays as uncommitted files in the working tree: no `git add`, no `git commit`, no
  branch, no push, even when the work is done. The user decides what, if anything, goes into git.

---

## Phase 0: Learn what exists (before you ask anything)

Read these, so your questions offer real choices and your defaults match the code:

| File | Why |
|---|---|
| `content/world.md` | The common knowledge every citizen gets (Brackenford, era, money, customs). |
| `content/rooms.json` | The rooms that exist. **Rooms are global**: every scenario uses the same rooms. |
| `content/maps/village.json` | Footprints, doors, spots and furniture for every room. |
| `content/scenarios/village/*` | The full example: secrets, debts, a hidden key, a secret gang member (`kael`, `active: false`). |
| `content/scenarios/newcomers/*` | The small example: strangers with `knownPlaces`, `needs`, `scenario.json`, `scenario.md`. |
| `content/object-types.json` | The 64 object types a scenario may place (you may not invent instances of unknown types). |
| `content/cues.json` | Valid `appearanceTags` (hooded, armed, foreign, ragged, well-dressed, uniformed, masked, bloodied, wounded). |
| `server/world/citizens.js` → `citizenFromInput` | The validator your `citizens.json` must pass. |

Rooms that exist today (id, what it is, who it is tied to):

| id | name | tied to |
|---|---|---|
| `square` | the village square | |
| `tavern` | the Tilted Cup | food (operator `anselm`), beds |
| `bakery` | the bakery | food (operator `greta`) |
| `smithy` | the smithy | |
| `well` | the village well | |
| `house_greta` | Greta's house | owner `greta`, bed |
| `house_tomas` | Tomas's house | owner `tomas`, bed |
| `house_lena` | Lena's house | owner `lena`, bed |
| `old_mine_entrance` | the old mine entrance | wild, dangerous |
| `chapel_yard` | the chapel yard | burial ground |

Re-check this table against `content/rooms.json` before you use it; the file wins.

---

## Phase 1: Ask the user (one message)

Send **one** message with every question below, grouped and numbered, so the user can answer in one go. Say that any
question left blank will be filled with a sensible choice of yours, and that they can answer in as much or as little
detail as they like (e.g. "5 people, a family feud, one thief, the rest you decide").

Use this template. Fill the `(...)` hints with what you learned in Phase 0.

> I'll build the scenario in one go once you answer. Skip anything you don't care about and I'll decide it.
>
> **1. The idea**
> 1. A one-line pitch. What is the situation when the clock starts? (e.g. "a feud over a debt", "strangers arrive", "a death nobody has noticed yet")
> 2. A short id for the folder (lowercase, `a-z 0-9 _ -`), and a label for the Director menu.
> 3. Start time of day (default 06:00; the newcomers scenario starts at 07:00).
>
> **2. The setting**
> 4. Where does it happen? Pick one:
>    - **A. Brackenford as it is** (recommended): the existing village map and rooms. Fastest, nothing else breaks.
>    - **B. Brackenford plus new places**: I add rooms (e.g. a mill, a farmhouse, a camp) to the map. They will then exist in *every* scenario.
>    - **C. A different place entirely**: a new town, a ship, a castle... This replaces the shared world text, rooms and map in your working copy, so the existing scenarios stop working there until you undo it.
> 5. For B or C: which places, roughly how big, indoor or outdoor, and who owns or runs each one (food, beds)?
> 6. Anything the world text should add: recent events, local customs, rumours, the season, the mood of the place.
>
> **3. The people**
> 7. How many citizens (2–8 works best; every one costs LLM calls)? Locals, newcomers or a mix?
> 8. For each one, whatever you have in mind: name, age, sex, job, look, personality, what they want, what they hide, how they talk. Or just "a bitter old soldier" and I'll fill in the rest.
> 9. Personality numbers, if you care: Big Five (openness, conscientiousness, extraversion, agreeableness, neuroticism) as low / mid / high, and honesty, cunning and grudge on 1–10. Otherwise I derive them from the description.
> 10. Darker sides: should anyone have a serious flaw (greedy, vindictive, cruel when drunk...), secret goals, or be a liar? (The village aims for about one in five with a serious flaw.)
> 11. Anyone who should start hidden and be switched on later by the Director (like Kael in the village scenario)?
>
> **4. Between them**
> 12. Relationships: who knows whom, who likes / trusts / resents whom, debts, old friendships, love, rivalry.
> 13. Groups: families, households, guilds, factions, gangs. Which are public, which are secret?
> 14. Shared history: a few past events people remember (and roughly how many days ago).
>
> **5. Things**
> 15. Important objects: hidden keys, letters with secret contents, purses, weapons, stolen goods. Who owns them, where are they, are they hidden?
> 16. Anything that does not exist yet as an object type (the current list is: ...)? New types need new art, so say if it really matters.
>
> **6. Looks (the sprites)**
> 17. For each person, anything specific about how they look on the map: build (slim / average / broad / short), skin (pale / light / tan / dark), hair style and colour, beard, clothes and colours. Otherwise I pick from their description.

Then **stop and wait** for the answer.

### When to ask again

Only ask a second question if:
- they chose setting **C** (confirm before you overwrite shared files in their working copy), or
- the answer contradicts itself or the code (e.g. 30 citizens, a gun in a pre-industrial world, a room that must be a home and a shop at once), or
- something you need has no reasonable default.

Otherwise make the choice yourself, note it, and report it in Phase 5.

---

## Phase 2: Design (in your head or a scratch file, not in the repo)

Before writing JSON, work out the scenario as a whole:

1. **The engine of the story.** Give it 2–4 live tensions that make people *act* in the first hours: a debt that is due,
   a theft someone is investigating, a secret one person saw, a stranger who needs a bed, a grudge with a target. Spread
   them so every citizen is part of at least one. Calm scenarios produce citizens who eat, sleep and chat.
2. **Who knows what.** For every secret write down who holds it, who suspects it, and what evidence exists (an object,
   a memory, a witness). A secret nobody can find out goes nowhere; one everybody knows is no secret.
3. **Where everyone starts** (`location`) and sleeps (`home`). Put two people with a tension in the same room at the
   start if you want an early scene (the village scenario starts Greta and Tomas together in the tavern).
4. **Food and beds.** Every citizen must be able to eat and sleep somewhere they know about. Food services in Brackenford
   have operators (`anselm` runs the tavern kitchen, `greta` the bakery). If those citizens are not in your cast, the
   service still exists but nobody restocks it; either reuse those ids for your own cooks, or accept that, or (setting
   B/C) give the rooms your own operators.
5. **Balance.** Mix extraverts and introverts, calm and anxious, honest and not. At most about one in five with a
   *serious* flaw.

---

## Phase 3: Build

All new scenario files go in `content/scenarios/<id>/`. Validate each JSON file as you write it
(`node -e "JSON.parse(require('fs').readFileSync('<file>','utf8'))"`).

### Step 1. The folder and `scenario.json`

```json
{
  "label": "Short title: one line that tells the Director what this is",
  "startTime": "06:00"
}
```

`startTime` is `HH:MM`. On seeding, the clock moves **forward** to the next such time, never back. A folder only shows up
as a scenario if it has a `citizens.json`.

### Step 2. `scenario.md`

Appended to `content/world.md` in **every** citizen's system prompt. So it is common knowledge, written for everyone:

- Start with `**Right now.**` and describe the situation that everyone could know (the newcomers file is a good model).
- Never put a secret in it. Nothing that only one person knows, nothing a citizen would have to find out.
- Short: one to three paragraphs. Plain words, no numbers about people.

### Step 3. The setting

**A. Brackenford as it is.** Nothing to do. Use the room ids from Phase 0 for `location`, `home`, `knownPlaces` and
object `room`s.

**B. Brackenford plus new places.** For each new room:

1. Add it to `content/rooms.json` (rooms are upserted by id on every boot, so it appears in every world, live ones too):
   ```json
   {
     "id": "mill", "name": "the mill",
     "description": "What someone inside sees (2–3 sentences).",
     "appearance": "What someone outside sees (1 sentence).",
     "exits": [{ "to": "square", "travelMinutes": 4 }],
     "tags": ["indoor", "workplace"],
     "affordances": ["grind grain", "haggle over flour"],
     "services": { "food": { "minutes": 20, "hungerRelief": 40, "description": "...", "operator": "<citizen id>" },
                   "bed": { "quality": "rough", "description": "a straw pallet" } },
     "kind": "mill", "detail": "normal", "danger": 0, "construction": "timber", "owner": null,
     "x": 70, "y": 40
   }
   ```
   - Add the **return exit** in the neighbour room too (`square` → `mill`). Exits are one-way entries.
   - `tags`: `indoor`/`outdoor`, `public`/`private`/`workplace`/`home`/`wild`/`sacred`. A home gets `"owner": "<citizen id>"` and a `bed` service.
   - `detail`: `sparse` | `normal` | `rich` (how many things a prompt lists). `danger`: 0–10 (village rooms are 0–1).
   - `construction: "timber"` lets the building burn. `x`, `y` (0–100) place it on the overview.
2. Give it a footprint on the map, `content/maps/village.json` (or a new region file `content/maps/<region>.json`). The
   server **refuses to boot** if any room has no footprint, a spot is off the floor, or an exit has no door or path.
   Copy the shape of an existing entry:
   - a **building** goes in `rooms`: `roomId`, `footprint: [x, y, w, h]` (tiles; walls are its border), `roof`
     (`style`, `color`: a palette ramp such as `straw`, `slate`, `wood`), `doors: [{ "tile": [x, y], "to": [<room ids>] }]`,
     `spots`, `adjacency`, `entries`, `furniture`;
   - an **outdoor place** goes in `areas`: `roomId`, `tiles: "rect:x,y,w,h"`, `spots`, `adjacency`.
   - Paint its floor in `layers.ground` (`_` wood floor, `s` stone floor, `d` dirt, `,` path, `=` cobble) and walls in
     `layers.structures` (`#` stone, `w` timber, `D` door) using the map's `legend`. Keep every row the map's full width.
     Draw a path (`,`) from its door to the neighbour room.
   - **Spots** are the named places inside a room (`"by the millstone"`). 3–6 per room. Each has `id`, `label`
     (a phrase that reads after "you are"), `tiles` (walkable, inside the room, never overlapping another spot or
     furniture), optional `objects` (fixed furniture ids standing at that spot), optional `service` (`"food"`), and one
     `"default": true`. `adjacency` links spots; `entries` says which spot you arrive at from each neighbour.
   - **Furniture** entries: `{ "object": "<object id>", "at": [x, y, w, h] }` on the floor, or `{ "object": "<id>", "wall": [x, y] }`
     for doors and shutters set into the wall.
3. Add the room's furniture as objects in `content/objects.json` (shared furniture, seeded once per id), e.g.
   `{ "id": "mill_stone", "type": "table", "room": "mill", "state": "standing" }`, using existing types.
4. If people will say the room's name in an unusual way, the place-name resolver has a synonym list in
   `server/scheming/common.js` (`SYN`). Only touch it if your room's name and `kind` would not match what people say.

**C. A different place entirely.** Confirm with the user first; do not create a branch or commit. You overwrite
`content/world.md`, `content/rooms.json`, `content/maps/*.json` and `content/objects.json` (furniture) in the working
tree, following the rules of B for every room. Tell the user that `git restore <file>` brings each original back. Know
what breaks and say so in your report:
- the `village` and `newcomers` scenarios, `content/test-days/*`, `content/director-presets.json` and the
  `scripts/checks/*` self-checks all assume Brackenford's room ids;
- code refers to a few ids by name: `well` (water: `server/physical/handle.js`, `server/physical/index.js`,
  `server/death/customs.js`), `chapel_yard` (burial; keep a room with a `burial` service), the `SYN` list in
  `server/scheming/common.js`, and the Director defaults in `public/views/director.js`. Keep a `well` and a burial room
  with those ids if you can, or update those places.
- `content/customs/death.md` is about the village; rewrite it for the new place.

### Step 4. `citizens.json`

A JSON array. One object per citizen. This is the full shape the code reads:

```json
{
  "id": "edda",
  "name": "Edda",
  "kind": "citizen",
  "active": true,
  "location": "well",
  "home": "house_lena",
  "knownPlaces": "all",
  "needs": { "hunger": 30, "fatigue": 20 },
  "coreMemory": "",
  "persona": {
    "age": 41,
    "sex": "female",
    "occupation": "washerwoman",
    "appearance": "Third person, what a stranger sees: build, face, hair, clothes, one telling detail.",
    "appearanceTags": ["ragged"],
    "traits": {
      "openness": 0.4, "conscientiousness": 0.7, "extraversion": 0.6, "agreeableness": 0.3, "neuroticism": 0.5,
      "honesty": 4, "cunning": 6, "grudge": 8
    },
    "personality": "Second person: 'You ...'. Temperament, habits, what sets you off.",
    "backstory": "Second person. Who you are, your past, your situation today, what you know that matters.",
    "goals": ["Short, concrete, actionable today", "A second, longer one"],
    "secretGoals": ["Only ever in your own prompt"],
    "speechStyle": "How you talk: length, tics, what you call people.",
    "covets": ["valuable"],
    "practiced": ["tool"],
    "clothing": ["tunic", "skirt", "boots", "cap"],
    "flaws": [{ "flaw": "vindictive: never lets a slight go", "serious": true },
              { "flaw": "nosy", "serious": false }],
    "worstSelf": "One line: when X happens, she does Y.",
    "look": {
      "build": "average",
      "skin": "skin_light",
      "hair": { "style": "bun", "color": "hair_auburn" },
      "facial": "none",
      "eyes": "brown",
      "colors": { "tunic": "blue", "skirt": "brown", "cap": "linen" }
    }
  },
  "relationships": [
    { "to": "tomas", "affinity": -2, "trust": -1, "familiarity": 7, "nameKnown": true,
      "summary": "First person, one or two sentences: how I see him." }
  ],
  "memories": [
    { "text": "First person, one or two sentences.", "importance": 7, "about": ["tomas"], "daysAgo": 3 }
  ]
}
```

**Validation rules** (`citizenFromInput` throws on these, and seeding inserts nothing if one citizen fails):

| Field | Rule |
|---|---|
| `id` | 1–40 chars of `a-z 0-9 _ -`, unique. Used everywhere as the handle; keep it the lower-case first name. |
| `name` | Required. What others learn when introduced. First name only fits the tone. |
| `location` | Required, an existing room id. |
| `home` | A room id or `null` (a newcomer with nowhere to sleep). |
| `kind` | `citizen` (default). Leave it. |
| `active` | `false` = not seeded; the Director switches them on later. Omit otherwise. |
| `knownPlaces` | `"all"` (a local, the default) or an array of room ids (a newcomer). Their location and home are always added. |
| `needs` | Optional `hunger`, `fatigue` (0–100, higher is worse), `hp`. Default 20/20. |
| `persona.occupation`, `appearance`, `personality` | Required, non-empty strings. |
| `persona.age` | A number. 55+ greys the hair if you set no hair colour. |
| `persona.sex` | `female` / `male` (or leave out: they/them in narration). Drives default clothing and hair styles. |
| Big Five traits | 0–1. Missing ones default to 0.5. |
| `honesty`, `cunning`, `grudge` | 1–10. Optional: if you leave them out, one LLM call at start reads the persona text and sets them (a code estimate without a model). Set them when they matter to the story. |
| `goals`, `secretGoals`, `appearanceTags`, `covets`, `practiced`, `clothing` | Arrays of strings. |
| `flaws` | Array of `{ "flaw": "...", "serious": true/false }` (or plain strings). A serious flaw can lead to harming someone. Generated like the traits when missing. |
| `worstSelf` | One string. |

**Field meanings and good values:**

- `appearanceTags`: only keys from `content/cues.json` → `appearance` (they change how wary strangers are). Adding a
  new tag means adding it there (global).
- `covets`: object tags or types they envy others for: `valuable`, `weapon`, `tool`, a type id such as `sword`, or
  abstract wants like `respect`.
- `practiced`: provisional skills that prevent accidents: `hot` (ovens, forges), `tool`, `danger`.
- `clothing`: garment types to seed: `tunic`, `trousers`, `skirt`, `cloak`, `hood`, `cap`, `boots`, `gloves`. Leave it out
  for the default (tunic, trousers or skirt, boots, sometimes a cloak or cap, gloves for smiths).
- `coreMemory`: optional, first person, at most ~250 words. Leave it out and the first sleep writes one. For a rich start,
  write it.
- `relationships`: directed (Edda → Tomas says nothing about Tomas → Edda; write both sides, they may differ).
  `affinity` and `trust` are −5..5, `familiarity` 0..10, `nameKnown` false for someone they have only seen. No row
  means a stranger. `summary` is first person and is what the citizen "feels" about them.
- `memories`: first person, `importance` 1–10 (8+ is life-shaping), `about` citizen ids, `daysAgo` (20 years ≈ 7300).
  2–5 per citizen is plenty. Memories are how a secret becomes knowable: the witness should *remember* seeing it.

**Writing the text** (these strings go straight into prompts):
- `personality`, `backstory`: second person ("You ..."). Concrete facts beat adjectives: "You owe Greta three shillings
  and keep putting her off" works; "You are complicated" does not.
- `goals`: things they can start on in the first hours, in the imperative.
- Never put **another** citizen's secret into someone's public fields. A secret goes in its owner's `backstory`,
  `secretGoals` or memories, and into the memories of the people who witnessed it. The leak check
  (`DEBUG_LEAK_CHECK=true`) catches mistakes at run time, but don't rely on it.
- No numbers about people anywhere the citizen reads (no "trust 4"). Money in pennies and shillings is fine.
- Match the era in `world.md`: no guns, no printing, no magic, most people can't read.
- `speechStyle` is short and concrete. Speech is limited to 220 characters per line by code.

### Step 5. The sprites (`persona.look`)

Every citizen is drawn by code from `persona.look` (`public/art/character.js` → `deriveLook`) plus the garments they
wear. There are no image files. Set the look explicitly for every citizen, so it does not depend on random picks or on
keywords found in `appearance`. **Make it match the `appearance` text**; other citizens read the text, the user sees the sprite.

| Key | Valid values | Notes |
|---|---|---|
| `build` | `slim`, `average`, `broad`, `short` | Torso, limb and head size. |
| `skin` | `skin_pale`, `skin_light`, `skin_tan`, `skin_dark` | Palette ramps. |
| `hair.style` | `long`, `bun`, `ponytail`, `braid`, `short`, `curly`, `crop`, `bald` | Any style works for any sex. |
| `hair.color` | `hair_black`, `hair_brown`, `hair_auburn`, `hair_blond`, `hair_grey` | |
| `facial` | `none`, `stubble`, `mustache`, `beard` | |
| `eyes` | `brown` (default); any word is stored | Not drawn in colour today; set it for the record. |
| `colors` | `{ "<garment type>": "<ramp>" }` | Keys are the garments they wear (`tunic`, `trousers`, `skirt`, `cloak`, `hood`, `cap`, `boots`, `gloves`). Values: `linen`, `red`, `blue`, `green`, `ochre`, `brown`, `purple`, `grey`, `black`, `leather`. |

Rules for good sprites:
- Give each citizen a different silhouette or colour so the user can tell them apart on the map at a glance (vary build,
  hair and tunic colour; two people in brown tunics with brown hair look like twins).
- If `colors` names a garment, that garment should be worn: either the default set (`tunic`, `trousers`/`skirt`, `boots`,
  sometimes `cloak`/`cap`) or what you list in `clothing`. A colour for a garment they don't wear does nothing.
- Wealth and status show in colour: `purple`, `red`, `black` read as well-off; `grey`, `brown`, `linen` as poor or
  working. Pair with `appearanceTags` (`well-dressed`, `ragged`, `hooded`).
- `hood` + the `hooded` tag for someone who hides; `gloves` for smiths and workers with heat or rough material.
- Wounds, blood, bandages, missing limbs, pallor and facial expressions are drawn from the body and emotion state at
  run time. Don't try to set them in content.

### Step 6. `groups.json` (optional)

```json
[
  { "id": "brackenford", "name": "the village of Brackenford", "kind": "village", "public": true,
    "description": "Everyone who lives in Brackenford.", "members": ["edda", "tomas"] },
  { "id": "mill_family", "name": "the miller's family", "kind": "family", "public": true,
    "description": "...", "members": [{ "id": "edda", "role": "mother" }, { "id": "pim", "role": "son" }] },
  { "id": "night_hands", "name": "the Night Hands", "kind": "gang", "public": false, "wariness": 4,
    "description": "...", "purpose": "what they are for, in a few words", "norms": ["never rob your own"],
    "members": [{ "id": "kael", "role": "member", "secret": true }] }
]
```

- `kind`: `family`, `household`, `village`, `guild`, `faction`, `party`, `gang` (anything else is skipped with a warning).
- `members`: ids, or `{ id, role, secret }`. Joining writes relationship reasons automatically (a family gives more trust
  than a village), so you don't need to repeat "we are family" in `relationships`, though a summary helps.
- A secret group (`public: false`) or a `secret: true` membership is only ever shown to its own members.
- Group ids are seeded once per id and shared with `content/groups.json`; reuse `brackenford` for the village group, and
  pick new ids that do not clash with another scenario unless you mean the same group.

### Step 7. `objects.json` (optional, but secrets need it)

Instances of existing types, seeded once per id:

```json
[
  { "id": "edda_purse", "type": "purse", "holder": "edda", "state": "light", "owner": "edda" },
  { "id": "edda_letter", "type": "letter", "room": "house_lena", "state": "sealed", "owner": "edda",
    "placement": { "relation": "under", "of": "lena_bed" }, "visibility": "hidden", "difficulty": 3,
    "trueText": "What it really says: only revealed when read or examined." },
  { "id": "mill_sack_1", "type": "flour_sack", "room": "mill", "state": "full", "owner": "edda",
    "placement": { "relation": "beside", "of": "mill_stone" } }
]
```

| Field | Rule |
|---|---|
| `id` | `a-z 0-9 _ -`, up to 60 chars, unique across **all** content (prefix with the owner or room). |
| `type` | An id from `content/object-types.json`. |
| `state` | One of that type's `states` (check the file: a `letter` has its own list, a `chest` is `closed/open/locked/broken`). Default: the first state. |
| `room` **or** `holder` | Exactly one. `holder` = a citizen id (carried, 2 hands; a size-2 thing takes both). Worn garments use `"placement": { "relation": "worn" }`. |
| `placement` | `{ "relation": "floor" | "on" | "in" | "behind" | "under" | "beside", "of": "<object id in the same room>" }`. `in` needs a container; a thing in a closed or locked container is hidden. |
| `visibility` | `obvious` (default), `noticeable`, `hidden`. `difficulty` 0–10 for searching (hidden defaults to 4). |
| `owner` | A citizen id (missing owners are dropped). Ownership is what makes taking it theft. |
| `trueText` | Up to 400 chars, the truth (a letter's content, a key's lock). `surfaceText` (160) overrides what a glance shows. |
| `short`, `name` | Optional display names. |

Find the ids of furniture to anchor to in `content/objects.json` (e.g. `greta_bed`, `bakery_oven`, `tavern_counter`).
Loose things lie on a spot's free tiles on the map; you do not add them to the map file. Only fixed furniture of a new
room (Step 3B) goes in the map's `furniture` and a spot's `objects`.

Citizens never create objects. Anything the story needs (the stolen flour, the murder weapon, the money) must exist here.

### Step 8. New object types and their art (only if really needed)

Prefer an existing type with a `name`/`short`/`trueText` that fits ("a silver locket" as a `purse`-like `valuable` is
usually wrong; check whether `key`, `letter`, `ledger`, `purse`, `knife`, `lantern`, `cloth`... fit first). If a new
type is needed:

1. Add it to `content/object-types.json` (global, loaded on every boot). Copy a similar type and change it. Required:
   `id`, `name`, `plural`, `portable`, `size` (1 or 2), `states`, `transitions` (every state listed, `[]` for final),
   `affordances`, `surface` (`default` with `{state}`, plus per-state lines), `tags`. Optional `rules`
   (`verb: { from, to }`), `container`, `lockable`, `concealable`, `durability`, `flammable`, `breakable`, `throwable`,
   `heavy`. Tags drive behaviour: `weapon`, `sharp`, `blunt`, `blade`, `valuable`, `tool`, `food`, `water`...
2. Draw it: add a recipe to the fitting file in `content/art/objects/` (`items.json`, `tools.json`, `furniture.json`...).
   Read `content/art/STYLE.md` first. A recipe:
   ```json
   { "type": "locket", "size": [10, 12], "anchor": [5, 11],
     "draw": [ { "op": "ellipse", "x": 2, "y": 4, "w": 6, "h": 7, "ramp": "gold", "shade": "auto" },
               { "op": "line", "x0": 5, "y0": 0, "x1": 5, "y1": 4, "ramp": "iron", "tone": 1 } ],
     "states": { "open": [ { "op": "rect", "x": 3, "y": 6, "w": 4, "h": 3, "ramp": "linen", "tone": 2 } ] } }
   ```
   - Ops: `rect`, `ellipse`, `poly` (`points`), `line` (`x0,y0,x1,y1`), `pixels` (`rows` + `map` of letter → `[ramp, tone]`),
     `clear`, `holes` (`seed`, `count`, for torn/broken), `tint`, `flame`, `glow`.
   - Colours only as `ramp` + `tone` (0 shadow, 1 base, 2 highlight) or `"shade": "auto"`. Ramps:
     `skin_*`, `hair_*`, `linen red blue green ochre brown purple grey black`, `wood leather stone grass dirt water straw slate iron`,
     `fire blood flour gold smoke ui`.
   - `size` in pixels (a tile is 32×32; a hand item is 10–20 px), `anchor` = the point that touches the ground.
   - Each `states` entry adds or clears shapes on top of the base for that state.
   - Without a recipe the type is drawn by a tag fallback (`content/art/objects/fallbacks.json`). That works, but give it a recipe.

### Step 9. No registration

Don't add the scenario to `README.md`, `.env.example` or any other tracked documentation. It is found by its folder
alone (`listScenarios()` lists every folder in `content/scenarios/` with a `citizens.json`), and it stays out of git.

---

## Phase 4: Verify

You verify by running it. There are no tests. Use a throwaway world and a free port (never `data/`, never the live world).

1. **Static checks.** Every JSON file parses. Then a dry run of the validator (run from the repo root):
   ```bash
   node --disable-warning=ExperimentalWarning -e "
   import('./server/world/citizens.js').then(({ citizenFromInput }) => {
     const fs = require('fs');
     const rooms = new Map(JSON.parse(fs.readFileSync('content/rooms.json','utf8')).map(r => [r.id, r]));
     const ids = new Set();
     for (const c of JSON.parse(fs.readFileSync('content/scenarios/<id>/citizens.json','utf8'))) {
       try { citizenFromInput(c, { rooms, existingIds: ids, now: 0 }); ids.add(c.id); console.log('ok', c.id); }
       catch (e) { console.log('FAIL', c.id, e.message); }
     }
   });"
   ```
   Also check by hand: every `relationships[].to`, `memories[].about`, group member, object `owner`/`holder` and
   service `operator` is a real citizen id; every room id exists; every `placement.of` is an object in the same room;
   every `state` is valid for its type.
2. **Boot it** (two terminals; in PowerShell set the variables with `$env:NAME='value'` first):
   ```bash
   npm run mock-llm
   ```
   ```bash
   DATA_DIR=../tmp-<id> SCENARIO=<id> PORT=3100 npm run dev
   ```
   The log must show `[content] seeded N citizens from scenario "<id>"` with the right N. Fix **every**
   `[objects] skipping ...`, `... placed on the floor`, `[groups] ... unknown kind` and `exit to unknown room` warning.
   A map error stops the boot with a list of problems; fix them all.
3. **Look at the data.** `curl localhost:3100/api/world` (rooms, citizens, objects), `curl localhost:3100/api/director/scenarios`
   (your label is listed and active), `curl localhost:3100/api/citizens/<id>` for each citizen (persona, relationships,
   known places). The Inspector tab at http://localhost:3100 shows the same, plus the prompt.
4. **Look at the sprites and the map** (needs the server running):
   ```bash
   node scripts/map-shot.js --url http://localhost:3100 --room <room> --zoom 3 --out shot-<room>.png
   ```
   ```bash
   node scripts/map-shot.js --url http://localhost:3100 --select <citizen id> --zoom 4 --out shot-<citizen>.png
   ```
   Open the PNGs (they are images; you can read them). Check that each citizen looks like their `appearance` text, that
   no two are hard to tell apart, that new rooms have walls, a door, a path and furniture where you meant it. Delete the
   PNGs afterwards, or keep them in your scratch folder.
5. **Run it.** `curl -X POST localhost:3100/api/clock -H 'Content-Type: application/json' -d '{"action":"resume"}'`, let it run a
   few game hours, then check `curl 'localhost:3100/api/events?types=error'` and the server log for errors. The mock
   picks random tool calls: this proves nothing crashes, not that the story works. If the user has a real model
   configured, a short run with it (and `DEBUG_LEAK_CHECK=true`) shows whether the tensions actually start moving.
6. **Setting B/C only:** also boot a throwaway world with `SCENARIO=village` to make sure your room and map changes did
   not break the existing scenario (B), or note in the report that it is expected to break (C).
7. Stop the servers and delete the throwaway data folder.

---

## Phase 5: Report to the user

Tell them, briefly:
- the files you created or changed (as links), and whether shared files (`rooms.json`, maps, `object-types.json`,
  art recipes, `cues.json`, `world.md`) changed, which reaches every scenario and the live world on deploy;
- the cast in one line each (name, job, what drives them, their secret if any), and the tensions you set up;
- every choice you made for them where they left a question blank;
- what you verified (boot, validator, sprites checked by eye, a mock run) and what you could not (behaviour with a real model);
- how to use it:
  ```bash
  DATA_DIR=../my-world SCENARIO=<id> npm start
  ```
  or, in an existing **dev** world, the Director tab's reseed (or `POST /api/director/reseed {"confirm":"WIPE","scenario":"<id>"}`),
  which backs up and then wipes that world's citizens, rooms and objects. Never on the live world.

Do not commit, stage or push anything; the scenario stays as uncommitted files. If you changed shared files (setting B
or C, new object types, art recipes, cues), list them so the user can restore them with `git restore <file>`.

---

## Pitfalls checklist

- [ ] One message of questions, then build. No drip-feeding questions.
- [ ] `citizens.json` is an array; every citizen has `name`, `location`, `persona.occupation`, `persona.appearance`, `persona.personality`.
- [ ] Traits: Big Five 0–1, honesty/cunning/grudge 1–10.
- [ ] Every id referenced anywhere exists (citizens, rooms, objects, groups).
- [ ] Every citizen can find food and a bed they know about (or is meant to struggle for one).
- [ ] No secret in `scenario.md`, `world.md`, or another citizen's text. Witnesses *remember* what they saw.
- [ ] `persona.look` set for everyone, consistent with `appearance`, and the cast is visually distinct.
- [ ] `colors` keys match garments they actually wear.
- [ ] Object states are valid for their type; `placement.of` is in the same room; secrets have physical evidence.
- [ ] No image files. New art is a JSON recipe.
- [ ] New rooms: footprint, door, path, spots, return exits; the server boots.
- [ ] Tested in a throwaway `DATA_DIR` on a spare `PORT`, never `data/world.db`.
- [ ] Nothing committed, staged, branched or pushed.
