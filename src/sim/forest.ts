import type {
  BranchSegment,
  DeadTree,
  ForestHistory,
  ForestParams,
  ForestSnapshot,
  ForestTree,
  SimulationParams,
  Vec3,
} from '../model/types';
import { makeRng } from '../model/rng';
import { createInitialState, rampedDeathProbability, stepYear, type GrowthContext } from './growth';
import { buildForestLightProfile, type LightProfile } from './light';
import { buildRootResourceProfile } from './rootCompetition';

/**
 * Runs a full forest simulation from a single founder tree, one forest-year
 * at a time, for `forestParams.years` years. Deterministic for a given
 * (params, forestParams, forestSeed) triple.
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
 */
export function runForestSimulation(params: SimulationParams, forestParams: ForestParams, forestSeed: number): ForestHistory {
  const forestRng = makeRng(forestSeed);
  const runtimes = new Map<number, { ctx: GrowthContext; rng: () => number }>();

  let nextTreeId = 0;
  const founderSeed = mintSeed(forestRng);
  const founder = createInitialState(params);
  runtimes.set(nextTreeId, { ctx: founder.ctx, rng: makeRng(founderSeed) });

  let trees: ForestTree[] = [
    { id: nextTreeId, position: [0, 0], seed: founderSeed, plantedYear: 0, starvedYears: 0, state: founder.state },
  ];
  nextTreeId += 1;

  const deadTrees: DeadTree[] = [];
  const states: ForestSnapshot[] = [{ forestYear: 0, trees, deadTrees: [] }];

  for (let year = 1; year <= forestParams.years; year++) {
    // Forest-wide competition profiles, built once per year from *last*
    // year's living trees -- the same "this year's growth responds to the
    // light environment last season ended in" lag a single tree's own
    // stepYear already uses, just now shared across every tree at once.
    const lightSources = trees.map((t) => ({ segments: t.state.segments, offset: t.position }));
    const lightProfile = buildForestLightProfile(lightSources, params);
    const rootSources = trees.map((t) => ({ id: t.id, segments: t.state.segments, offset: t.position }));
    const rootProfile = buildRootResourceProfile(rootSources);

    // Grow every currently-alive tree by one year against the shared profiles.
    const grown: ForestTree[] = trees.map((t) => {
      const runtime = runtimes.get(t.id)!;
      const state = stepYear(t.state, params, runtime.rng, runtime.ctx, {
        worldOffset: t.position,
        lightProfile,
        treeId: t.id,
        rootResourceProfile: rootProfile,
      });
      return { ...t, state };
    });

    // Whole-tree light-starvation mortality: a tree whose entire canopy
    // has stayed chronically shaded (not just its lowest branches, which
    // already self-prune inside stepYear -- this is the whole-tree
    // analogue) for long enough starts facing a real, ramped chance of
    // dying outright and being removed, the same asymptotic-hazard shape
    // (never a hard single-year cutoff) used throughout growth.ts.
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
      const dies = yearsPastTolerance > 0 && forestRng() < rampedDeathProbability(yearsPastTolerance, 2, 0.35);
      if (dies) {
        deadTrees.push({
          id: t.id,
          position: t.position,
          plantedYear: t.plantedYear,
          diedYear: year,
          cause: 'light starvation',
          finalHeight: t.state.metrics.height,
          finalDbh: t.state.metrics.dbh,
        });
        runtimes.delete(t.id);
        continue;
      }
      survivors.push({ ...t, starvedYears });
    }

    // Reproduction: each mature survivor may scatter a few seeds this
    // year; a seed only actually germinates into a new tree if it lands
    // with real room (minTreeSpacing) and enough ground-level light
    // (germinationLightThreshold) -- real seedlings establish poorly
    // directly under a closed canopy -- and only while under the
    // forest's own tree-count ceiling (maxTrees).
    const newTrees: ForestTree[] = [];
    const occupied = (): readonly ForestTree[] => [...survivors, ...newTrees];
    for (const parent of survivors) {
      if (occupied().length >= forestParams.maxTrees) break;
      if (parent.state.metrics.height < forestParams.maturityHeight) continue;
      if (forestRng() >= forestParams.reproductionProbability) continue;
      for (let i = 0; i < forestParams.seedsPerEvent; i++) {
        if (occupied().length >= forestParams.maxTrees) break;
        const angle = forestRng() * Math.PI * 2;
        const dist = forestRng() * forestParams.seedDispersalRadius;
        const x = parent.position[0] + Math.cos(angle) * dist;
        const z = parent.position[1] + Math.sin(angle) * dist;
        const tooClose = occupied().some((o) => Math.hypot(o.position[0] - x, o.position[1] - z) < forestParams.minTreeSpacing);
        if (tooClose) continue;
        const groundExposure = lightProfile.exposureAt([x, 0, z]);
        if (groundExposure < forestParams.germinationLightThreshold) continue;

        const seed = mintSeed(forestRng);
        const { state, ctx } = createInitialState(params);
        const id = nextTreeId++;
        runtimes.set(id, { ctx, rng: makeRng(seed) });
        newTrees.push({ id, position: [x, z], seed, plantedYear: year, starvedYears: 0, state });
      }
    }

    trees = [...survivors, ...newTrees];
    states.push({ forestYear: year, trees, deadTrees: [...deadTrees] });
  }

  return { formatVersion: 1, params, forestParams, forestSeed, states };
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
