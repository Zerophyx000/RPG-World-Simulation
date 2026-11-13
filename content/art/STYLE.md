# Art style (step 8)

Everything on the map is drawn by code from the simulation's data. Nothing is downloaded. This file is the contract for every recipe.

**The feel.** Clean, readable, characterful pixel art in the spirit of the small-sprite 2D RPGs of the late 2010s, a little clearer: big heads and simple faces, flat blocky shading, warm village colours, a world that looks lived in (soot, patches, flour dust, mud). Everything is original.

| Aspect | Rule |
|---|---|
| Perspective | top-down 3/4: you see the front and the top of things; light comes from the **top-left** |
| Tile | 32 x 32 internal pixels |
| Characters | about **44 px** tall (about 1.4 tiles), slightly stylised proportions: larger head, simple face |
| Outline | 1 px, in a dark shade of the fill's own ramp (never pure black); characters and objects have one, ground tiles mostly don't |
| Shading | three tones per material ramp: shadow, base, highlight. Flat and blocky, never gradients. Highlights face top-left, shadows bottom-right |
| Palette | `content/art/palette.json`: about 66 colours in ramps (skin, hair, cloth, wood, stone, grass, dirt, water, straw, slate, iron, fire, blood, flour, gold, leather, smoke, ui). Everything snaps to it |
| Faces | 2-3 px eyes, a small mouth, brows; the **expressed** (masked) emotion picks the face |
| Scaling | drawn at internal resolution, scaled by **integers** (or 0.5 / 0.25 for far zoom) with smoothing off |
| Font | a bitmap font defined in `public/art/font.js` (6 x 9 cell, includes umlauts and accents) |

**Ramps in use.** Skin: pale, light, tan, dark. Hair: black, brown, auburn, blond, grey. Cloth: linen, red, blue, green, ochre, brown, purple, grey, black. Materials: wood, leather, stone, grass, dirt, water, straw (thatch), slate, iron. Effects: fire, blood, flour, gold, smoke, ui.

**Rules for a new recipe.** Pick colours only by `ramp` + `tone`. Shade with the top-left rule (`shade: "auto"`). Close shapes with the ramp's outline colour. Leave one pixel of clear space around anything that casts a shadow. A new object type works without a recipe (tag fallback), but should get one.

**Swapping art.** Every visual comes from one producer: `characterSprite`, `objectSprite`, `tile`, `effect`. Hand-made art can replace any of them without touching the renderer.
