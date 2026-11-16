# server/physical — action and reaction (step 10)

Everything physical — a shove, a hammer blow, a choke hold, a thrown bottle, a barricade, a fire — resolves through
**two abstractions**. Later steps (stats, proficiencies, essences, real gear) fill them in **without changing the
callers**: `acts.js`, `handle.js` and `fire.js` only ever ask these two functions.

| File | Role |
|---|---|
| `profile.js` | `combatProfile(world, c, ctx)`, `weaponProfile(world, o)`, `isDark(world, roomId)` |
| `props.js` | what an object physically is (type fields + `o.data`), `damageObject`, `keyFits`, doors and barricades |
| `acts.js` | the `act_on` / `get_up` tools, the contest, damage through `world.body.damage()`, status effects |
| `altercations.js` | fights as state (`world.altercations`), sides, intents, exchanges, how they end |
| `consequences.js` | deeds (WHAT YOU'VE DONE), intents, aftermath, victims and witnesses, reversal, welcomeness, crimes |
| `handle.js` | the `handle` and `force_door` tools: throw, push/barricade, break, locks, containers, light, water, fire |
| `fire.js` | ignition, spread, room fires, smoke, putting out |
| `prompt.js` | ALTERCATION and WHAT YOU'VE DONE blocks, body lines, darkness, wariness |
| `index.js` | `world.physical`: the facade World, tools and actions call |

## 1. `combatProfile(world, c, ctx)`

Returns `{ force, precision, evasion, toughness, grip, speed, reach, composure }`, each ≈ 0..2 (1 = an ordinary,
healthy, rested adult). `ctx` = `{ opponentId?, weapon?, dark? }` — the opponent focuses anger and fear on them; the
weapon gives `reach` and the improvised penalty; `dark` overrides the room's light.

| Factor | Built from now | Future hook |
|---|---|---|
| **force** | build (persona/appearance: broad 1.25, average 1, short .95, slim .85) × manipulation (both hands) × moving × anger (up to +30%) × fatigue (−40% at exhaustion) × pain (−4%/point over 2) × practice × winded (×0.7) | + strength stat, + proficiency, + essence effects, + gear (gauntlets) |
| **precision** | sight × manipulation × practice × concussion (×0.8) × fear (up to −25%) × wild anger (×0.9 above 5) × dazed (×0.7) × darkness (×0.6) × improvised weapon (×0.95) | + dexterity, + weapon proficiency, + weapon quality/abilities |
| **evasion** | moving × sight × consciousness × fear (dodging, up to +20%) × fatigue (−30%) × practice (≤1.15) × dazed × winded × darkness (×0.85) | + agility, + armour weight (negative), + shields |
| **toughness** | build (broad 1.2 … slim .9) × vitality × blood | + constitution, + armour (also hooks in `body/damage.js`, where garments already absorb first) |
| **grip** | √build × manipulation × fatigue × pain | + strength, + wrestling proficiency |
| **speed** | moving × fatigue × pain × winded | + agility, + encumbrance |
| **reach** | `'same'` bare-handed, the weapon's reach (`near` for swords, axes, pitchforks) | + polearms, + spells with range |
| **composure** | step-6 composure (traits) × practice × fear | + willpower, + essences |

**Practice** is provisional: ×1.25 when `persona.practiced` includes `brawling`, `soldier`, `smith`, `guard`, `danger`
or `hunter`; ×1.15 for fighting trades by occupation (smith, soldier, guard, hunter, butcher…). The skills step
replaces `fightPractice()` with real proficiencies.

## 2. Weapon profiles

`weaponProfile(world, o)` → `{ damage: [{ type, base }], reach, hands, weight, speed, quality, durability, abilities,
improvised, label }`. Bare hands are `BARE_HANDS` (blunt 4; punch 5, kick 7, slap 2).

- **Real weapons** carry `weapon` on their type in `content/object-types.json` (sword, axe, club, knife, hatchet) and
  `quality` per object (`o.data.quality`, seeded 0.3–0.8). `abilities: []` is unused for now.
- **Improvised** from tags (first match wins): `sharp`+`pointed` (knife-like), `pointed` (pierce, reach near), `sharp`
  or `blade` (cut), `heavy`+`blunt` (16: hammer, iron bar, spade), `blunt` (9: stool, bottle, club, tankard), anything
  else a light blow by size. `stateTags` add tags in a state: a **broken bottle** is `sharp`.
- **Durability** (0–100, `o.data.durability`, default from the type): every strike costs 3 × (1 − quality); breakable
  things (bottles, jugs, stools) take 6 more. At 0 the object breaks (`broken` state if the type has one, else
  `data.broken` and a "broken …" surface text). Below 50% it is `damaged`.

Future hooks: real gear sets `quality`, `abilities` (bleeding edges, armour piercing) and per-material durability; the
crafting step creates weapons at dedicated places.

## 3. Resolution

```
attack  = precision × actionDifficulty × aimPenalty × surprise × U(0.75, 1.25)
defense = evasion × (on guard 1.5) × statePenalty × U(0.75, 1.25)          hit if attack > defense
```

- `actionDifficulty`: slap 1.1, shove 1.05, punch 1, grab .95, kick .9, throw .8, choke/pin .7; strike 0.85 + 0.15 ×
  weapon speed.
- `aimPenalty`: none 1, torso .95, limbs .85, head .7, neck .5. `surprise`: asleep ×1.5, talking with someone else ×1.2.
- `statePenalty`: prone ×.4, held ×.5, distracted (in another conversation) ×.7; asleep, unconscious, tied or pinned:
  an automatic hit.
- Grapples (grab, pin, choke, hold_back, break_free): (force + grip) × mult vs (toughness + grip); holding back comes
  from behind (×1.3); tied people break free only by luck.
- **Damage**: base × force × (0.7 + 0.6 × quality) × intent (scare .4, subdue .6, hurt 1, kill 1.3) × U(.8, 1.2) /
  √toughness, through `world.body.damage()` (garments first; armour will hook in there). The part is the aim, else by
  intent (subdue: limbs and torso; kill: head, neck, torso).
- **Effects**: blunt head hits ≥ 4 daze (3–6 min); torso hits ≥ 4 wind (1–2 min); heavy blunt to legs or head, a
  kick (35%) or a shove that lands (by force vs toughness) knock down; strikes and kicks at an arm can disarm (50%);
  a fall can knock the head (10%) and a lit lantern or candle at that spot can go over (30%, `fire.knockedOver`).
  Choking: +1 asphyxia a step (−0.25 consciousness each: senseless at about 3), death after 6–8 continued steps.

## 4. What the other steps plug into

- **Stats / proficiencies / gear (step 14)**: replace the factor sources in `combatProfile`; give weapons `quality`
  and `abilities`; armour reduces damage in `body/damage.js` `wearGarments` (already the first stop of every hit).
- **Essences and combat (step 15)**: new damage types go through `world.body.damage`; essence effects add to the
  profile factors; abilities on weapon profiles.
- **Economy and law (step 13)**: `crime` events (`assault`, `theft_by_force`, `unlawful_restraint`, `breaking_in`,
  `arson`, `attempted_murder`, `manslaughter`, `murder`) with actor, victim, witnesses, severity; the city watch reads
  them.
- **Knowledge and rumours (step 12)**: witness memories ("I saw Tomas hit Greta with a heavy smith's hammer") are the
  seeds that rumours spread.
