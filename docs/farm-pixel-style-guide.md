# /farm Pixel Style Guide

This file defines the V2 pixel-art rules for `/farm`.

It exists to stop visual drift. If a new asset or UI surface breaks these rules, it does not belong in the V2 scene.

## Intent

The target is a legitimate pixel-art web game scene with clear Stardew-like discipline and a front-view / orthographic farm layout:

- bright daylight presentation
- readable silhouettes
- restrained palette shifts
- consistent shadow direction
- front-facing rectangular crop beds
- grid-aware field states
- UI that feels like game chrome, not website components

## Rendering model

Use:
- tile
- sprite/object
- layer

Do not treat the final scene as:
- one painterly background plus overlays
- ad hoc mixed assets from unrelated visual systems
- an isometric / diamond farm board

## Palette direction

Use a warm, bright rural palette:

- grass greens: fresh, slightly yellow-leaning
- soil browns: mid-warm with readable darker tilled states
- path sand: pale warm yellow
- water: saturated but not neon
- koi accents: orange-red with cream highlights
- house roof: green/teal with warm wood trim
- UI cream/gold: warm off-white, amber, muted brown

Avoid:
- muddy desaturation
- glossy modern gradients
- neon highlight colors
- dark maroon-heavy UI shells

## Pixel rules

### Lines

- outlines should be intentional and consistent
- avoid thin anti-aliased web-style borders as the primary edge language
- prefer strong silhouette edges over soft card shadows

### Shading

- one global light direction
- use stepped light/shadow, not painterly airbrush treatment
- drop shadows should be minimal and game-like

### Corners

- favor squared / stepped corners in UI
- in-world tiles can have softened geometry if needed, but should still read as pixel assets

### Texture

- field tiles should use repeatable pixel texture, not photographic / painterly noise
- crop stages should share the same sprite language
- final pixel assets should be raster sprites (`.png` / `.webp`), not SVG, so the scene reads like a legitimate pixel game instead of vector art filtered to look retro

## Asset categories

### Ground tiles

Assets:
- grass
- path
- path edge
- water edge

Requirements:
- tileable
- consistent horizon/light
- no painterly smearing
- final delivery format should be raster spritesheets or individual raster tiles, not SVG

### Field tiles

Required plot states:
- locked grass
- empty soil
- tilled/planted soil
- ready soil

Requirements:
- visually coherent as one 4x4 patch
- each state readable at a glance
- no heavy fake 3D slab/platform look
- final field tiles should ship as raster sprites, even if early prototypes are generated in SVG

### Crop sprites

Per crop:
- sprout
- young
- mature
- ready

Requirements:
- same scale family across all crops
- same sprite perspective
- same shadow language
- final crop assets should be raster sprite frames, not vector approximations

### Structures / objects

Assets:
- house
- orchard / tree
- pond border
- fence
- rocks
- flowers
- barrels/signs

Requirements:
- larger sprites with clear silhouettes
- front-facing composition that matches the new target reference
- no painterly gradients
- should sit cleanly on the ground tile layer
- final structures should be raster sprites or layered raster pieces

### UI chrome

Assets:
- HUD frame
- top strip buttons
- dock buttons
- dialog frames
- badges
- icons

Requirements:
- all surfaces belong to one UI family
- game-system feel, not admin panel feel
- icon-first, text-second
- UI can remain vector longer than in-world assets during prototyping, but final V2 target should prefer raster pixel panels/icons for consistency

## Field geometry policy

Keep:
- existing 4-corner field bounds
- 16-plot logic
- deterministic code geometry

Change:
- the visual rendering of the field
- the geometry target from diamond/isometric to a front-view rectangular farm patch

The field should be rendered as a pixel-art tile system placed on top of the fixed geometry, not as a painterly overlay.

## Integration rules

### Allowed transitional behavior

During migration:
- gameplay logic may remain unchanged
- crop anchoring may still use existing centers/bounds
- debug overlays may exist behind a query flag

### Not allowed in final V2

- painterly background in the shipped main frame
- “pixelated” display of non-pixel art as the final solution
- UI components that still read like rounded web cards
- mixed asset languages in the same visible frame

## Acceptance test

An asset/system is V2-valid only if:

1. It reads as pixel art without explanation.
2. It matches the rest of the scene in scale and shading.
3. It does not introduce modern glossy web-app styling.
4. It can be reused systematically, not only once.
