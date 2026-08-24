/**
 * Core data model for the tree-growth simulation.
 *
 * Design goals:
 *  - The model is a plain, serializable data structure (no classes, no
 *    behavior) so that a whole simulation run can be dumped to JSON,
 *    downloaded, re-uploaded, and rendered without re-running any growth
 *    logic. The simulation (src/sim) and the renderer (src/render) only
 *    ever talk to each other through these types.
 *  - A tree is a rooted tree graph of woody "segments" (internodes between
 *    branching points / buds), each with its own thickness, plus a set of
 *    buds (the growing points, active or dormant or dead) and a set of
 *    leaves (the current photosynthetic surface). This mirrors how
 *    botanists actually describe woody plant architecture (Barthélémy &
 *    Caraglio's "architectural analysis" framework: axes, growth units,
 *    and meristems).
 */

/** A point or direction in world space, meters. Direction vectors are unit length. */
export type Vec3 = readonly [number, number, number];

export type BudType = 'apical' | 'axillary';

/**
 * Which half of the tree a segment/bud belongs to. 'shoot' is everything
 * above the root collar (the original canopy model); 'root' is the new
 * below-ground root system, grown by a separate (but carbon-budget-
 * competing) process -- see growRoots in growth.ts. Segments/buds of both
 * kinds share the exact same graph structure (a root segment's parentId
 * can be the root-collar segment, id 0, exactly like a shoot segment's),
 * which is what lets the existing renderer, serialization, and generic
 * per-segment mechanics (radius, alive-flag propagation, etc.) work on
 * roots with no changes -- but several *shoot-specific* traversals (DBH's
 * trunk-chain walk, the crown/canopy metrics, light-driven senescence)
 * must filter on this field rather than assuming every segment is part of
 * the canopy.
 */
export type SegmentKind = 'shoot' | 'root';

/**
 * - active: this bud may still produce a new growth unit (segment) in a
 *   future growing season.
 * - dormant: temporarily suppressed (e.g. by apical dominance / low vigor)
 *   but still alive and able to reactivate (e.g. after release from
 *   apical control, or epicormic reactivation).
 * - dead: aborted or senesced; will never grow again. Kept in the record
 *   for debugging/visualization (e.g. to show where a branch used to be
 *   able to grow).
 */
export type BudStatus = 'active' | 'dormant' | 'dead';

export interface Bud {
  id: number;
  /** The segment this bud sits at the growing tip of. */
  segmentId: number;
  type: BudType;
  /** 'shoot' (the canopy, grown by stepYear) or 'root' (the below-ground
   * root system, grown by growRoots) -- see SegmentKind. */
  kind: SegmentKind;
  status: BudStatus;
  position: Vec3;
  /** Preferred growth heading if this bud elongates (unit vector). */
  direction: Vec3;
  /** Branch order of the axis this bud belongs to (0 = trunk/leader). */
  order: number;
  /**
   * Persistent "hormonal" vigor trait in [0, 1], carried and decayed along
   * the lineage of buds (apicalVigorRetention on continuation,
   * lateralVigorRatio on branching). This is the apical-dominance /
   * auxin-gradient component: it never recovers, unlike lightExposure or
   * the hydraulic factor, which are recomputed fresh every year.
   */
  hormonalVigor: number;
  /**
   * Computed per-step realized vigor in [0, 1] = hormonalVigor *
   * hydraulic factor * light factor, the fraction of potential elongation
   * this bud will actually achieve this year. Exposed for debug rendering
   * (color by vigor).
   */
  vigor: number;
  /**
   * Local auxin (apical-dominance signal) level in [0, 1] impinging on this
   * bud from more apical/dominant buds. Exposed for debug rendering.
   */
  auxinLevel: number;
  /** Local light exposure in [0, 1] (Beer-Lambert canopy shading estimate). */
  lightExposure: number;
  ageYears: number;
  /** Consecutive years this bud's realized vigor has been below minViableVigor. Drives senescence. */
  shadeYears: number;
  /**
   * Consecutive years this bud has been carbon/hydraulically stalled
   * below a whole new growth increment (MIN_GROWTH_LENGTH) -- i.e. years
   * spent as a non-elongating "spur" rather than genuinely dead or
   * actively extending. Drives spur senescence (spurSenescenceYears):
   * even a bud that's getting perfectly good light doesn't coast at
   * "barely alive, adding nothing" forever, matching how real spur
   * shoots have a finite productive lifespan regardless of light.
   */
  stalledYears: number;
}

/**
 * One internode: the woody segment between a parent branch point (or the
 * ground) and a child bud/branch point. Radius is stored at both ends so
 * the renderer can draw a tapered frustum instead of a uniform cylinder.
 */
export interface BranchSegment {
  id: number;
  parentId: number | null;
  childIds: number[];
  /** 'shoot' (canopy) or 'root' (below-ground) -- see SegmentKind. Both
   * kinds coexist in one graph: a root segment's parentId can be the
   * root-collar segment (id 0) exactly like a shoot segment's. */
  kind: SegmentKind;
  /** 0 = trunk (for a shoot) or a main structural root (for a root).
   * Increments by 1 at each branching (lateral) event, independently
   * within each kind. */
  order: number;
  start: Vec3;
  end: Vec3;
  baseRadius: number;
  tipRadius: number;
  /** Simulation year (tree age) this segment was formed. */
  createdYear: number;
  /** False once senesced (self-pruned). Dead wood is kept for a while before abscission. */
  alive: boolean;
  /** Current-year foliage carried directly on this segment, m^2 -- for a
   * root-kind segment, this field instead holds absorptive fine-root
   * surface area, the standard below-ground analogue of leaf area in
   * whole-plant carbon/water-economy models (Brouwer's "functional
   * equilibrium" framework): it drives the root pipe-model demand the
   * same way leaf area drives a shoot's, but contributes nothing to
   * photosynthesis, canopy shading, or the rendered leaf point cloud. */
  leafArea: number;
  /** Debug: 0..1 canopy light exposure at this segment's tip (roots: unused, always 1). */
  lightExposure: number;
  /** Debug: cumulative hydraulic path resistance from the root to this segment's tip. */
  hydraulicResistance: number;
}

export interface Leaf {
  id: number;
  segmentId: number;
  position: Vec3;
  normal: Vec3;
  area: number;
  ageYears: number;
}

export interface TreeMetrics {
  /** Total tree height, meters. */
  height: number;
  /** Trunk diameter at breast height (1.3m), meters. */
  dbh: number;
  /** Height of the lowest living, foliage-bearing point, meters ("crown base"). */
  crownBaseHeight: number;
  /** Horizontal diameter of the live-crown bounding cylinder, meters. */
  crownWidth: number;
  totalLeafArea: number;
  liveSegmentCount: number;
  deadSegmentCount: number;
  /** Sum of segment volumes (a crude proxy for woody biomass), m^3. */
  woodyVolume: number;
  /**
   * Sum of segment volumes restricted to `alive` wood (still bearing
   * foliage, or still structurally supporting some living descendant),
   * m^3. Real maintenance respiration is a property of living sapwood,
   * not of standing dead wood awaiting abscission -- this is what the
   * carbon budget charges upkeep against, so a spike in recent deaths
   * doesn't itself inflate the tree's own respiration bill on top of
   * costing it the leaf area.
   */
  liveWoodyVolume: number;
  /** Horizontal radius of the furthest-reaching live root, meters -- the
   * below-ground analogue of crownWidth/2. */
  rootSpread: number;
  /** Depth (positive, meters) of the deepest live root below grade. */
  rootDepth: number;
  /** Sum of root-segment volumes (any kind === 'root' segment), m^3 --
   * the below-ground counterpart to woodyVolume, which sums *all*
   * segments (shoot + root) as total whole-tree woody biomass. */
  rootWoodyVolume: number;
}

export interface TreeState {
  /** Tree age in years. */
  year: number;
  segments: BranchSegment[];
  buds: Bud[];
  leaves: Leaf[];
  metrics: TreeMetrics;
}

/**
 * All tunable biological parameters for a single species/individual. Kept
 * as one flat, serializable record so a run's parameters travel with its
 * history and different presets can be compared later.
 */
export interface SimulationParams {
  /** RNG seed for reproducibility. */
  seed: number;

  // --- Elongation / apical growth ---
  /** Potential (unstressed) annual leader elongation at age 0, meters/year. */
  baseInternodeLength: number;
  /** Max potential annual elongation a fully-vigorous apex can reach, meters/year. */
  maxInternodeLength: number;
  /** Years to ramp from base to max potential elongation (juvenile vigor ramp). */
  juvenileRampYears: number;

  // --- Hydraulic limitation (why height plateaus) ---
  /**
   * Height (m) at which the hydraulic-limitation vigor/efficiency factor
   * is reduced to 50% (a sharpened saturating curve -- see
   * heightVigorFactor in growth.ts), applied continuously (never a hard
   * cutoff) both to a bud's own realized vigor and to how efficiently
   * foliage at that height contributes to the whole tree's carbon supply
   * (see stepYear in growth.ts). This is a direct stand-in
   * for water-potential-driven hydraulic limitation -- the taller a
   * shoot's path to the ground, the harder it is to pull water up
   * against gravity and xylem resistance, so both its own growth *and*
   * its leaves' realized gas exchange/photosynthesis decline gradually
   * with absolute height (Koch, Sillett, Jennings & Davis 2004, "The
   * limits to tree height," documents reduced leaf-level gas exchange in
   * the very tallest foliage). Keying this directly on height instead of
   * on accumulated path *resistance* (radius/length along the actual
   * branch skeleton, which the older mechanism used) makes it a simple,
   * predictable, and correctly-calibratable control over a species'
   * asymptotic mature height: half-height IS, roughly, the height at
   * which growth visibly starts slowing down. `hydraulicResistance` is
   * still tracked per segment (pipeModel.ts) for the pipe model /
   * mechanical thickening and the "hydraulicStress" debug color mode --
   * it's a real, physically meaningful quantity -- it just no longer
   * independently throttles vigor now that this height-based factor does
   * that job in a way that's actually tunable end-to-end.
   */
  heightVigorHalfHeight: number;

  // --- Branching / phyllotaxis ---
  /** Divergence (branching) angle from the parent axis, radians. */
  branchingAngle: number;
  /** Azimuthal (phyllotactic) rotation applied to successive laterals, radians. */
  phyllotacticAngle: number;
  /** Number of lateral bud sites placed along each new leader/branch segment. */
  nodesPerInternode: number;
  /** Probability a given axillary node actually breaks bud into a lateral this year. */
  budBreakProbability: number;
  /**
   * Fraction of a bud's hormonal vigor retained by the axis when it
   * continues apically. Real apical control gets *stronger*, not
   * weaker, as an axis matures relative to newer competing branches, so
   * deeper (higher-order) axes decay faster per year via
   * lateralAgingPenalty below -- this is what keeps thin,
   * actively-extending growth concentrated toward the current
   * frontier(s) of the tree instead of old branches indefinitely
   * re-sprouting just as much new growth as a fresher one. This applies
   * identically to every axis: there is no separate "trunk" rule --
   * whichever axis happens to keep the most vigor over time reads as
   * the trunk, as an emergent outcome rather than a hardcoded label.
   */
  apicalVigorRetention: number;
  /** Extra per-year hormonal decay applied to a continuing axis, scaled by its branch order (depth from the seed). */
  lateralAgingPenalty: number;
  /**
   * Extra per-year hormonal decay applied to every continuing axis
   * regardless of order. Real "decurrent" broadleaf trees gradually
   * lose central apical control as they mature (unlike an "excurrent"
   * conifer, which keeps a dominant leader for life): this is what lets
   * freshly-formed upper branches eventually rival an old, long-decaying
   * one's vigor, rounding out the crown top instead of it staying a
   * sharp cone indefinitely.
   */
  trunkAgingPenalty: number;
  /** Fraction of a parent bud's hormonal vigor an ordinary (non-co-dominant) new lateral bud inherits. */
  lateralVigorRatio: number;
  /**
   * Probability that a newly-breaking lateral bud is co-dominant with
   * its parent instead of an ordinary, steeply-discounted subordinate --
   * applied identically at *every* branch point in the tree, at any
   * order or age, not just "the trunk". This is what lets a young tree
   * fork into multiple comparably thick stems (as real broadleaf
   * saplings often do) as one instance of a single, scale-invariant
   * branching rule, rather than a special case reserved for a
   * privileged central axis -- avoiding any hub-and-spoke bias in the
   * resulting topology. A co-dominance event deep in an already-slender
   * axis still inherits that axis's own already-diminished vigor, so it
   * naturally reads as "a slightly thicker twig" rather than a visible
   * new trunk -- visual significance is an emergent function of when
   * the event happens, not of a hardcoded order check.
   */
  coDominanceProbability: number;
  /** Fraction of the parent's hormonal vigor a co-dominant lateral inherits (close to lateralVigorRatio's ceiling = genuinely competitive). */
  coDominantVigorRatio: number;

  // --- Gravitropism / phototropism (shape) ---
  /** How strongly lateral branches droop under their own weight (0 = rigid). */
  gravitropicDroop: number;
  /** How strongly growth direction re-orients toward vertical/light (0..1/yr). */
  phototropicPull: number;
  /**
   * Sun zenith angle, radians from straight overhead (0 = directly
   * overhead, as at midday near the equator; larger = a lower, more
   * oblique sun, as at high latitude or in a winter/morning/evening
   * light). Purely an environmental/site setting, not a species trait.
   * Only matters together with heliotropismStrength below -- an
   * overhead sun (0) gives zero heliotropic bending regardless of that
   * strength, since there is no consistent horizontal direction to bend
   * toward.
   */
  sunZenithAngle: number;
  /** Compass direction (radians) the sun is in, when sunZenithAngle > 0. */
  sunAzimuth: number;
  /**
   * How strongly a shaded shoot bends its growth direction toward the
   * sun (heliotropism/phototropism proper, distinct from the vertical
   * negative-gravitropism straightening above). Real shoots in
   * directional light do bend toward it, especially when locally shaded
   * and especially under a low, oblique sun where the light gradient
   * across the canopy is more pronounced -- this is what makes the
   * canopy lean and thicken toward the sun rather than staying
   * perfectly radially symmetric.
   */
  heliotropismStrength: number;
  /**
   * Random per-year perturbation (radians) applied to a *continuing*
   * axis's growth direction before phototropicPull straightens it back
   * toward vertical -- what actually distinguishes a conifer's
   * ruler-straight trunk from a real deciduous tree's leaning, zigzagging
   * one. Real apical control isn't a rigid mechanical constraint, it's a
   * *consistency* of correction: an excurrent conifer keeps one apical
   * meristem under strong, essentially unbroken hormonal dominance for
   * its whole life, so tiny deviations get corrected before they add up
   * to anything visible. A decurrent broadleaf's nominal leader has much
   * weaker/less consistent control (and, especially, is often replaced
   * outright -- terminal-bud dieback/abortion and takeover by a lateral,
   * "sympodial" growth, is part of many species' normal developmental
   * program, not just storm/frost/herbivory damage) -- see Hallé,
   * Oldeman & Tomlinson's classic excurrent/decurrent architectural-model
   * distinction. Either way, small early deviations, once corrected for,
   * still leave the *already-grown* wood exactly where it was laid down
   * (unlike a green shoot, lignified wood doesn't unbend) -- so this is a
   * random walk with a restoring force (phototropicPull): individually
   * tiny, zero-mean year-to-year wobbles accumulate into a real, lasting
   * wave over a trunk's lifetime instead of averaging out. Applied
   * identically to every continuing axis (no special-cased "trunk"),
   * same as every other shape rule -- it just happens to read as trunk
   * waviness because that's the axis with the longest, thickest-growing
   * record of it. 0 = razor-straight (conifer); higher = a more
   * wandering, leaning main stem (broadleaf).
   */
  trunkWaviness: number;

  // --- Secondary growth (thickening) ---
  /**
   * Pipe-model proportionality: required sapwood cross-section area per
   * unit distal leaf area supported, m^2 per m^2.
   */
  pipeModelRatio: number;
  /** Extra radial increment purely from mechanical (self-weight) demand. */
  mechanicalThickeningFactor: number;

  // --- Leaves & light ---
  /** Leaf area added per meter of new shoot growth, m^2/m. */
  leafAreaPerShootLength: number;
  /** Years a segment keeps bearing foliage after formation before its leaves are shed. */
  leafLifespanYears: number;
  /** Beer-Lambert canopy light extinction coefficient. */
  lightExtinctionCoefficient: number;
  /** Light exposure below which a bud/segment is carbon-starved. */
  senescenceLightThreshold: number;
  /** Consecutive shaded years tolerated before a branch is marked dead. */
  senescenceYearsTolerance: number;
  /**
   * Self-thinning carrying capacity: maximum number of simultaneously
   * live buds the crown will support. Real canopies show exactly this
   * kind of density-dependent limit on growing-point number (Reineke's
   * self-thinning rule); modeling it directly keeps bud/segment count
   * bounded even before the carbon budget and light competition below
   * have fully caught up with a burst of favorable growing seasons.
   */
  maxActiveBuds: number;
  /**
   * Self-thinning is applied as a *ramp*, not a hard on/off switch: below
   * selfThinningOnsetFraction of maxActiveBuds, no relative (percentile)
   * thinning happens at all; the pruned fraction then rises linearly to
   * selfThinningMaxFraction per year as the crown fills up. A hard
   * threshold produces an unrealistic "cliff" where the whole lower
   * crown senesces in near-lockstep the moment capacity is crossed; the
   * ramp spreads that transition across many years, so the live crown
   * base rises roughly continuously instead of jumping.
   */
  selfThinningOnsetFraction: number;
  /** Maximum fraction of live buds culled by relative (percentile) self-thinning in a single year. */
  selfThinningMaxFraction: number;
  /** Years a dead branch persists before abscission (removal from the record). */
  abscissionYears: number;
  /**
   * A bud that's gone this many consecutive years without managing a
   * whole new growth increment (a non-elongating "spur") senesces
   * regardless of how well-lit it currently is. Real spur shoots have a
   * finite productive lifespan even in good light (temperate fruit-tree
   * physiology puts it at roughly 5-15 years); this is also what keeps a
   * stalled bud from coasting forever purely because the geometric
   * shadow-casting light model never happens to find anything genuinely
   * overhead at its specific spot -- age, not just light, eventually
   * retires an unproductive growing point.
   */
  spurSenescenceYears: number;
  /**
   * A bud that's stayed below lowBranchOcclusionHeight for more than
   * this many years dies, independent of light. Real low branches near
   * a trunk's base don't only lose out to shade: as the trunk keeps
   * thickening via secondary growth (see pipeModel.ts), a nearby low
   * branch's own base gets progressively overtaken/occluded (bark
   * inclusion), pinching off its vascular connection -- a well-documented
   * mechanism distinct from light competition. Modeled as a simple
   * height+age rule rather than literally tracking trunk-radius overlap.
   */
  lowBranchOcclusionAge: number;
  /** Height (m) below which a persisting low branch is at risk of trunk occlusion; see lowBranchOcclusionAge. */
  lowBranchOcclusionHeight: number;

  // --- Whole-tree carbon budget (growth-efficiency-decline mechanism) ---
  /**
   * Annual maintenance respiration cost per unit of standing woody
   * volume, in the same arbitrary carbon units as one unit of fully-lit
   * leaf area's annual assimilation (i.e. photosynthesis rate is
   * normalized to 1). Bigger trees spend more of their carbon budget
   * simply maintaining existing wood (Ryan & Yoder 1997), leaving less
   * for new growth -- a second, independent mechanism (alongside
   * hydraulic limitation) that causes growth to decelerate with size.
   */
  respirationPerWoodyVolume: number;
  /** Carbon cost of producing one meter of new shoot (wood + leaves), same units as above. */
  carbonCostPerMeterGrowth: number;

  // --- Root system (below-ground growth) ---
  /**
   * Target fraction of the whole tree's net annual carbon that goes to
   * root growth rather than shoot growth, applied as a fixed split of
   * the same shared carbon pool shoots draw from (see growRoots in
   * growth.ts). Real trees show plastic, demand-driven reallocation
   * between roots and shoots (Brouwer's "functional equilibrium"
   * hypothesis: a water/nutrient-stressed tree shifts more carbon to
   * roots, a light-stressed one shifts more to shoots) -- this model
   * uses a fixed target ratio rather than that full dynamic feedback, a
   * deliberate simplification. The target itself is a real, commonly
   * cited figure: root mass fraction in trees typically runs ~20-30% of
   * total biomass (Poorter et al. 2012, "Biomass allocation to leaves,
   * stems and roots," *New Phytologist* 193).
   */
  rootCarbonAllocationFraction: number;
  /** Number of main structural roots radiating out from the root collar,
   * fanned evenly in azimuth -- the below-ground analogue of the seedling
   * starting with one leader, except real root systems typically develop
   * several major structural roots from the start rather than one taproot. */
  numMainRoots: number;
  /** Divergence angle (radians) of a main structural root from straight
   * down. 0 = a single deep taproot; larger = a shallower, wider-spreading
   * "root plate" habit (real root architecture varies from deep taproots
   * in well-drained/arid soils to shallow plates in wet or compacted
   * ones). */
  rootSpreadAngle: number;
  /**
   * How strongly a root's growth direction re-orients toward straight
   * down each year -- the root system's geotropism, directly analogous
   * to phototropicPull for shoots (which re-orients toward vertical/
   * light) except pulling the opposite way.
   */
  rootGeotropicPull: number;
  /**
   * Depth (m, positive) at which the root depth-limitation vigor factor
   * is reduced to 50%, using the exact same saturating curve as
   * heightVigorHalfHeight (see heightVigorFactor in growth.ts) evaluated
   * on depth instead of height. Standing in for increasing soil
   * compaction, oxygen limitation, and (eventually) a water table --
   * real fine-root biomass concentrates heavily in the upper ~1m of soil
   * for most temperate trees, with structural roots occasionally
   * reaching further; this is what gives root depth a real asymptote
   * instead of unbounded growth.
   */
  rootDepthHalfDepth: number;
  /** Absorptive (fine-root) surface area a live root tip's own segment
   * carries per meter of its own length, m^2/m -- the root-system
   * analogue of leafAreaPerShootLength, driving root pipe-model demand
   * the same way leaf area drives a shoot's (see the field doc on
   * BranchSegment.leafArea). */
  rootAbsorptiveAreaPerLength: number;
}

export interface SimulationHistory {
  formatVersion: 1;
  species: string;
  params: SimulationParams;
  states: TreeState[];
}

// --- Forest simulation -----------------------------------------------
//
// A forest is a *population* of individual trees, each grown by exactly
// the same single-tree engine above (stepYear/growRoots), sharing one
// species' SimulationParams -- reproduction makes more individuals of the
// same species, not new species -- but each with its own (x, z) planting
// position, its own RNG stream, and its own independent age (a
// later-germinated tree is younger than its parent at the same forest
// year). See src/sim/forest.ts.
//
// Two forces couple otherwise-independent trees together each forest
// year: light competition (a forest-wide shadow-casting light profile
// built from every living tree's canopy, in world coordinates -- see
// buildForestLightProfile in light.ts, a direct extension of the
// single-tree shadow-map) and root-space competition (a forest-wide
// below-ground crowding profile -- see buildRootResourceProfile in
// rootCompetition.ts, the isotropic below-ground analogue of the same
// idea). Both feed into the ordinary per-tree stepYear the exact same way
// a lone tree's own light profile always has, via stepYear's optional
// `external` argument -- a lone tree (external omitted) grows exactly as
// before.

/** Forest-management-level constants -- population dynamics, not species
 * biology, so they're a separate params object from SimulationParams
 * (which every tree in the forest shares) rather than more fields on it.
 * See src/sim/forestParams.ts for defaults/citations. */
export interface ForestParams {
  /** How many forest-years to simulate. */
  years: number;
  /**
   * Hard cap on concurrently-*alive* trees. Every tree keeps the full
   * mechanical/root model and a full per-year scrubbable history exactly
   * like a single tree does today, so this is a real cost multiplier
   * (memory and CPU both scale with it) -- kept to a "small stand" scale
   * on purpose rather than trying to approximate a much larger stand with
   * simplified trees.
   */
  maxTrees: number;
  /** A tree becomes reproductively mature (starts rolling for seed
   * dispersal each year) once its own height reaches this, meters. */
  maturityHeight: number;
  /** Per-mature-tree, per-forest-year probability of a seed-dispersal event. */
  reproductionProbability: number;
  /** Seeds scattered per successful dispersal event. */
  seedsPerEvent: number;
  /** Max scatter distance from the parent tree's own base, meters -- an
   * actual distance is drawn uniformly at random up to this on each
   * scattering event (real seed dispersal -- wind, gravity, animals --
   * falls off with distance from the parent; a uniform draw up to a cap
   * is a simple stand-in for that falloff without modeling a full
   * dispersal kernel). */
  seedDispersalRadius: number;
  /** Minimum allowed spacing between a new seedling and any existing
   * living tree, meters -- real seedlings essentially never establish
   * directly in an existing trunk's footprint. */
  minTreeSpacing: number;
  /** Ground-level light exposure (same [0,1] Beer-Lambert scale as a
   * bud's own lightExposure) a seed needs at its landing spot to actually
   * germinate -- real tree seedlings establish poorly in the deep shade
   * of an existing closed canopy, which is what stops a mature stand's
   * own understory from germinating in place under itself indefinitely. */
  germinationLightThreshold: number;
  /** A tree's own mean canopy light exposure has to stay at or below this
   * for `lightStarvationYears` running before whole-tree mortality even
   * starts rolling -- the below-ground/above-ground shared-resource
   * analogue of a single bud's own senescenceLightThreshold, but applied
   * to a *whole tree* (see ForestTree.starvedYears) rather than to one
   * bud, since this is what lets a whole light-starved tree die and be
   * removed rather than just shedding its lowest branches. */
  lightStarvationThreshold: number;
  /** Years a tree can spend below lightStarvationThreshold before its
   * whole-tree death hazard starts ramping up (rampedDeathProbability,
   * same asymptotic-hazard style used throughout growth.ts, never a hard
   * single-year cutoff). */
  lightStarvationYears: number;
}

/** A currently-alive tree's per-forest-year bookkeeping that doesn't
 * belong on TreeState/SimulationParams themselves (they're both
 * per-*individual-tree-age* concepts, not per-forest-year population
 * ones). */
export interface ForestTree {
  /** Unique within a forest run; never reused, including after death. */
  id: number;
  /** World-space (x, z) planting position, meters -- constant for this
   * tree's whole life. Its own TreeState.segments stay in the same
   * tree-local coordinates a lone tree's always have (base at the
   * origin); this offset is applied only when building forest-wide
   * cross-tree profiles and when rendering. */
  position: readonly [number, number];
  /** This tree's own RNG seed (minted from the forest's own RNG stream at
   * germination), so a forest run is fully deterministic from one top-level
   * forestSeed the same way a single tree run is from params.seed. */
  seed: number;
  /** Forest-year this tree germinated (age 0 at that year). */
  plantedYear: number;
  /** Consecutive forest-years (so far) this tree's mean canopy light
   * exposure has been at or below lightStarvationThreshold -- see
   * ForestParams.lightStarvationYears. Resets to 0 the moment exposure
   * recovers above threshold in any given year. */
  starvedYears: number;
  /** This tree's own current TreeState (its state at its own age =
   * currentForestYear - plantedYear). */
  state: TreeState;
}

/** A tree that has died and been removed from the forest -- kept only as
 * a small "memorial" record (not its full segment graph/history, which is
 * dropped) for the death log/UI, since a dead, removed tree has no further
 * effect on the simulation. */
export interface DeadTree {
  id: number;
  position: readonly [number, number];
  plantedYear: number;
  diedYear: number;
  /** Cause, for the UI's death log -- currently the only whole-tree
   * mortality mechanism modeled is sustained light starvation, but this
   * is a string rather than a fixed union so a future mechanism (e.g.
   * root-space starvation, wind-throw) doesn't need every past save file
   * to be migrated. */
  cause: string;
  finalHeight: number;
  finalDbh: number;
}

/** One forest-year's full, self-contained snapshot: every currently-alive
 * tree's own current TreeState, plus the death log so far. Deliberately
 * does *not* nest each tree's own per-year sub-history (that would be
 * O(forestYears x treeCount x treeAge) -- unlike a single tree's history,
 * which keeps every past year's full TreeState because that *is* the
 * record being built, a forest scrub only ever needs "what did the forest
 * look like in year Y", which is exactly this). */
export interface ForestSnapshot {
  forestYear: number;
  trees: ForestTree[];
  deadTrees: DeadTree[];
}

export interface ForestHistory {
  formatVersion: 1;
  /** The one species every tree in the forest shares (see the module doc
   * above) -- reproduction makes more individuals, not new species. */
  params: SimulationParams;
  forestParams: ForestParams;
  /** Top-level RNG seed the whole forest run (reproduction rolls,
   * dispersal offsets, and each new tree's own minted seed) is
   * deterministic from. */
  forestSeed: number;
  states: ForestSnapshot[];
}
