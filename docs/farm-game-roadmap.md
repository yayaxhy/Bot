# /farm Roadmap

This document now tracks two separate implementation tracks:

- `V1`: the completed mixed-style game shell pass
- `V2`: the active full pixel-art rebuild

The user-approved target is `V2`.

## V1 status

`V1` is complete.

What V1 achieved:
- `/farm` moved from a generic feature page toward a game-like scene
- field geometry and 16-plot gameplay logic were stabilized
- HUD, dock, drawers, and dialogs were unified into a coherent shell
- the page became usable as a transitional web-game scene

Why V1 is not the final direction:
- the scene is still visually mixed
- `manor-base` and major world assets are painterly
- crop and field rendering are still transitional rather than a true pixel game asset system

V1 is now treated as a stable fallback / reference pass, not the final visual target.

## V2 target

Build `/farm` as a legitimate pixel-art web game scene in the spirit of Stardew-style presentation, with a front-view / orthographic farm composition:

- one complete pixel visual language
- front-facing cozy farm layout rather than the previous 2.5D manor composition
- tile/object/layer scene composition
- no painterly/pixel mixing in the final frame
- the field is the primary play surface
- HUD, navigation, dock, dialogs, and feedback all belong to the same game UI family

## V2 non-negotiables

1. The final scene must be fully pixel-art.
2. Background, field, crops, structures, and UI must share one asset language.
3. Field geometry and gameplay logic remain deterministic and code-driven.
4. Visual layers must be separable:
   - ground tiles
   - field tiles
   - crop sprites
   - structures / objects
   - UI
5. Debug geometry never appears in default view.
6. The farm field is rendered in a front-view rectangular patch, not an isometric/diamond patch.
7. Scene composition should match a cozy front-facing farm game: house/shop above the field, props/trees flanking it, and crops occupying the lower-center play area.

## V2 scene architecture

### Layer 1 - Ground tile layer

Purpose:
- grass
- dirt paths
- water-edge transitions
- base terrain under the playable field

Rules:
- do not rely on a single painterly ground image
- use repeatable pixel tiles wherever possible

### Layer 2 - Structure / object layer

Purpose:
- house
- bridge
- pond border and decoration
- fence
- barrels, rocks, flowers, signs

Rules:
- these are sprite/object assets, not background paint
- they sit above ground tiles, below UI

### Layer 3 - Field base layer

Purpose:
- the 16-plot farm patch itself
- locked grass plots
- unlocked soil plots
- tilled / planted / ready plot base states

Rules:
- this becomes the main visual field system
- no more large painterly `field-surface` as the final solution
- use a unified tile / patch approach so the field reads as one coherent game object
- the patch is orthographic/front-view, with square/rectangular crop beds rather than diamond tiles

### Layer 4 - Crop sprite layer

Purpose:
- all planted crop states
- sprout / young / mature / ready

Rules:
- crops are separate sprites, never baked into the field base
- sprite anchoring stays tied to the existing 16-plot geometry

### Layer 5 - Interaction / feedback layer

Purpose:
- hover
- selection
- sow / harvest / steal feedback
- plot state markers

Rules:
- feedback is visual, lightweight, and consistent
- no admin-dashboard style badges or overlays

### Layer 6 - UI layer

Purpose:
- resource HUD
- top icon strip
- bottom action dock
- drawers
- dialogs
- profile / return buttons

Rules:
- all UI surfaces must use the same pixel-art panel/button system
- UI is clearly separate from the world, but visually belongs to the same game

## Asset sourcing strategy

### Locked from V1

- gameplay logic
- 16-plot geometry
- field four-corner bounds
- API structure and state transitions

These stay unless there is a gameplay bug.

### Rebuilt for V2

- scene background
- ground tile set
- structure/object set
- field tile system
- crop sprite set
- HUD / dock / dialog art treatment

### Asset generation rules

- AI generation is acceptable for exploration and draft art
- accepted final assets must be normalized into a deterministic asset set
- avoid single-use image hacks that cannot be re-used consistently
- if an asset drives repeated states, prefer a reusable tile/sprite system over a single painted composite
- final shipped in-world pixel assets should be raster (`.png` / `.webp`), not SVG
- SVG is acceptable only for temporary prototyping, debug overlays, or code-generated helper art during migration

## Directory / asset organization

Target organization:

- `public/farm/pixel/scene/*`
- `public/farm/pixel/ground/*`
- `public/farm/pixel/field/*`
- `public/farm/pixel/crops/*`
- `public/farm/pixel/structures/*`
- `public/farm/pixel/ui/*`
- `public/farm/pixel/fx/*`

The current `generated/` assets remain valid during migration, but the final V2 pass should move to the `pixel/` structure.

## V2 execution phases

### Phase 1 - Pixel style guide and asset constraints

Status: completed

Deliverables:
- pixel palette
- outline/shadow rules
- tile vs object rules
- asset directory conventions
- scale and anchoring rules

Done criteria:
- there is a concrete pixel-art style guide
- future assets no longer depend on ad hoc visual decisions

### Phase 2 - Field tile system

Status: in progress

Deliverables:
- replace the current field overlay look with a real pixel field tile system
- replace the previous diamond/isometric tile language with front-view rectangular beds
- define at least these plot base states:
  - locked grass
  - unlocked empty soil
  - planted / tilled soil
  - ready soil

Done criteria:
- the 16 plots read as a coherent pixel farm patch
- the 16 plots read as front-view farm beds, not a 2.5D board
- the field no longer depends on painterly overlay tricks

### Phase 3 - Crop sprite system

Status: in progress

Deliverables:
- rebuild crop visuals as actual pixel sprites
- at minimum per crop:
  - sprout
  - young
  - mature
  - ready

Done criteria:
- crop art matches the field and scene
- no more “pixelated display of non-pixel art” as the final look

### Phase 4 - UI chrome rebuild

Status: completed

Deliverables:
- pixel HUD
- top strip
- bottom dock
- drawers
- dialogs
- modal shells

Done criteria:
- no UI surface looks like a generic web card
- the UI reads like a game system, not a site feature layer

### Phase 5 - Scene background + structures rebuild

Status: in progress

Deliverables:
- pixel scene background built for a front-view farm layout
- house / shop sprite in a front-facing composition
- front-view tree / pond / fence / decoration assets
- auxiliary farm props that support the cozy farm tone without stealing focus from the field

Done criteria:
- painterly background is fully replaced
- the scene frame is fully pixel-art
- the scene no longer implies a manor-courtyard / isometric composition

### Phase 6 - Integration and polish

Status: pending

Deliverables:
- interaction feedback consistency
- layering cleanup
- final state readability
- dev/debug cleanup

Done criteria:
- the page reads as a legitimate pixel web game scene
- no mixed-style assets remain in the main frame

## Acceptance standard for V2

V2 is done only when:

- `/farm` no longer looks like a styled website page
- the main frame is fully pixel-art
- background, field, crops, structures, and UI all belong to one coherent visual system
- the 16-plot field is immediately readable without admin-style labels
- the page feels like a real game screen, not a feature screen with game elements layered on top

## Current implementation rule

Do not spend time polishing transitional mixed-style assets further.

From this point on:
- keep gameplay geometry and state logic
- replace visual systems in V2 order
- prefer reusable pixel tile/sprite systems over one-off painted composites
