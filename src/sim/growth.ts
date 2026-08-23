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
import { sunDirection } from './sun';

const MIN_TWIG_RADIUS = 0.0025;
/**
 * Below this *fraction* of the species' own current-year potential
 * elongation (`potentialElongation`, itself driven by `maxInternodeLength`),
 * a bud just waits rather than banking an ever-growing tail of
 * near-zero-length segments -- see its use site below.
 *
 * Scaled to the species' own growth rate rather than a fixed absolute
 * length (an earlier version used a flat 1cm floor): with an absolute
 * floor, a slow-growing species (low maxInternodeLength) hits it at a
 * much higher fraction of its own full vigor -- and so a much lower
 * height on the shared hydraulic-limitation curve -- than a fast-growing
 * species does, since the same 1cm bite is a far bigger chunk of a small
 * annual elongation budget than of a large one. That made the growth-rate
 * slider a hidden height-ceiling slider too: a slow enough species could
 * freeze permanently many meters short of what heightVigorHalfHeight
 * otherwise promises, no matter how long it's given. A fraction of this
 * year's own potential elongation instead makes the height at which a
 * leader's growth stalls governed purely by the hydraulic-limitation
 * curve (the same for every species at a given heightVigorHalfHeight),
 * not by how fast that species elongates when unconstrained -- a slower
 * species just takes longer to get there.
 */
const MIN_GROWTH_LENGTH_FRACTION = 0.016;
/** Ground level. A bud whose natural (undrooped-clamp) trajectory would
 * put its new tip below this dies instead of growing into the soil --
 * see the comment at its use site below. */
const GROUND_HEIGHT = 0.02;
/** Hard safety cap so a pathological parameter set can't blow up memory/CPU
 * in the browser or in a long-running test; real self-shading should keep
 * well under this. */
const MAX_SEGMENTS = 120_000;
/**
 * Per-year death probability for a bud that is `yearsPast` years beyond a
 * senescence/occlusion age-or-shade threshold, used by both the trunk
 * occlusion and light-senescence death checks below.
 *
 * This asymptotically approaches (but, critically, never reaches)
 * `maxHazard` as yearsPast grows, rather than linearly ramping from 0 to a
 * hard 1.0 over a fixed number of years. A linear-to-1.0 ramp still hides
 * a cliff: whichever single year the ramp completes at, every bud that
 * happens to have survived the probabilistic rolls up to that point (and
 * with a large same-age cohort -- e.g. a whole flush of laterals that
 * crossed into shade the same year the canopy closed over them -- there
 * are always some survivors) dies together in that one year, for certain.
 * A constant asymptotic hazard has no such cutoff year: survivors keep
 * thinning out at the same steady per-year rate forever, so a cohort's
 * deaths spread smoothly across many years no matter how large the
 * cohort or how synchronized its members' threshold-crossing was.
 */
function rampedDeathProbability(yearsPast: number, tauYears: number, maxHazard: number): number {
  if (yearsPast <= 0) return 0;
  return maxHazard * (1 - Math.exp(-yearsPast / tauYears));
}

export interface GrowthContext {
  nextSegmentId: number;
  nextBudId: number;
  /**
   * Exponential moving average of effectiveSunlitLeafArea (the carbon
   * budget's supply side), standing in for stored carbohydrate reserves.
   * A whole tree's carbon economy doesn't reset every single year from
   * scratch -- real trees buffer year-to-year swings in photosynthesis
   * with stored starch. Smoothing supply this way is what keeps an
   * ordinary, one-off population correction (self-thinning pruning a
   * batch of buds, say) from reading as a sudden income crash that
   * starves *everyone* a little more, prunes a few more buds, and so on
   * into a runaway carbon-starvation spiral -- the tree can coast through
   * a temporary dip on reserves while its canopy recovers, same as a
   * real one would. Not part of TreeState/serialization: it's an
   * in-memory-only smoothing signal for a continuous run, and every
   * simulation always starts fresh from a bare seedling (see
   * createInitialState) rather than resuming mid-history.
   */
  smoothedCarbonSupply: number;
}

export function createInitialState(): { state: TreeState; ctx: GrowthContext } {
  const rootSegment: BranchSegment = {
    id: 0,
    parentId: null,
    childIds: [],
    order: 0,
    start: [0, 0, 0],
    end: [0, GROUND_HEIGHT, 0],
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
    position: [0, GROUND_HEIGHT, 0],
    direction: [0, 1, 0],
    order: 0,
    hormonalVigor: 1,
    vigor: 1,
    auxinLevel: 1,
    lightExposure: 1,
    ageYears: 0,
    shadeYears: 0,
    stalledYears: 0,
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
  return { state, ctx: { nextSegmentId: 1, nextBudId: 1, smoothedCarbonSupply: 0 } };
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/**
 * Hydraulic-limitation factor from absolute height, in [0, 1], applied
 * both to a bud's own realized vigor and to its foliage's carbon-supply
 * efficiency (see stepYear). A plain saturating hyperbola
 * (`half / (half + height)`) has a very long, slowly-decaying tail --
 * even well past `half`, its residual value is still large enough that,
 * given enough standing carbon surplus, a tree can keep creeping upward
 * for a very long time, making `half` a weak, mushy suggestion rather
 * than a real asymptotic ceiling. Raising the ratio to a power > 1
 * keeps the same halfway point (factor = 0.5 exactly at height = half)
 * but sharpens the falloff into a real knee, so heightVigorHalfHeight
 * reads as an actual, end-to-end-calibratable "this is roughly how tall
 * this species gets" control instead of just a growth-rate nudge.
 */
const HEIGHT_LIMIT_SHARPNESS = 2.5;
function heightVigorFactor(height: number, halfHeight: number, sharpness = HEIGHT_LIMIT_SHARPNESS): number {
  const ratio = Math.max(0, height) / halfHeight;
  return 1 / (1 + Math.pow(ratio, sharpness));
}

/**
 * The carbon-supply-side sibling of heightVigorFactor, deliberately
 * gentler (a plain hyperbola, and a taller effective half-height) rather
 * than sharing its sharpened curve. The two interact through a real
 * feedback loop that a shared, equally-sharp curve makes too strong: as
 * the crown's own base rises (self-pruning, elsewhere in stepYear), the
 * *average* remaining leaf ends up higher even without the tree growing
 * any taller, which would lower supply, which would kill more low-vigor
 * buds, which raises the crown further, and so on -- compounding into
 * exactly the kind of sharp population collapse the self-thinning ramp
 * (selfThinningOnsetFraction/selfThinningMaxFraction) exists to prevent,
 * rather than the gradual old-growth decline a real tree's canopy shows.
 * A softer, later-biting efficiency curve keeps the height penalty doing
 * its calibration job on vigor/growth without also destabilizing the
 * whole-tree carbon budget on its own.
 */
function heightEfficiencyFactor(height: number, halfHeight: number): number {
  return heightVigorFactor(height, halfHeight * 1.8, 1);
}

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
 *
 * Separately, a *shaded* shoot also bends toward the sun
 * (heliotropism/phototropism proper) -- more so under a low, oblique sun
 * where the light gradient across the canopy is pronounced, and not at
 * all under an overhead sun (sin(0) = 0), where there's no consistent
 * horizontal direction to bend toward. This is what makes a canopy lean
 * and thicken toward the light under directional/oblique sun instead of
 * staying radially symmetric.
 */
function apexDirection(
  prevDir: Vec3,
  hormonalVigor: number,
  exposure: number,
  sunDir: Vec3,
  params: SimulationParams,
  rng: () => number
): Vec3 {
  // Heliotropism is a *bias* on top of gravitropism, never a replacement
  // for it: it shifts the target a shoot straightens toward from
  // straight up to "mostly up, tilted somewhat toward the sun", capped
  // well under a full blend. Applying the cap to this fixed target
  // (rather than to each year's incremental lerp) is what keeps the
  // long-run direction bounded to a lean regardless of how many years
  // compound -- lerping toward a moving/uncapped target every year would
  // otherwise drift arbitrarily far off vertical over a long enough run,
  // even with a per-year cap on the lerp amount itself.
  //
  // Even a fully-sunlit shoot still senses *which side* is brighter
  // under a directional sun (real phototropism responds to the light
  // gradient, not just to being in the dark), so the bend never drops
  // all the way to zero at full exposure -- it's just much stronger for
  // a shaded shoot seeking light.
  const shadeFactor = 1 - 0.7 * clamp01(exposure);
  const heliotropicPull = params.heliotropismStrength * Math.sin(params.sunZenithAngle) * shadeFactor;
  const bend = Math.min(0.35, heliotropicPull);
  const target: Vec3 = bend > 0 ? normalize(lerp([0, 1, 0], sunDir, bend)) : [0, 1, 0];

  const pull = params.phototropicPull * clamp01(hormonalVigor);
  let dir = normalize(lerp(prevDir, target, pull));

  // Trunk waviness: a small, zero-mean random perturbation applied
  // *before* the correction above gets a chance to act on it -- see the
  // field doc on trunkWaviness. Reusing lateralDirection's rotate-by-
  // angle-at-a-random-azimuth here is exactly the same "tilt away from
  // the current axis a bit" operation a new lateral's divergence angle
  // uses, just at a much smaller, symmetric, unbiased magnitude instead
  // of a fixed wide spreading angle.
  if (params.trunkWaviness > 0) {
    dir = lateralDirection(dir, rng() * params.trunkWaviness, rng() * Math.PI * 2);
  }
  return dir;
}

function lateralDirection(parentDir: Vec3, branchingAngle: number, azimuth: number): Vec3 {
  const e0 = arbitraryOrthogonal(parentDir);
  const e1 = rotateAroundAxis(e0, parentDir, azimuth);
  const axis = cross(parentDir, e1);
  return normalize(rotateAroundAxis(parentDir, axis, branchingAngle));
}

/** Gravitropic droop, symmetrically: a vigorous axis is stiffer/better
 * supported and droops little; a weak one sags more. Same continuous,
 * order-and-trunk-agnostic rule as apexDirection above.
 *
 * The *equilibrium* sag this converges to is bounded by gravitropicDroop
 * itself, not just how fast each year approaches it: lerping the live
 * direction toward straight down ([0,-1,0]) every single year, with no
 * floor, means *any* persistently low-vigor bud -- not just a heavily
 * weeping species -- eventually converges arbitrarily close to hanging
 * straight down given enough consecutive low-vigor years, however small
 * the species' own droop trait is set to. A real sagging branch settles
 * at a finite angle set by its own species habit and gets progressively
 * stiffer as it thickens; it doesn't keep sagging toward vertical forever
 * just because it stayed subordinate for decades. Clamping the drooped
 * direction's vertical component at -gravitropicDroop keeps the
 * long-run sag angle tied to the species trait (0 = never sags past
 * level; a weeping species' max setting sags well past horizontal) no
 * matter how many years of compounding droop a given bud accumulates. */
function applyDroop(dir: Vec3, hormonalVigor: number, params: SimulationParams): Vec3 {
  const amount = params.gravitropicDroop * clamp01(1 - hormonalVigor);
  const drooped = normalize(lerp(dir, [0, -1, 0], amount));
  const minVertical = -params.gravitropicDroop;
  if (drooped[1] >= minVertical) return drooped;
  const horizLen = Math.hypot(drooped[0], drooped[2]) || 1e-9;
  const horizScale = Math.sqrt(Math.max(0, 1 - minVertical * minVertical)) / horizLen;
  return normalize([drooped[0] * horizScale, minVertical, drooped[2] * horizScale]);
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
 *     height-based hydraulic factor (saturating with the bud's own
 *     absolute height -- the hydraulic-limitation-hypothesis mechanism
 *     for a height plateau, Koch et al. 2004). The year's net carbon is
 *     then divided across all demanding buds in proportion to their weight,
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
  const sunDir = sunDirection(params);
  const ageRamp = Math.min(1, year / params.juvenileRampYears);
  const potentialElongation =
    params.baseInternodeLength + (params.maxInternodeLength - params.baseInternodeLength) * ageRamp;
  const minGrowthLength = potentialElongation * MIN_GROWTH_LENGTH_FRACTION;

  // --- Whole-tree carbon budget (source: sunlit leaf area; sink: upkeep
  // of standing wood). This is what ultimately caps how much total new
  // growth the tree can afford this year, regardless of how many buds
  // would individually like to grow. ---
  // Foliage efficiency also declines continuously with absolute height,
  // same half-height and same physical driver as the vigor factor below
  // (hydraulicFactor): the higher a leaf sits above the ground, the
  // harder it is to keep it supplied with water against gravity and
  // xylem resistance, so its realized gas exchange/photosynthesis is
  // reduced even where light is plentiful (Koch et al. 2004 document
  // exactly this in the very tallest redwood foliage). This is what
  // makes heightVigorHalfHeight a real, end-to-end asymptotic-height
  // control rather than just a growth-rate throttle: a species with a
  // low half-height both grows more slowly up high *and* earns
  // proportionally less carbon from whatever foliage it does have up
  // there, compounding into a firmer height ceiling.
  let effectiveSunlitLeafArea = 0;
  for (const s of prev.segments) {
    if (s.leafArea <= 0) continue;
    const mid: Vec3 = [(s.start[0] + s.end[0]) / 2, (s.start[1] + s.end[1]) / 2, (s.start[2] + s.end[2]) / 2];
    const heightEfficiency = heightEfficiencyFactor(mid[1], params.heightVigorHalfHeight);
    effectiveSunlitLeafArea += s.leafArea * lightProfile.exposureAt(mid) * heightEfficiency;
  }
  // Smoothed rather than this year's raw value (see GrowthContext.
  // smoothedCarbonSupply): a whole tree's carbon economy carries reserves
  // across years instead of resetting from scratch every season.
  const smoothingRate = 0.08;
  ctx.smoothedCarbonSupply += (effectiveSunlitLeafArea - ctx.smoothedCarbonSupply) * smoothingRate;
  const carbonSupply = ctx.smoothedCarbonSupply;
  // Charged against *living* wood only (see TreeMetrics.liveWoodyVolume):
  // dead wood awaiting abscission doesn't respire, so a spike in recent
  // deaths shouldn't itself inflate the tree's own maintenance bill on
  // top of costing it the leaf area.
  const maintenanceCost = params.respirationPerWoodyVolume * prev.metrics.liveWoodyVolume;
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
  const exposures = nonDeadBuds.map((b) => lightProfile.exposureAt(b.position)).sort((a, b) => a - b);
  const capacityFraction = nonDeadBuds.length / params.maxActiveBuds;
  const rampSpan = Math.max(1e-6, 1 - params.selfThinningOnsetFraction);
  const thinFraction =
    params.selfThinningMaxFraction *
    Math.max(0, Math.min(1, (capacityFraction - params.selfThinningOnsetFraction) / rampSpan));
  const percentileCutoff = thinFraction > 0 ? exposures[Math.floor(exposures.length * thinFraction)] : -Infinity;

  // A relative (not absolute) "is this currently one of the tree's
  // dominant axes" signal, used below to exempt the current leader (and
  // any live co-dominant rivals) from ever dying purely from having
  // stalled out -- see its use site for why an absolute hormonalVigor
  // cutoff doesn't work for this. Same style of rank-based criterion as
  // percentileCutoff above rather than a hardcoded order/threshold check:
  // whichever handful of buds currently lead the tree in hormonalVigor
  // are "dominant enough", whatever their raw number happens to have
  // decayed to.
  //
  // A fixed small *count*, not a fraction of the live population: a real
  // tree only ever has a handful of genuinely competing main axes (the
  // leader, plus maybe one or two co-dominant rivals) no matter how many
  // thousands of twigs and spurs it's carrying -- a percentage-of-
  // population exemption scales with tree size and starts covering
  // hundreds of ordinary subordinate branches once the crown is mature,
  // which is indistinguishable from turning off subordinate-branch
  // senescence altogether.
  const DOMINANT_VIGOR_COUNT = 3;
  const hormonalVigors = nonDeadBuds.map((b) => b.hormonalVigor).sort((a, b) => a - b);
  const dominantVigorCutoff = hormonalVigors[Math.max(0, hormonalVigors.length - DOMINANT_VIGOR_COUNT)];

  for (const bud of buds) {
    if (bud.status === 'dead') continue;

    const hydraulicFactor = heightVigorFactor(bud.position[1], params.heightVigorHalfHeight);
    const exposure = lightProfile.exposureAt(bud.position);
    const demand = Math.max(0, Math.min(1, bud.hormonalVigor * hydraulicFactor));

    bud.auxinLevel = bud.hormonalVigor;
    bud.lightExposure = exposure;
    bud.ageYears += 1;

    // Trunk occlusion: independent of light entirely. A branch that's
    // stayed down in the "low zone" near the trunk's base for a long
    // time dies as the thickening trunk progressively overtakes/occludes
    // its base (bark inclusion pinching off its vascular connection) --
    // real and distinct from shading, and it's what keeps a low,
    // reasonably-lit-but-marginal branch near the base from persisting
    // indefinitely purely because the shadow-casting light model never
    // happens to find much directly overhead at its specific spot.
    //
    // Ramped rather than a hard age cutoff: a whole cohort of buds that
    // happened to form in the same narrow window (common right after a
    // burst of early lateral branching) would otherwise all cross the
    // exact same age threshold in the exact same year, dying in lockstep
    // -- precisely the single-year senescence "cliff" this codebase
    // otherwise goes out of its way to avoid (see selfThinningOnsetFraction
    // /selfThinningMaxFraction). rampedDeathProbability's asymptotic hazard
    // (see its own comment) keeps the same eventual outcome (a low branch
    // this old essentially always succumbs, eventually) without a
    // synchronized-cohort spike at any particular year.
    //
    // The height gate is itself a smooth taper rather than a hard "below
    // lowBranchOcclusionHeight or fully exempt" cutoff, for a related
    // reason: a hard cutoff leaves a bud that happens to sit just above
    // it permanently immune to occlusion no matter its age, and a
    // long-lived tree reliably finds one -- a marginal, barely-elongating
    // bud with enough hormonalVigor to dodge the carbon-starvation stall
    // check and just enough light, some years, to dodge shade senescence
    // too, can coast for the tree's entire remaining lifespan sitting a
    // few centimeters above the line. Since it never dies and its own
    // position barely moves, it permanently pins the whole tree's
    // measured crown base at that one height, which is exactly backwards
    // (real old-growth crowns clear the trunk far higher, and by a
    // *growing* margin, the older the tree gets). Tapering occlusion
    // pressure smoothly to zero over a zone twice as tall as the nominal
    // height removes that permanent escape hatch: nothing sits at a fixed
    // height forever with full, permanent immunity.
    const OCCLUSION_HEIGHT_TAPER = 2;
    const occlusionHeightFactor = clamp01(1 - bud.position[1] / (params.lowBranchOcclusionHeight * OCCLUSION_HEIGHT_TAPER));
    if (occlusionHeightFactor > 0) {
      const yearsPastThreshold = bud.ageYears - params.lowBranchOcclusionAge;
      if (rng() < occlusionHeightFactor * rampedDeathProbability(yearsPastThreshold, 1.2, 0.2)) {
        bud.status = 'dead';
        bud.vigor = 0;
        continue;
      }
    }

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
      // Ramped rather than a hard "shadeYears >= tolerance" cutoff, for
      // the same reason as trunk occlusion above: a whole cohort of buds
      // that happened to drop into shade in the same year (very common --
      // the crown closing overhead is itself a single-year event that
      // affects everything under it at once) would otherwise all bank
      // shadeYears in lockstep and then all hit the exact same threshold
      // in the exact same later year, dying together in one synchronized
      // spike -- precisely the senescence "cliff" this codebase otherwise
      // goes out of its way to avoid. rampedDeathProbability's asymptotic
      // hazard keeps the same eventual outcome (a bud this chronically
      // shaded essentially always succumbs, eventually) without every
      // member of a same-age-of-shading cohort falling on the same day,
      // no matter how large that cohort is.
      const yearsPastTolerance = bud.shadeYears - params.senescenceYearsTolerance;
      const dies = rng() < rampedDeathProbability(yearsPastTolerance, 1.2, 0.2);
      bud.status = dies ? 'dead' : 'dormant';
      bud.vigor = 0;
      continue;
    }
    bud.shadeYears = 0;
    bud.status = 'active';

    const dir = applyDroop(apexDirection(bud.direction, bud.hormonalVigor, exposure, sunDir, params, rng), bud.hormonalVigor, params);
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
    if (length < minGrowthLength) {
      // Too little carbon/hydraulic headroom to add a whole new growth
      // unit this year -- the bud simply waits at its current tip rather
      // than adding an ever-growing tail of near-zero-length segments.
      // This is what actually stops the segment/record count from
      // growing without bound once a tree nears its old-growth plateau,
      // exactly mirroring how a real hydraulically-saturated tree's
      // annual height increment shrinks toward (but need not reach)
      // zero.
      bud.stalledYears += 1;
      // Exempted entirely if this bud is currently one of the tree's
      // dominant axes (see dominantVigorCutoff above): a hydraulically-
      // plateaued but still-dominant leader is *supposed* to coast at a
      // near-zero annual increment forever -- that's the whole
      // hydraulic-limitation height-plateau mechanism -- and this must
      // never trip for it. An earlier version gated this on an absolute
      // hormonalVigor threshold instead of a relative rank, which sounds
      // equivalent but isn't: hormonalVigor keeps decaying a little every
      // year a bud actually elongates (apicalVigorRetention < 1), so by
      // the time a long-lived species' leader finally reaches its true
      // height ceiling, *its own* hormonalVigor has typically drifted
      // well below whatever fixed cutoff looked reasonable early in a
      // run -- meaning the exemption quietly stopped covering the one
      // bud it exists for, and the leader eventually senesced anyway,
      // taking the rest of the tree down with it once nothing was left
      // to replenish the bud population. Ranking against whatever's
      // currently alive doesn't have that problem: whichever axis (or
      // axes, under co-dominance) currently leads the tree is always
      // "dominant enough", whatever its raw number has decayed to.
      //
      // A genuinely subordinate bud (not in that top slice) gets a much
      // shorter tolerance instead: real spur shoots have a finite
      // productive lifespan even in good light (temperate fruit-tree
      // physiology puts it at roughly 5-15 years), and without this a
      // stalled, clearly-subordinate bud that happens to sit somewhere
      // the shadow-casting light model never finds anything genuinely
      // overhead (a low, off-center twig under a still-sparse young
      // canopy, say) could otherwise coast at "barely alive, adding
      // nothing" indefinitely.
      if (bud.hormonalVigor < dominantVigorCutoff) {
        // Ramped rather than a hard "stalledYears >= tolerated" cutoff,
        // for the same reason as trunk occlusion and light senescence
        // above: hormonalVigor (and so toleratedStallYears) is a
        // near-deterministic function of a bud's order/position in the
        // branching hierarchy, so a whole same-order cohort of
        // subordinate buds reliably stalls out in the same year and
        // would otherwise all hit the exact same tolerated-years cutoff
        // together, dying in lockstep.
        const toleratedStallYears = params.spurSenescenceYears / Math.max(0.02, 1 - bud.hormonalVigor);
        const yearsPastTolerance = bud.stalledYears - toleratedStallYears;
        if (rng() < rampedDeathProbability(yearsPastTolerance, 1, 0.4)) {
          bud.status = 'dead';
        }
      }
      continue;
    }
    bud.stalledYears = 0;

    const parentSegment = segments.get(bud.segmentId)!;
    const start = bud.position;
    const rawEnd = add(start, scale(dir, length));

    if (rawEnd[1] < GROUND_HEIGHT) {
      // A branch this low-vigor and steeply drooped that its natural
      // trajectory would put it into the soil isn't a real growth habit --
      // it's dead wood (buried, abraded, pathogen-prone) well before this
      // point. Kill it here instead of clamping the endpoint to the
      // ground and letting it "crawl" sideways along the surface forever:
      // without this, a persistently low-hormonal-vigor lateral can keep
      // drooping (applyDroop) until its direction is nearly straight down
      // while still carrying just enough vigor to add a sliver of growth
      // every year, and -- since a point sitting right at ground level
      // rarely has anything genuinely overhead to shade it under the
      // shadow-casting light model -- it would otherwise never senesce on
      // its own.
      bud.status = 'dead';
      bud.vigor = 0;
      continue;
    }
    const end: Vec3 = rawEnd;

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
      const nodeExposure = lightProfile.exposureAt(nodePos);
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
        stalledYears: 0,
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
  // dips below the growth-stall floor loses all foliage within
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
  // hydraulically stalled below the growth-stall floor but could resume) must
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
