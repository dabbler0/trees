# Tree Growth Simulator

A biologically-motivated simulation of tree growth (branch skeleton, bud
dynamics, secondary thickening, self-pruning) with a three.js debug
renderer, built in TypeScript. The simulation and renderer are fully
decoupled: `runSimulation()` produces a plain, JSON-serializable
`SimulationHistory` (one full tree snapshot per year), which the renderer
consumes to draw any single year and which a scrubber UI steps through.

## Quick start

```sh
npm install
npm run dev      # local dev server with hot reload
npm run build    # produces dist/index.html -- a single, self-contained file
npm test         # runs the allometry/behavior test suite (vitest)
npm run typecheck
```

Opening `dist/index.html` directly (e.g. via `file://`) works with no
server -- it's one HTML file with all JS/CSS inlined.

## Project layout

```
src/model/    Plain data types (Vec3, Bud, BranchSegment, Leaf, TreeState,
              SimulationParams, SimulationHistory) plus small vector-math
              and RNG helpers. No dependency on three.js or the sim.
src/sim/      The growth engine itself: light/shading model, pipe-model
              secondary growth, per-year growth step, and the
              runSimulation()/SimulationRunner orchestration + JSON I/O.
src/render/   TreeDebugRenderer (three.js) and the color-mode registry.
              Consumes TreeState only -- no knowledge of how a tree grows.
src/main.ts   Wires the two together: scrubber, toggles, hover tooltip,
              download/upload of a SimulationHistory JSON file.
tests/        Vitest suite: structural invariants + the high-level
              allometry/shape acceptance tests described below.
```

## Data model

A tree is:

- **`BranchSegment[]`** -- a rooted tree graph of woody internodes (one
  per bud per growing season), each with a start/end position, a
  base/tip radius, branch order, and derived fields (`alive`, `leafArea`,
  `lightExposure`, `hydraulicResistance`) used for both rendering and the
  next year's growth decisions.
- **`Bud[]`** -- growing points (`apical` = leader continuation,
  `axillary` = lateral), each carrying a persistent `hormonalVigor`
  (an apical-dominance/auxin-gradient trait) plus per-year recomputed
  `vigor`/`lightExposure` and a `shadeYears` senescence counter.
- **`Leaf[]`** -- a discretized point cloud of current foliage, used both
  for rendering and as the leaf-area input to the light and carbon
  models.
- **`TreeState`** -- one year's `{ segments, buds, leaves, metrics }`.
- **`SimulationHistory`** -- `{ params, states: TreeState[] }`, fully
  self-describing and safe to serialize/download/re-upload.

## Growth mechanisms (biological basis)

Each simulated year:

1. **Light competition via real shadow-casting** -- exposure at any point
   is computed with an actual shadow-map, the same technique real-time
   renderers use for directional shadows: every leaf-bearing point is
   projected into a 2D grid of columns perpendicular to a light
   direction, each column is sorted and prefix-summed by depth along that
   direction, and a query point binary-searches its own column for how
   much leaf area sits between it and the light. This replaced an earlier
   height-only heuristic (cumulative leaf area strictly above a height,
   regardless of horizontal position) with something that genuinely
   depends on the sun's direction (`sunZenithAngle`/`sunAzimuth`) and on
   *where* a point sits relative to the rest of the canopy, not just how
   high up it is -- and gives future obstructions/competition (another
   tree, a building, terrain) a natural home: anything that can
   contribute `{ position, area }` shading sources to the same index
   would occlude light with no change to how a query works. A single
   direction (straight at the sun) turns out to badly under-shade a real,
   laterally-spreading crown -- a low bud has almost nothing from a wide
   canopy directly in its own narrow overhead column, even though a dense
   dome of foliage overhead should be blocking most of the sky. So
   exposure is a weighted blend of shadow maps built along several fixed
   directions spanning the upper hemisphere (a "diffuse sky" component,
   most of the weight -- the same reasoning behind hemispherical-
   photography/gap-fraction LAI instruments used in real forestry, which
   look at the whole sky rather than just the sun's disc) plus one more
   built along the actual sun direction (the "direct beam" component,
   which is what makes the sun-angle parameter visibly steer
   shading/heliotropism). Each direction still uses the same
   Beer-Lambert extinction law (`exposure = exp(-k * LAI)`) standard in
   forest canopy models -- just computed from real shadow geometry
   instead of a height-only proxy. See `src/sim/light.ts`.
2. **Whole-tree carbon budget** -- annual carbon supply is last year's
   *sunlit* leaf area; the sink is maintenance respiration on standing
   woody volume (Ryan & Yoder 1997's growth-efficiency-decline
   mechanism: bigger trees spend more of their budget just maintaining
   existing wood, and is charged only against *living* wood -- standing
   dead wood awaiting abscission doesn't respire). Net carbon is divided
   across every demanding bud in proportion to its hormonal/hydraulic
   weight -- real source-sink allocation -- which is what keeps total new
   growth bounded by photosynthetic capacity instead of individual local
   rules alone. Supply is smoothed year to year (an exponential moving
   average, standing in for stored carbohydrate reserves) rather than
   reacting instantly to this year's raw sunlit leaf area: a real tree's
   carbon economy doesn't reset from scratch every season, and without
   this an ordinary population correction (self-thinning pruning a batch
   of buds, say) reads as a sudden income crash that starves everyone a
   little more, prunes a few more buds, and spirals -- the smoothing lets
   the tree coast through a temporary dip on reserves while its canopy
   recovers, same as a real one would.
3. **Apical dominance** -- each bud carries a persistent `hormonalVigor`
   that a continuing axis mostly retains and a new lateral inherits at a
   steep discount (occasionally much less of a discount -- see
   "co-dominance" below), with an additional per-year aging penalty
   scaled by branch order so that actively-extending, thin growth stays
   concentrated toward whichever axes are currently most active rather
   than old branches indefinitely re-sprouting as much as a fresher one.
   This rule is identical for every axis in the tree -- there's no
   separate "trunk" concept; whichever axis happens to retain the most
   vigor over time is the trunk, an emergent outcome instead of a
   hardcoded label.
4. **Hydraulic limitation** -- a bud's realized vigor is scaled by
   `R_half / (R_half + pathResistance)`, where path resistance
   accumulates as `length / cross-sectional area` from root to tip. This
   is the mechanism behind Koch, Sillett, Jennings & Davis's
   "hydraulic-limitation hypothesis" (*Nature* 428, 2004): height growth
   decelerates and plateaus as a tree approaches its size limit, without
   ever literally killing the leader.
5. **Self-pruning / senescence** -- a bud whose *local* light exposure
   stays below threshold for several years (or ranks in the shadiest
   ~10% once the crown is near carrying capacity -- a Reineke
   self-thinning rule) dies; its wood is abscised a few years later if it
   never grew children. This is what raises the crown base over time.
   Two more senescence rules apply independent of light: a bud that's
   gone many consecutive years without managing a whole new growth
   increment (a stalled, non-elongating "spur") eventually senesces
   regardless of how well-lit it currently is -- gated by hormonal vigor,
   so a hydraulically-plateaued but still-dominant leader that's
   *supposed* to coast at a near-zero annual increment forever (the
   height-plateau mechanism above) never trips it, while a genuinely
   subordinate bud does after a shorter tolerance, matching how real spur
   shoots have a finite productive lifespan even in good light. And a
   bud that stays down in the low zone near the trunk's base for too long
   dies as the thickening trunk progressively occludes it (bark
   inclusion pinching off its vascular connection) -- a real,
   well-documented mechanism distinct from shading, and what keeps a low,
   reasonably-lit-but-marginal branch from persisting indefinitely purely
   because the shadow-casting light model above never happens to find
   much directly overhead at its specific spot.
6. **Secondary growth (thickening)** -- the pipe model / Da Vinci's rule
   (Shinozaki et al. 1964): required sapwood cross-section accumulates
   bottom-up from distal leaf-area demand, plus a Greenhill-style
   `radius ~ height^1.5` mechanical floor scaled by how much height each
   segment's *own* subtree reaches above it (not a fixed "trunk" axis --
   any segment carrying a lot of height on its shoulders gets a strong
   floor, from the same formula whether it's the original leader or a
   co-dominant fork). Radius never shrinks.
7. **Co-dominance** -- a newly-breaking lateral occasionally inherits a
   much larger share of its parent's vigor than usual, making it a
   genuine competing peer instead of a clearly subordinate branch. This
   single rule is applied identically at *every* branch point in the
   tree, at any order or age -- not a special case reserved for "the
   trunk" -- so a young tree forking into multiple comparably thick
   stems (as real broadleaf saplings often do) is one instance of the
   same scale-invariant branching rule used everywhere else in the
   canopy. Whether a given event ends up visually significant is an
   emergent function of when/where it happens and how it fares in later
   light competition, not of a hardcoded order check -- avoiding any
   hub-and-spoke bias toward a single privileged central axis.
8. **Phyllotaxis / branching geometry and phototropism/gravitropism** --
   lateral buds are placed along each new internode at a golden-angle
   (137.5°) spiral with a configurable branching angle. Phototropic
   straightening and gravitropic droop both scale with an axis's own
   persistent vigor rather than a hardcoded "is this the trunk" check: a
   still-dominant axis (whatever its order, or however it came to be
   dominant) holds a strong vertical bias and droops little, while a
   weaker one drifts and sags more. This continuous rule is what spreads
   a canopy out sideways into a rounded silhouette instead of a narrow,
   conifer-like column -- and nothing stops even a long-dominant "trunk"
   from wobbling, since it's the same lerp-toward-vertical as everywhere
   else, not a hard override. The droop *rate* scales with vigor, but the
   long-run equilibrium sag angle is bounded by the species' own
   `gravitropicDroop` trait, not just how fast each year approaches it:
   without that floor, any persistently low-vigor bud -- not just a
   heavily weeping species -- would eventually converge arbitrarily close
   to hanging straight down given enough consecutive low-vigor years,
   however small the species' droop trait is set to, since nothing else
   bounds where the yearly lerp toward "straight down" ends up over an
   unbounded number of years. Relatedly, a bud whose natural (undrooped)
   trajectory would put its next growth increment into the soil dies
   instead of clamping to ground level and continuing: without that, a
   heavily-drooped, low-vigor lateral could otherwise "crawl" sideways
   along the surface indefinitely, adding a sliver of horizontal growth
   every year forever.
9. **Waning apical control** -- a leader's hormonal dominance erodes
   gradually with age (`trunkAgingPenalty`), unlike an excurrent
   conifer's permanent one, letting fresher branches eventually rival an
   old axis's vigor and round out the crown top rather than tapering it
   to a point indefinitely.
10. **Heliotropism** -- under a non-overhead sun (`sunZenithAngle > 0`),
    a shoot's growth target shifts from straight up to "mostly up,
    tilted somewhat toward the sun", more so once it's locally shaded.
    The tilt is capped well under a full blend toward the sun direction
    so it always stays a *lean* layered on top of gravitropism, never a
    replacement for it (a real shoot doesn't grow flat toward the
    horizon chasing the sun). At `sunZenithAngle = 0` (the default) this
    has no effect at all -- `sin(0) = 0` -- so the whole mechanism is
    inert unless the sun angle is actually moved off overhead.

All constants live in one place, `src/sim/params.ts`, documented with the
literature/reasoning behind each.

## Adjusting parameters in the UI

The "Species & environment parameters" panel exposes a curated subset of
`SimulationParams` as sliders -- the ones a real environment or species
would plausibly vary, rather than every internal tuning constant (see
`src/paramControls.ts` for the list and the reasoning behind each range):

- **Environment** (site/season, not a species trait): sun angle from
  overhead, sun compass direction, and heliotropism strength.
- **Species traits**: hydraulic limit (mature height), growth rate,
  branching angle, droop/weeping habit, foliage retention (deciduous vs.
  evergreen-like), shade tolerance, canopy self-shading density, forking
  tendency, foliage density per shoot, and trunk taper/wind-firmness.

Sliders update a pending set of overrides shown live next to each label;
click "Grow new tree" to actually re-run the simulation with them (same
as the seed/years fields above them -- nothing here retroactively changes
an already-grown tree). "Reset to defaults" clears all overrides. The
chosen parameters travel with a downloaded history file (they're just
part of `SimulationHistory.params`), so a saved/shared tree remembers
what grew it.

## What the test suite checks

`tests/allometry.test.ts` runs one simulation (deterministic, fixed seed)
from a bare seedling to old growth and asserts the externally-observable
shape facts a real tree should have at every age, with numeric bounds
drawn from forestry literature (height:DBH "slenderness" ratios from
national forest inventory HDR models, the pipe model, the
hydraulic-limitation hypothesis, and standard self-pruning/self-thinning
knowledge) -- **not** internal mechanism details:

- the record is always a single, well-formed tree graph;
- height and DBH never shrink;
- height:DBH slenderness stays in a plausible range at every age, and
  settles into the commonly-cited ~50-180 stable-stand range at maturity;
- the live crown base rises substantially from juvenile to old growth
  (self-pruning), without ever re-lowering by the end;
- newer/thinner wood is statistically concentrated higher in the tree
  than older/thicker wood;
- the annual height increment shrinks to a near-standstill in old growth
  (no unbounded growth), while total height still converges rather than
  diverging;
- total leaf area and segment/bud counts stabilize rather than growing
  without bound.

`tests/shape.test.ts` covers overall *architecture* (deciduous- vs.
conifer-like) across many seeds, since forking is stochastic:

- looking at every branch point formed early in a tree's life (order-
  agnostic -- "how thick did each side of this fork's lineage ultimately
  grow", not "is this labeled order 0"): at least some seeds end up with
  a genuinely thick, comparably-balanced early fork, and at least some
  don't (a possibility, not a guarantee);
- crown width holds up well into the upper crown on average instead of
  tapering linearly to a point like a conifer;
- the live canopy's self-pruning is roughly continuous: crown base
  height (and a foliage-weighted mean canopy height, which is robust to
  the strict minimum jumping the instant one twig dies) never jumps by
  more than a small slice of the tree's eventual height in a single
  year -- there's no one-year "cliff" where the whole lower crown
  senesces in lockstep.

## Renderer

`TreeDebugRenderer` draws one `TreeState` at a time via two
`THREE.InstancedMesh`es (branch cylinders, leaf spheres) so tens of
thousands of segments stay within two draw calls. Options:

- `showThickness` -- true tapered-radius cylinders vs. a uniform thin
  skeleton line;
- `showLeaves` -- toggle the leaf point cloud;
- `colorMode` -- `natural`, `branchOrder`, `age`, `lightExposure`,
  `hydraulicStress`, or `vigor` (bud vigor at growing tips). Adding a new
  debug signal is one entry in `src/render/colorSchemes.ts`.

Hover picking is wired through `renderer.onHover(info)`, which receives
the full underlying `BranchSegment`/`Bud` or `Leaf` object (not a
pre-formatted string) so new debug information is easy to surface without
touching the renderer itself.

## Saved history file size

A full year-by-year history of a decades-old tree is a lot of geometry.
`serializeHistory`/`deserializeHistory` (`src/sim/historyCodec.ts`) use a
lossless wire format that only stores which segments are new, changed, or
removed each year -- everything else (including per-segment
`hydraulicResistance`, `leaves`, and `metrics`, all of which are pure
functions of the segment set) is dropped and recomputed on load, since a
root-cumulative field like `hydraulicResistance` would otherwise drift by
a tiny amount on literally every segment every year and defeat any
attempt to skip storing the (overwhelmingly more common) unchanged ones.
The "Download history" button additionally gzips the result
(`CompressionStream`, falling back to plain JSON where unsupported): a
110-year history is on the order of tens of MB uncompressed and roughly
10-15MB gzipped, down from several hundred MB naively.
