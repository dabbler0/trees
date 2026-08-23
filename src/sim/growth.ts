import type { Bud, BranchSegment, SimulationParams, TreeState } from '../model/types';
import {
  add,
  arbitraryOrthogonal,
  cross,
  distance,
  lerp,
  normalize,
  rotateAroundAxis,
  scale,
  type Vec3,
} from '../model/vec3';
import { buildLightProfile } from './light';
import { applyPipeModelAndMechanics, computeHydraulicResistances } from './pipeModel';
import { recomputeAliveFlags, computeMetrics } from './metrics';
import { placeLeaves } from './leaves';

const MIN_TWIG_RADIUS = 0.0025;
/** Below this annual elongation (1cm), a bud just waits rather than
 * banking an ever-growing tail of near-zero-length segments. */
const MIN_GROWTH_LENGTH = 0.01;
/** Hard safety cap so a pathological parameter set can't blow up memory/CPU
 * in the browser or in a long-running test; real self-shading should keep
 * well under this. */
const MAX_SEGMENTS = 120_000;

export interface GrowthContext {
  nextSegmentId: number;
  nextBudId: number;
}

export function createInitialState(): { state: TreeState; ctx: GrowthContext } {
  const rootSegment: BranchSegment = {
    id: 0,
    parentId: null,
    childIds: [],
    order: 0,
    start: [0, 0, 0],
    end: [0, 0.02, 0],
    baseRadius: MIN_TWIG_RADIUS,
    tipRadius: MIN_TWIG_RADIUS,
    createdYear: 0,
    alive: true,
    leafArea: 0,
    lightExposure: 1,
    hydraulicResistance: 0,
  };
  const seedBud: Bud = {
    id: 0,
    segmentId: 0,
    type: 'apical',
    status: 'active',
    position: [0, 0.02, 0],
    direction: [0, 1, 0],
    order: 0,
    hormonalVigor: 1,
    vigor: 1,
    auxinLevel: 1,
    lightExposure: 1,
    ageYears: 0,
    shadeYears: 0,
  };
  const segmentMap = new Map([[rootSegment.id, rootSegment]]);
  computeHydraulicResistances(segmentMap); // keep this consistent with every later year's segments, rather than a hand-set placeholder
  const segments = [...segmentMap.values()];
  const state: TreeState = {
    year: 0,
    segments,
    buds: [seedBud],
    leaves: [],
    metrics: computeMetrics(segments),
  };
  return { state, ctx: { nextSegmentId: 1, nextBudId: 1 } };
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/**
 * Phototropic straightening scales with an axis's own persistent
 * hormonal vigor, not with a hardcoded "is this the trunk" check: a
 * still-dominant axis (whatever its branch order, or how it came to be
 * dominant -- the original leader, or a co-dominant fork) holds a
 * strong vertical bias, while a weaker one drifts more. This is a
 * continuous, self-similar rule applied identically everywhere in the
 * tree, so a "trunk" is whichever axis ends up with the most vigor over
 * time, an emergent outcome rather than a privileged label -- and nothing
 * stops that axis from wobbling, since it's still just a lerp toward
 * vertical, not a hard override.
 */
function apexDirection(prevDir: Vec3, hormonalVigor: number, params: SimulationParams): Vec3 {
  const pull = params.phototropicPull * clamp01(hormonalVigor);
  return normalize(lerp(prevDir, [0, 1, 0], pull));
}

function lateralDirection(parentDir: Vec3, branchingAngle: number, azimuth: number): Vec3 {
  const e0 = arbitraryOrthogonal(parentDir);
  const e1 = rotateAroundAxis(e0, parentDir, azimuth);
  const axis = cross(parentDir, e1);
  return normalize(rotateAroundAxis(parentDir, axis, branchingAngle));
}

/** Gravitropic droop, symmetrically: a vigorous axis is stiffer/better
 * supported and droops little; a weak one sags more. Same continuous,
 * order-and-trunk-agnostic rule as apexDirection above. */
function applyDroop(dir: Vec3, hormonalVigor: number, params: SimulationParams): Vec3 {
  const amount = params.gravitropicDroop * clamp01(1 - hormonalVigor);
  return normalize(lerp(dir, [0, -1, 0], amount));
}

/**
 * Advance the tree by exactly one growing season (one year). Pure function
 * of (previous state, params, rng, id context) -> next state; the engine
 * has no notion of a renderer or wall-clock time.
 *
 * Growth mechanisms, in the order they're applied:
 *  1. Build a canopy light profile from *last* year's foliage (a tree
 *     "decides" this year's growth based on the light environment it
 *     ended last season in), and a whole-tree carbon budget: supply is
 *     last year's *sunlit* leaf area (self-shaded leaves contribute
 *     little), demand is maintenance respiration on standing woody
 *     volume (Ryan & Yoder 1997's growth-efficiency-decline mechanism --
 *     bigger trees spend more of their assimilate just staying alive).
 *  2. Every active bud gets a demand weight = hormonalVigor (an
 *     apical-dominance / auxin-gradient trait, decayed on branching) x
 *     hydraulic factor (saturating with the bud's cumulative path
 *     resistance -- the hydraulic-limitation-hypothesis mechanism for a
 *     height plateau, Koch et al. 2004). The year's net carbon is then
 *     divided across all demanding buds in proportion to their weight,
 *     exactly like real source-sink carbon allocation, which is what
 *     keeps total new growth bounded by whole-tree photosynthetic
 *     capacity instead of letting local rules alone blow up.
 *  3. A bud senesces (self-prunes) only from sustained *local* shade
 *     (a carbon-balance/light phenomenon distinct from the whole-tree
 *     budget above) -- so a fully-lit leader never dies of hydraulic or
 *     carbon stress, it simply slows down, producing a plateau rather
 *     than a cutoff.
 *  4. Elongate every surviving active bud by its allocated share, and
 *     stochastically break new lateral (axillary) buds along the new
 *     growth, spaced by a golden-angle phyllotactic spiral.
 *  5. Recompute foliage, then re-run secondary growth (pipe model +
 *     mechanical thickening) and hydraulic resistances for next year.
 */
export function stepYear(
  prev: TreeState,
  params: SimulationParams,
  rng: () => number,
  ctx: GrowthContext
): TreeState {
  const year = prev.year + 1;
  const segments = new Map<number, BranchSegment>();
  for (const s of prev.segments) segments.set(s.id, { ...s, childIds: [...s.childIds] });

  const lightProfile = buildLightProfile(prev.segments, params);
  const ageRamp = Math.min(1, year / params.juvenileRampYears);
  const potentialElongation =
    params.baseInternodeLength + (params.maxInternodeLength - params.baseInternodeLength) * ageRamp;

  // --- Whole-tree carbon budget (source: sunlit leaf area; sink: upkeep
  // of standing wood). This is what ultimately caps how much total new
  // growth the tree can afford this year, regardless of how many buds
  // would individually like to grow. ---
  let effectiveSunlitLeafArea = 0;
  for (const s of prev.segments) {
    if (s.leafArea <= 0) continue;
    const mid = (s.start[1] + s.end[1]) / 2;
    effectiveSunlitLeafArea += s.leafArea * lightProfile.exposureAt(mid);
  }
  const carbonSupply = effectiveSunlitLeafArea;
  const maintenanceCost = params.respirationPerWoodyVolume * prev.metrics.woodyVolume;
  // A tiny reserve floor (stored starch, etc.) rather than a hard zero:
  // real trees under carbon stress don't instantly, permanently freeze
  // the moment respiration nominally exceeds fresh assimilation in one
  // year's accounting -- they draw down reserves and keep making a
  // trickle of new growth. Without this, net carbon can hit exactly
  // zero and lock the whole tree into a single, permanently frozen
  // snapshot rather than continuing to slowly fill out for decades.
  const netCarbon = Math.max(carbonSupply * 0.015, carbonSupply - maintenanceCost);

  const buds: Bud[] = prev.buds.map((b) => ({ ...b }));
  const growthCapped = segments.size >= MAX_SEGMENTS;

  // Pass 1: update hormonal/hydraulic/light state, resolve senescence,
  // and compute each surviving bud's demand weight for this year's carbon.
  interface Candidate {
    bud: Bud;
    demand: number;
    dir: Vec3;
  }
  const candidates: Candidate[] = [];

  // Self-thinning also needs a *relative* light criterion, not just the
  // absolute Beer-Lambert threshold below: once the crown is near its
  // carrying capacity, real stands reliably shed their worst-lit
  // fraction every year (Reineke self-thinning), which is what actually
  // makes the crown base creep upward at a steady, predictable rate. An
  // absolute-threshold-only rule is numerically brittle here -- whether
  // *any* pruning happens at all ends up hinging on getting the
  // extinction coefficient right to several significant figures, because
  // the whole canopy's light climate moves together. Ranking buds
  // against each other sidesteps that: it's still real shading (the
  // *rank* comes straight from the Beer-Lambert exposure), just applied
  // as "shed the shadiest tenth" instead of "shed everyone below X".
  const nonDeadBuds = buds.filter((b) => b.status !== 'dead');
  const exposures = nonDeadBuds.map((b) => lightProfile.exposureAt(b.position[1])).sort((a, b) => a - b);
  const capacityFraction = nonDeadBuds.length / params.maxActiveBuds;
  const rampSpan = Math.max(1e-6, 1 - params.selfThinningOnsetFraction);
  const thinFraction =
    params.selfThinningMaxFraction *
    Math.max(0, Math.min(1, (capacityFraction - params.selfThinningOnsetFraction) / rampSpan));
  const percentileCutoff = thinFraction > 0 ? exposures[Math.floor(exposures.length * thinFraction)] : -Infinity;

  for (const bud of buds) {
    if (bud.status === 'dead') continue;

    const segment = segments.get(bud.segmentId);
    const resistance = segment?.hydraulicResistance ?? 0;
    const hydraulicFactor = params.hydraulicResistanceHalfVigor / (params.hydraulicResistanceHalfVigor + resistance);
    const exposure = lightProfile.exposureAt(bud.position[1]);
    const demand = Math.max(0, Math.min(1, bud.hormonalVigor * hydraulicFactor));

    bud.auxinLevel = bud.hormonalVigor;
    bud.lightExposure = exposure;
    bud.ageYears += 1;

    // Senescence (self-pruning) is a *local* carbon-balance phenomenon: a
    // branch dies when it can no longer photosynthesize enough to cover
    // its own upkeep, which is a function of local light, not of the
    // whole-tree hydraulic/carbon factors above. This is what makes the
    // crown base rise over time (shaded interior/lower buds die) while,
    // critically, an always-fully-lit leader never dies of resource
    // stress alone -- it just slows down, which is what produces a
    // height *plateau* instead of a hard cutoff.
    if (exposure < params.senescenceLightThreshold || exposure <= percentileCutoff) {
      bud.shadeYears += 1;
      bud.status = bud.shadeYears >= params.senescenceYearsTolerance ? 'dead' : 'dormant';
      bud.vigor = 0;
      continue;
    }
    bud.shadeYears = 0;
    bud.status = 'active';

    const dir = applyDroop(apexDirection(bud.direction, bud.hormonalVigor, params), bud.hormonalVigor, params);
    candidates.push({ bud, demand, dir });
  }

  const totalDemand = candidates.reduce((sum, c) => sum + c.demand, 0);
  const totalRequestedCarbon = totalDemand * potentialElongation * params.carbonCostPerMeterGrowth;
  const globalScale = totalRequestedCarbon > 0 ? Math.min(1, netCarbon / totalRequestedCarbon) : 0;

  const newBuds: Bud[] = [];
  let liveBudCount = buds.filter((b) => b.status !== 'dead').length;

  // Pass 2: commit growth using each bud's carbon-allocated share.
  for (const { bud, demand, dir } of candidates) {
    const vigor = Math.max(0, Math.min(1, demand * globalScale));
    bud.vigor = vigor;

    const length = potentialElongation * vigor;
    if (length < MIN_GROWTH_LENGTH) {
      // Too little carbon/hydraulic headroom to add a whole new growth
      // unit this year -- the bud simply waits at its current tip rather
      // than adding an ever-growing tail of near-zero-length segments.
      // This is what actually stops the segment/record count from
      // growing without bound once a tree nears its old-growth plateau,
      // exactly mirroring how a real hydraulically-saturated tree's
      // annual height increment shrinks toward (but need not reach)
      // zero.
      continue;
    }

    const parentSegment = segments.get(bud.segmentId)!;
    const start = bud.position;
    const rawEnd = add(start, scale(dir, length));
    const end: Vec3 = [rawEnd[0], Math.max(0.02, rawEnd[1]), rawEnd[2]]; // never grow into the ground

    const newSegment: BranchSegment = {
      id: ctx.nextSegmentId++,
      parentId: parentSegment.id,
      childIds: [],
      order: bud.order,
      start,
      end,
      baseRadius: MIN_TWIG_RADIUS,
      tipRadius: MIN_TWIG_RADIUS,
      createdYear: year,
      alive: true,
      leafArea: 0,
      lightExposure: bud.lightExposure,
      hydraulicResistance: 0,
    };
    segments.set(newSegment.id, newSegment);
    parentSegment.childIds.push(newSegment.id);

    const parentHormonalVigor = bud.hormonalVigor;

    // Spawn lateral (axillary) buds along the new internode, golden-angle
    // phyllotaxis, before advancing the apical bud itself. Suppressed
    // once the hard segment-count safety valve trips, so a pathological
    // parameter set degrades to "the leader keeps slowly growing" rather
    // than a sudden, unrealistic freeze of the whole tree.
    for (let i = 0; i < params.nodesPerInternode && !growthCapped; i++) {
      // Self-thinning (crown at carrying capacity) applies uniformly to
      // every axis -- no exemption for any particular branch, order, or
      // age, so the population cap doesn't itself introduce a bias
      // toward one privileged axis over any other.
      if (liveBudCount >= params.maxActiveBuds) break;
      const frac = (i + 1) / (params.nodesPerInternode + 1);
      const nodePos = lerp(start, end, frac);
      const nodeExposure = lightProfile.exposureAt(nodePos[1]);
      // Apical dominance throttles branching rate itself, not just the
      // resulting branch's eventual vigor: a strongly dominant, high
      // hormonal-vigor apex suppresses bud break nearby, while a
      // weakened axis (deep branch order, or resource-starved) breaks
      // bud rarely. Without this, bud counts explode geometrically
      // regardless of the whole-tree carbon budget above.
      const breakChance = params.budBreakProbability * (0.35 + 0.65 * nodeExposure) * vigor;
      if (rng() > breakChance) continue;

      const azimuth = params.phyllotacticAngle * (ctx.nextBudId + i) + (rng() - 0.5) * 0.3;
      const rawLateralDir = lateralDirection(dir, params.branchingAngle, azimuth);

      // Co-dominance: a newly-breaking lateral occasionally inherits a
      // much larger share of its parent's vigor than usual, making it a
      // genuine competing peer instead of a clearly subordinate branch.
      // This single rule is applied identically at every branch point in
      // the tree, at any order or age -- there's no separate "trunk"
      // concept -- so a young tree forking into multiple comparably
      // thick stems (as real broadleaf saplings often do) is one
      // instance of the same scale-invariant branching rule everywhere
      // else in the canopy, not a special case reserved for a
      // privileged central axis. Whether a given co-dominance event ends
      // up visually significant is an emergent function of when/where it
      // happens (early and low means it can still capture a large share
      // of the whole tree's future growth; deep in an already-slender
      // twig it just reads as a slightly thicker twig), not of any
      // hardcoded order check.
      const isCoDominant = rng() < params.coDominanceProbability;
      const lateralHormonalVigor = isCoDominant
        ? parentHormonalVigor * params.coDominantVigorRatio * (0.9 + 0.2 * rng())
        : parentHormonalVigor * params.lateralVigorRatio * (0.85 + 0.3 * rng());
      const lateralOrder = bud.order + 1;
      const lateralDir = applyDroop(rawLateralDir, lateralHormonalVigor, params);

      newBuds.push({
        id: ctx.nextBudId++,
        segmentId: newSegment.id,
        type: 'axillary',
        status: 'active',
        position: nodePos,
        direction: lateralDir,
        order: lateralOrder,
        hormonalVigor: lateralHormonalVigor,
        vigor: 0,
        auxinLevel: parentHormonalVigor,
        lightExposure: nodeExposure,
        ageYears: 0,
        shadeYears: 0,
      });
      liveBudCount++;
    }

    // Advance the apical bud to the tip of the new segment.
    bud.segmentId = newSegment.id;
    bud.position = end;
    bud.direction = dir;
    const retention = Math.max(
      0.85,
      params.apicalVigorRetention - params.lateralAgingPenalty * bud.order - params.trunkAgingPenalty
    );
    bud.hormonalVigor = parentHormonalVigor * retention;
  }

  const allBuds = [...buds, ...newBuds];

  // Foliage: a segment bears leaves for leafLifespanYears after it forms
  // *from elongation*. But a living terminal bud that isn't elongating
  // much (a carbon/hydraulically-stalled spur near the tree's plateau)
  // still pushes out a modest tuft of leaves every season on its
  // existing tip, same as a real spur shoot -- foliage production isn't
  // strictly coupled to stem elongation. Without this, a tree that ever
  // dips below MIN_GROWTH_LENGTH loses all foliage within
  // leafLifespanYears, which zeroes its carbon income forever and it can
  // never recover: an unrealistic, self-inflicted death spiral.
  const liveBudSegmentIds = new Set(allBuds.filter((b) => b.status !== 'dead').map((b) => b.segmentId));
  const SPUR_LEAF_AREA = params.leafAreaPerShootLength * 0.12;
  for (const s of segments.values()) {
    const inLeaf = year - s.createdYear < params.leafLifespanYears;
    const ageBasedArea = inLeaf ? params.leafAreaPerShootLength * Math.max(0.01, distance(s.start, s.end)) : 0;
    const spurArea = s.childIds.length === 0 && liveBudSegmentIds.has(s.id) ? SPUR_LEAF_AREA : 0;
    s.leafArea = Math.max(ageBasedArea, spurArea);
  }

  recomputeAliveFlags(segments);

  applyPipeModelAndMechanics(segments, params);

  // Abscission: drop long-dead, childless twigs so the record doesn't grow
  // without bound. Larger dead limbs (which do have children, or children
  // that are themselves not yet abscised) persist as visible dead wood.
  // A single descending-id pass suffices: children always have a higher
  // id than their parent, so by the time we reach a parent every child
  // that could be abscised this year has already been resolved, and its
  // removal has already updated the parent's childIds.
  // A segment still hosting a non-dead bud (e.g. one that's carbon/
  // hydraulically stalled below MIN_GROWTH_LENGTH but could resume) must
  // never be abscised out from under it.
  const segmentsWithLiveBuds = new Set(allBuds.filter((b) => b.status !== 'dead').map((b) => b.segmentId));
  const deadLongEnough = (s: BranchSegment) =>
    !s.alive &&
    s.childIds.length === 0 &&
    !segmentsWithLiveBuds.has(s.id) &&
    year - s.createdYear > params.leafLifespanYears + params.senescenceYearsTolerance + params.abscissionYears;
  for (const s of [...segments.values()].sort((a, b) => b.id - a.id)) {
    if (!deadLongEnough(s)) continue;
    segments.delete(s.id);
    if (s.parentId !== null) {
      const parent = segments.get(s.parentId);
      if (parent) parent.childIds = parent.childIds.filter((id) => id !== s.id);
    }
  }
  const survivingSegmentIds = new Set(segments.keys());
  const survivingBuds = allBuds.filter((b) => survivingSegmentIds.has(b.segmentId));

  const segmentArray = [...segments.values()];
  const leaves = placeLeaves(segmentArray, year);

  return {
    year,
    segments: segmentArray,
    buds: survivingBuds,
    leaves,
    metrics: computeMetrics(segmentArray),
  };
}
