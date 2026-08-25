import type {
  BranchSegment,
  DeadTree,
  ForestHistory,
  ForestParams,
  ForestSnapshot,
  ForestTree,
  SimulationParams,
  TreeState,
  Vec3,
} from '../model/types';
import { makeRng } from '../model/rng';
import { createInitialState, rampedDeathProbability, stepYear, type GrowthContext } from './growth';
import { buildForestLightProfile, type LightProfile } from './light';
import { buildRootResourceProfile } from './rootCompetition';

/**
 * Runs a forest simulation one forest-year at a time, from a single
 * founder tree, for as many years as the caller wants -- the core engine
 * behind both the synchronous runForestSimulation (a full run in one
 * call, mainly for tests) and the streaming Web Worker path (forestWorker
 * .ts), which calls stepOne() once per year and posts a progress message
 * after each so a long generation can report live progress instead of
 * blocking. Deterministic for a given (params, forestParams, forestSeed)
 * triple regardless of which caller drives it.
 *
 * Every tree in the forest is grown by exactly the ordinary single-tree
 * engine (createInitialState/stepYear from growth.ts) -- reproduction
 * makes more individuals of the same species (sharing `params`), each with
 * its own (x, z) planting position and its own independent RNG stream
 * (minted from the forest's own RNG at germination, the same way a lone
 * tree's own run is deterministic from params.seed). What actually makes
 * this a *forest* rather than a pile of independent single-tree runs is
 * that every year, before any tree grows, two forest-wide profiles are
 * built from every currently-living tree's own (translated to world
 * coordinates by its own planting position) segments -- a shared light
 * profile (buildForestLightProfile, the direct multi-tree extension of
 * the single-tree shadow map) and a shared root-space-crowding profile
 * (buildRootResourceProfile) -- and handed to every tree's own stepYear
 * call via its `external` argument, so a tree standing in a taller
 * neighbor's shadow, or with its roots contesting a neighbor's, actually
 * grows differently than it would alone.
 *
 * Each forest-year's snapshot (see ForestSnapshot's own doc) keeps only
 * each currently-alive tree's *current* TreeState, not its own full
 * per-year sub-history -- a scrub only ever needs "what did the forest
 * look like in year Y", and keeping every tree's full lifetime history
 * nested inside every year's snapshot would be a needless
 * O(years x treeCount x treeAge) memory blowup.
 *
 * Equilibrium freezing (see ForestTree.frozen's own doc and
 * EQUILIBRIUM_YEARS below): once a tree's own metrics have stopped
 * meaningfully changing for long enough, its full stepYear/growRoots
 * computation is skipped in every subsequent year -- for a large,
 * long-lived forest, most trees spend most of their lives past this
 * point (a real tree's hydraulic-limitation plateau is exactly the same
 * asymptote a lone tree's own height curve already shows), so this is
 * the single biggest lever for making a larger/longer forest actually
 * tractable. A frozen tree still fully participates in the forest-wide
 * light/root profiles every year (its canopy/roots don't disappear, they
 * just stop changing) and its own starvation risk is still re-evaluated
 * every year against those profiles, so a frozen tree that a newly-grown
 * neighbor eventually shades out still resumes real computation (and can
 * still decline and die) the moment that actually starts happening.
 */
export class ForestRunner {
  private forestRng: () => number;
  private runtimes = new Map<number, { ctx: GrowthContext; rng: () => number }>();
  private nextTreeId = 0;
  private deadTreesAcc: DeadTree[] = [];

  trees: ForestTree[];
  forestYear = 0;

  constructor(
    private params: SimulationParams,
    private forestParams: ForestParams,
    forestSeed: number
  ) {
    this.forestRng = makeRng(forestSeed);
    const founderSeed = mintSeed(this.forestRng);
    const founder = createInitialState(params);
    this.runtimes.set(this.nextTreeId, { ctx: founder.ctx, rng: makeRng(founderSeed) });
    this.trees = [
      {
        id: this.nextTreeId,
        position: [0, 0],
        seed: founderSeed,
        plantedYear: 0,
        starvedYears: 0,
        plateauYears: 0,
        frozen: false,
        lastMeanExposure: 1,
        state: founder.state,
      },
    ];
    this.nextTreeId += 1;
  }

  /** The current forest-year's snapshot -- a fresh deadTrees copy (cheap:
   * bounded by how many trees have ever died) but the *same* `trees`
   * array reference/elements a caller already has, since nothing here
   * ever mutates a ForestTree or its state in place. */
  snapshot(): ForestSnapshot {
    return { forestYear: this.forestYear, trees: this.trees, deadTrees: [...this.deadTreesAcc] };
  }

  /** Advances the forest by exactly one year and returns the resulting
   * snapshot (also available afterward via snapshot()). */
  stepOne(): ForestSnapshot {
    const { params, forestParams } = this;
    this.forestYear += 1;
    const year = this.forestYear;

    // Forest-wide competition profiles, built once per year from *last*
    // year's living trees (frozen or not -- a frozen tree's canopy/roots
    // are exactly as real a light/root obstruction as an actively-growing
    // one's) -- the same "this year's growth responds to the light
    // environment last season ended in" lag a single tree's own stepYear
    // already uses, just now shared across every tree at once.
    const lightSources = this.trees.map((t) => ({ segments: t.state.segments, offset: t.position }));
    const lightProfile = buildForestLightProfile(lightSources, params);
    const rootSources = this.trees.map((t) => ({ id: t.id, segments: t.state.segments, offset: t.position }));
    const rootProfile = buildRootResourceProfile(rootSources);

    // Grow every currently-alive tree by one year against the shared
    // profiles -- unless it's already frozen (see ForestTree.frozen and
    // this class's own module doc), in which case its state is simply
    // carried forward unchanged and no rng draws are consumed for it this
    // year (equivalent to "this tree had nothing left to decide").
    const grown: ForestTree[] = this.trees.map((t) => {
      if (t.frozen) return t;
      const runtime = this.runtimes.get(t.id)!;
      const state = stepYear(t.state, params, runtime.rng, runtime.ctx, {
        worldOffset: t.position,
        lightProfile,
        treeId: t.id,
        rootResourceProfile: rootProfile,
      });
      const plateauYears = isStableYear(t.state, state) ? t.plateauYears + 1 : 0;
      const frozen = plateauYears >= EQUILIBRIUM_YEARS;
      return { ...t, state, plateauYears, frozen };
    });

    // Whole-tree light-starvation mortality: a tree whose entire canopy
    // has stayed chronically shaded (not just its lowest branches, which
    // already self-prune inside stepYear -- this is the whole-tree
    // analogue) for long enough starts facing a real, ramped chance of
    // dying outright and being removed, the same asymptotic-hazard shape
    // (never a hard single-year cutoff) used throughout growth.ts. This
    // check runs against every tree, frozen or not, which is also what
    // lets a frozen tree ever unfreeze again (see below).
    const survivors: ForestTree[] = [];
    for (const t of grown) {
      const rawExposure = meanCanopyExposure(t.state.segments, t.position, lightProfile);
      // A tree carrying literally no live foliage right now is in the
      // worst possible carbon state there is (starved), *unless* it's
      // simply too young to have grown any yet -- a fresh germinant's
      // first year shouldn't read as instantly starved just because it
      // hasn't leafed out yet.
      const meanExposure = rawExposure ?? (t.state.year <= 1 ? 1 : 0);
      const starved = meanExposure <= forestParams.lightStarvationThreshold;
      const starvedYears = starved ? t.starvedYears + 1 : 0;
      const yearsPastTolerance = starvedYears - forestParams.lightStarvationYears;
      const dies = yearsPastTolerance > 0 && this.forestRng() < rampedDeathProbability(yearsPastTolerance, 2, 0.35);
      if (dies) {
        this.deadTreesAcc.push({
          id: t.id,
          position: t.position,
          plantedYear: t.plantedYear,
          diedYear: year,
          cause: 'light starvation',
          finalHeight: t.state.metrics.height,
          finalDbh: t.state.metrics.dbh,
        });
        this.runtimes.delete(t.id);
        continue;
      }
      // A frozen tree unfreezes (resumes full growth simulation) in
      // either direction its light environment can move:
      //  - it starts genuinely struggling (starved) -- its actual decline
      //    (shedding, reduced vigor, eventual death) needs to be modeled
      //    for real, not left invisibly frozen under just a coarse
      //    death-hazard dice roll;
      //  - or it brightens substantially (a shading neighbor died and
      //    opened up the canopy) -- real gap-phase release, where a
      //    long-suppressed tree resumes vigorous growth once light
      //    becomes available, is exactly the kind of change freezing
      //    must not silently miss.
      // Root-space competition easing isn't tracked the same way (light
      // is by far the more common and more visible driver of this kind of
      // release) -- a known, accepted asymmetry.
      const brightened = meanExposure > t.lastMeanExposure + 0.1 && meanExposure > t.lastMeanExposure * 1.2;
      const wasFrozen = t.frozen;
      const frozen = wasFrozen && !starved && !brightened;
      // plateauYears is only ever reset here on an actual unfreeze event
      // -- otherwise it must pass through untouched, whether it's still
      // silently accumulating toward EQUILIBRIUM_YEARS (t.frozen false)
      // or already parked at/above it (t.frozen true); resetting it
      // whenever `frozen` merely happens to read false for a
      // *still-accumulating, not-yet-frozen* tree would wipe out its
      // count every single year and it would never reach the threshold.
      const plateauYears = wasFrozen && !frozen ? 0 : t.plateauYears;
      survivors.push({ ...t, starvedYears, frozen, plateauYears, lastMeanExposure: meanExposure });
    }

    // Reproduction: each mature survivor may scatter a few seeds this
    // year; a seed only actually germinates into a new tree if it lands
    // with real room (minTreeSpacing) and enough ground-level light
    // (germinationLightThreshold) -- real seedlings establish poorly
    // directly under a closed canopy -- and only while under the
    // forest's own tree-count ceiling (maxTrees). A frozen (structurally
    // plateaued) tree still reproduces normally -- real mature trees keep
    // producing seed crops indefinitely long after their own growth has
    // leveled off.
    const newTrees: ForestTree[] = [];
    const occupied = (): readonly ForestTree[] => [...survivors, ...newTrees];
    for (const parent of survivors) {
      if (occupied().length >= forestParams.maxTrees) break;
      if (parent.state.year < forestParams.maturityAge) continue;
      if (this.forestRng() >= forestParams.reproductionProbability) continue;
      for (let i = 0; i < forestParams.seedsPerEvent; i++) {
        if (occupied().length >= forestParams.maxTrees) break;
        const angle = this.forestRng() * Math.PI * 2;
        const dist = this.forestRng() * forestParams.seedDispersalRadius;
        const x = parent.position[0] + Math.cos(angle) * dist;
        const z = parent.position[1] + Math.sin(angle) * dist;
        const tooClose = occupied().some((o) => Math.hypot(o.position[0] - x, o.position[1] - z) < forestParams.minTreeSpacing);
        if (tooClose) continue;
        const groundExposure = lightProfile.exposureAt([x, 0, z]);
        if (groundExposure < forestParams.germinationLightThreshold) continue;

        const seed = mintSeed(this.forestRng);
        const { state, ctx } = createInitialState(params);
        const id = this.nextTreeId++;
        this.runtimes.set(id, { ctx, rng: makeRng(seed) });
        newTrees.push({ id, position: [x, z], seed, plantedYear: year, starvedYears: 0, plateauYears: 0, frozen: false, lastMeanExposure: 1, state });
      }
    }

    this.trees = [...survivors, ...newTrees];
    return this.snapshot();
  }
}

/**
 * Runs a full forest simulation from a single founder tree, all
 * `forestParams.years` years in one synchronous call -- a thin wrapper
 * over ForestRunner for callers that just want the whole finished
 * ForestHistory at once (tests, primarily; the interactive UI instead
 * drives a ForestRunner incrementally from inside forestWorker.ts so it
 * can stream per-year progress without blocking).
 */
export function runForestSimulation(params: SimulationParams, forestParams: ForestParams, forestSeed: number): ForestHistory {
  const runner = new ForestRunner(params, forestParams, forestSeed);
  const states: ForestSnapshot[] = [runner.snapshot()];
  for (let y = 0; y < forestParams.years; y++) states.push(runner.stepOne());
  return { formatVersion: 1, params, forestParams, forestSeed, states };
}

/** Consecutive stable years (see isStableYear) required before a tree
 * freezes -- see ForestTree.frozen's own doc. Multiple years rather than
 * one is deliberate: a single quiet year is fairly common even for a
 * still-actively-growing tree (a stochastic lull in bud-break rolls, a
 * temporary carbon dip smoothed by GrowthContext.smoothedCarbonSupply),
 * and freezing on the strength of just one such year risks permanently
 * parking a tree that would have resumed visible growth the very next
 * season. Sustained stability across this many consecutive years is a
 * much stronger signal of a genuine hydraulic-limitation plateau. */
const EQUILIBRIUM_YEARS = 6;

/**
 * Whether a tree's structure changed by a negligible amount this year.
 * Gated primarily on segment/bud *count* (an exact integer comparison,
 * not a tolerance) plus height/DBH -- deliberately *not* leaf area or
 * root woody volume, both of which keep oscillating by real but
 * cosmetically tiny amounts (a single already-stalled spur bud gaining or
 * losing its small leaf tuft from one year to the next) essentially
 * forever in this model, even once a tree's actual size has fully
 * plateaued; gating on those too would mean a tree effectively never
 * freezes. Segment/bud count and height/DBH, by contrast, do show real,
 * sustained multi-year stretches of exact stability once a tree reaches
 * its hydraulic-limitation ceiling (confirmed empirically against a long
 * single-tree run) -- and since segment count is also what most of a
 * mature tree's own per-year cost actually scales with (the pipe model
 * and hydraulic-resistance recompute walk every segment), it's the right
 * proxy for "there's nothing expensive left to recompute here" as well as
 * for "this looks visually finished".
 */
function isStableYear(prev: TreeState, next: TreeState): boolean {
  if (prev.segments.length !== next.segments.length) return false;
  if (prev.buds.length !== next.buds.length) return false;
  const closeEnough = (a: number, b: number, atol: number, rtol: number): boolean => Math.abs(a - b) <= atol + rtol * Math.abs(b);
  return (
    closeEnough(prev.metrics.height, next.metrics.height, 0.005, 0.001) && closeEnough(prev.metrics.dbh, next.metrics.dbh, 0.0005, 0.001)
  );
}

function mintSeed(rng: () => number): number {
  return Math.floor(rng() * 0x7fffffff);
}

/** Leaf-area-weighted mean canopy light exposure, the whole-tree analogue
 * of the per-bud exposure stepYear itself uses for local senescence --
 * see the module doc for why this lives here rather than inside stepYear
 * (it needs to run *after* growth, against every tree at once, to decide
 * whole-tree removal, not per-bud pruning). Returns null (rather than a
 * number) when the tree currently carries no live foliage at all to
 * average over -- see the caller for how that's resolved (a young
 * germinant's grace period vs. an older, moribund tree). */
function meanCanopyExposure(segments: readonly BranchSegment[], offset: readonly [number, number], lightProfile: LightProfile): number | null {
  let weighted = 0;
  let totalArea = 0;
  for (const s of segments) {
    if (s.kind !== 'shoot' || s.leafArea <= 0) continue;
    const mid: Vec3 = [(s.start[0] + s.end[0]) / 2 + offset[0], (s.start[1] + s.end[1]) / 2, (s.start[2] + s.end[2]) / 2 + offset[1]];
    weighted += lightProfile.exposureAt(mid) * s.leafArea;
    totalArea += s.leafArea;
  }
  return totalArea > 0 ? weighted / totalArea : null;
}
