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
  /** 0 = trunk. Increments by 1 at each branching (lateral) event. */
  order: number;
  start: Vec3;
  end: Vec3;
  baseRadius: number;
  tipRadius: number;
  /** Simulation year (tree age) this segment was formed. */
  createdYear: number;
  /** False once senesced (self-pruned). Dead wood is kept for a while before abscission. */
  alive: boolean;
  /** Current-year foliage carried directly on this segment, m^2. */
  leafArea: number;
  /** Debug: 0..1 canopy light exposure at this segment's tip. */
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
   * Reference hydraulic path resistance at which vigor is reduced to 50%.
   * Path resistance accumulates as (length / radius^4) along the trunk, so
   * this constant sets, in effect, the species' asymptotic height.
   */
  hydraulicResistanceHalfVigor: number;

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
}

export interface SimulationHistory {
  formatVersion: 1;
  species: string;
  params: SimulationParams;
  states: TreeState[];
}
