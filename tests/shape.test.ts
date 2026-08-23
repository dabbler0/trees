/**
 * Tests for overall tree *architecture* (deciduous-like vs. conifer-like)
 * and for the smoothness of the self-pruning process over time. These
 * complement tests/allometry.test.ts, which covers size/proportion; this
 * file covers *shape*.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultParams } from '../src/sim/params';
import { runSimulation } from '../src/sim/simulate';
import type { SimulationHistory, TreeState } from '../src/model/types';
import { mean, segmentMidHeight } from './testUtils';

const EARLY_FORK_CUTOFF_YEAR = 20;
const MATURE_AGE = 90;
const SEED_COUNT = 14;

/** One run per seed, reused by every test below. */
let historiesBySeed: SimulationHistory[];

beforeAll(() => {
  historiesBySeed = Array.from({ length: SEED_COUNT }, (_, i) => runSimulation({ ...defaultParams, seed: i + 1 }, MATURE_AGE));
}, 60_000);

/** Radial distance from the vertical (Y) axis of a segment's midpoint. */
function radialDistance(s: { start: readonly [number, number, number]; end: readonly [number, number, number] }): number {
  const mx = (s.start[0] + s.end[0]) / 2;
  const mz = (s.start[2] + s.end[2]) / 2;
  return Math.hypot(mx, mz);
}

/**
 * Finds every branch point formed early in the tree's life (a segment
 * created at or before `earlyYearCutoff` with 2+ children) and, for each,
 * measures how comparably thick its children's lineages ultimately grew
 * by `state`'s snapshot -- "how thick did this branch become" is the max
 * radius anywhere in its own subtree, so a fork still counts even if the
 * fork point itself has since been superseded by thicker growth further
 * out. This is deliberately order-agnostic: forking is now a single rule
 * applied identically at every branch point, at any order, so detecting
 * it has to look at *what actually grew thick*, not at a privileged
 * "order 0" label.
 *
 * Returns the ratio (second-thickest / thickest lineage) of the most
 * balanced qualifying fork, or null if the tree has no early fork at all.
 */
function bestEarlyForkBalance(state: TreeState, earlyYearCutoff: number): { ratio: number; secondThickest: number } | null {
  const ordered = [...state.segments].sort((a, b) => b.id - a.id); // children before parents
  const subtreeMaxRadius = new Map<number, number>();
  for (const s of ordered) {
    let maxRadius = s.baseRadius;
    for (const cid of s.childIds) maxRadius = Math.max(maxRadius, subtreeMaxRadius.get(cid) ?? 0);
    subtreeMaxRadius.set(s.id, maxRadius);
  }

  let best: { ratio: number; secondThickest: number } | null = null;
  for (const s of state.segments) {
    if (s.createdYear > earlyYearCutoff || s.childIds.length < 2) continue;
    const radii = s.childIds.map((cid) => subtreeMaxRadius.get(cid) ?? 0).sort((a, b) => b - a);
    const ratio = radii[1] / radii[0];
    if (best === null || ratio > best.ratio) best = { ratio, secondThickest: radii[1] };
  }
  return best;
}

describe('deciduous-like architecture: possible multi-trunk forking when young', () => {
  it('at least some seeds develop more than one co-dominant trunk by the juvenile stage, and at least some do not', () => {
    const balances = historiesBySeed.map((h) => bestEarlyForkBalance(h.states[MATURE_AGE], EARLY_FORK_CUTOFF_YEAR));
    expect(balances.some((b) => b !== null && b.ratio > 0.5)).toBe(true);
    expect(balances.some((b) => b === null || b.ratio <= 0.5)).toBe(true);
  });

  it('a forked co-dominant trunk is genuinely thick, not a thin twig', () => {
    const forked = historiesBySeed
      .map((h) => bestEarlyForkBalance(h.states[MATURE_AGE], EARLY_FORK_CUTOFF_YEAR))
      .filter((b): b is { ratio: number; secondThickest: number } => b !== null && b.ratio > 0.5);
    expect(forked.length).toBeGreaterThan(0); // sanity: at least one forked example existed to check
    // At least one qualifying fork should be a real limb, not a twig --
    // some early "forks" are deep, thin twigs that happen to have a
    // balanced ratio, which is fine (self-similarity at small scale),
    // but the phenomenon needs to also show up at meaningful scale.
    expect(Math.max(...forked.map((b) => b.secondThickest))).toBeGreaterThan(0.012);
  });
});

describe('deciduous-like architecture: a rounded crown top rather than a conifer-like cone', () => {
  it('crown width holds up well into the upper crown instead of tapering linearly to a point', () => {
    // Average across seeds so one unusually narrow/wide individual
    // doesn't make the test flaky.
    const ratios: number[] = [];
    for (const history of historiesBySeed) {
      const state = history.states[MATURE_AGE];
      const crownBase = state.metrics.crownBaseHeight;
      const top = state.metrics.height;
      const span = top - crownBase;
      if (span < 2) continue; // too young/short a crown to measure meaningfully

      const widthAtFraction = (frac: number, halfWindow = 0.1): number => {
        const targetHeight = crownBase + span * frac;
        const inWindow = state.segments.filter((s) => {
          const h = segmentMidHeight(s);
          return Math.abs(h - targetHeight) <= span * halfWindow;
        });
        if (inWindow.length === 0) return 0;
        return Math.max(...inWindow.map(radialDistance));
      };

      // Deliberately stop short of the very tip (0.75 rather than closer
      // to 1.0): the outermost sliver of *any* still-growing tree is its
      // freshest, thinnest growth -- that's realistic and not what
      // distinguishes a rounded crown from a conifer's cone. What does
      // is whether the *bulk* of the upper crown, one layer in from that
      // growing edge, has filled out sideways or is still tapering
      // linearly toward a point.
      const midWidth = widthAtFraction(0.5);
      const upperWidth = widthAtFraction(0.75);
      if (midWidth <= 0) continue;
      ratios.push(upperWidth / midWidth);
    }
    expect(ratios.length).toBeGreaterThan(0);
    // A cone tapering linearly from mid-crown to a point at the top would
    // give a ratio around (1 - 0.75) / (1 - 0.5) = 0.5; a rounded/dome
    // top should hold up noticeably better than that. The bar sits just
    // above that cone baseline (0.55, not 0.6) since the height-based
    // hydraulic-limitation factor (heightVigorHalfHeight in growth.ts,
    // applied to both vigor and foliage efficiency) legitimately makes
    // upper-crown growth a bit weaker relative to mid-crown than before
    // that mechanism existed -- real hydraulically-limited trees do show
    // some upper-crown thinning -- without giving up the actual point of
    // this test, which is ruling out a conifer-like linear taper to a
    // point.
    expect(mean(ratios)).toBeGreaterThan(0.55);
  });
});

describe('the live canopy rises roughly continuously, not in a single senescence "cliff"', () => {
  it('crown base height never jumps by more than a small fraction of total tree height in a single year', () => {
    for (const history of historiesBySeed) {
      let maxJump = 0;
      let finalHeight = 0;
      for (let y = 1; y < history.states.length; y++) {
        const prev = history.states[y - 1].metrics;
        const cur = history.states[y].metrics;
        maxJump = Math.max(maxJump, cur.crownBaseHeight - prev.crownBaseHeight);
        finalHeight = Math.max(finalHeight, cur.height);
      }
      // A "cliff" would move several meters in one year; continuous
      // self-pruning should never move more than a small slice of the
      // tree's eventual total height in a single growing season.
      expect(maxJump).toBeLessThan(Math.max(1.5, finalHeight * 0.12));
    }
  });

  it('the mean height of live foliage moves smoothly too (not just the strict minimum)', () => {
    // crownBaseHeight is a strict min and can jump the instant the single
    // lowest surviving twig dies; a mean-height-of-foliage measure is a
    // more robust continuity check on the whole senescence process.
    const meanFoliageHeight = (state: TreeState): number | null => {
      let totalArea = 0;
      let weighted = 0;
      for (const s of state.segments) {
        if (s.leafArea <= 0) continue;
        weighted += segmentMidHeight(s) * s.leafArea;
        totalArea += s.leafArea;
      }
      return totalArea > 0 ? weighted / totalArea : null;
    };

    for (const history of historiesBySeed) {
      let maxJump = 0;
      let prev: number | null = null;
      let finalHeight = 0;
      for (const state of history.states) {
        finalHeight = Math.max(finalHeight, state.metrics.height);
        const h = meanFoliageHeight(state);
        if (h !== null && prev !== null) maxJump = Math.max(maxJump, Math.abs(h - prev));
        if (h !== null) prev = h;
      }
      expect(maxJump).toBeLessThan(Math.max(1.5, finalHeight * 0.1));
    }
  });
});

describe('trunk waviness: a leaning/zigzagging main stem, not a ruler-straight one', () => {
  // order===0 segments trace the single, never-relabeled lineage that
  // started as the seedling's original leader (a co-dominant fork always
  // gets order+1 -- see growth.ts -- so this is unaffected by whichever
  // axis later turns out thickest). apexDirection's trunkWaviness wobble
  // applies to every continuing axis identically, so checking this one
  // lineage in isolation is enough to know whether the mechanism does
  // anything at all, without getting entangled in the co-dominance system
  // (a separate mechanism covered by the multi-trunk-forking tests above).
  it('at trunkWaviness=0, the leader path stays exactly vertical (sanity check)', () => {
    const straight = runSimulation({ ...defaultParams, trunkWaviness: 0, seed: 1 }, MATURE_AGE);
    const leaderSegments = straight.states[MATURE_AGE].segments.filter((s) => s.order === 0);
    expect(leaderSegments.length).toBeGreaterThan(0);
    const maxDeviation = Math.max(...leaderSegments.map(radialDistance));
    expect(maxDeviation).toBeLessThan(1e-6);
  });

  it("the default (nonzero) trunk waviness makes the leader path visibly wander, like a real broadleaf's leaning trunk rather than a conifer's straight one", () => {
    const deviations = historiesBySeed.map((history) => {
      const leaderSegments = history.states[MATURE_AGE].segments.filter((s) => s.order === 0);
      return Math.max(...leaderSegments.map(radialDistance));
    });
    // Averaged across seeds so one unusually straight-by-luck random walk
    // doesn't make the test flaky. A real leaning/zigzagging deciduous
    // trunk wanders sideways by a good fraction of a meter over a
    // multi-decade run; a conifer-like one would stay near zero.
    expect(mean(deviations)).toBeGreaterThan(0.3);
  });
});
