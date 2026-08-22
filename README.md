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

1. **Light competition** -- a Beer-Lambert canopy light model bins
   foliage into horizontal layers and attenuates exposure with
   cumulative leaf area above each point (standard forest-canopy
   approximation).
2. **Whole-tree carbon budget** -- annual carbon supply is last year's
   *sunlit* leaf area; the sink is maintenance respiration on standing
   woody volume (Ryan & Yoder 1997's growth-efficiency-decline
   mechanism: bigger trees spend more of their budget just maintaining
   existing wood). Net carbon is divided across every demanding bud in
   proportion to its hormonal/hydraulic weight -- real source-sink
   allocation -- which is what keeps total new growth bounded by
   photosynthetic capacity instead of individual local rules alone.
3. **Apical dominance** -- each bud carries a persistent `hormonalVigor`
   that a continuing leader mostly retains and a new lateral inherits at
   a steep discount, with an additional per-year aging penalty on lateral
   axes so that actively-extending, thin growth stays concentrated
   toward the current top of the tree rather than old low branches
   indefinitely re-sprouting as much as the leader.
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
6. **Secondary growth (thickening)** -- the pipe model / Da Vinci's rule
   (Shinozaki et al. 1964): required sapwood cross-section accumulates
   bottom-up from distal leaf-area demand, plus a Greenhill-style
   `radius ~ height^1.5` mechanical floor on the trunk for
   self-support. Radius never shrinks.
7. **Phyllotaxis / branching geometry** -- lateral buds are placed along
   each new internode at a golden-angle (137.5°) spiral with a
   configurable branching angle, plus gravitropic droop and phototropic
   straightening.

All constants live in one place, `src/sim/params.ts`, documented with the
literature/reasoning behind each.

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
