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

const YOUNG_AGE = 30;
const MATURE_AGE = 90;
const SEED_COUNT = 14;

/** One run per seed, reused by every test below. */
let historiesBySeed: SimulationHistory[];

beforeAll(() => {
  historiesBySeed = Array.from({ length: SEED_COUNT }, (_, i) => runSimulation({ ...defaultParams, seed: i + 1 }, MATURE_AGE));
}, 60_000);

function countLiveTrunkStems(state: TreeState): number {
  return state.buds.filter((b) => b.order === 0 && b.status !== 'dead').length;
}

/** Radial distance from the vertical (Y) axis of a segment's midpoint. */
function radialDistance(s: { start: readonly [number, number, number]; end: readonly [number, number, number] }): number {
  const mx = (s.start[0] + s.end[0]) / 2;
  const mz = (s.start[2] + s.end[2]) / 2;
  return Math.hypot(mx, mz);
}

describe('deciduous-like architecture: possible multi-trunk forking when young', () => {
  it('at least some seeds develop more than one co-dominant trunk by the juvenile stage, and at least some do not', () => {
    const trunkCounts = historiesBySeed.map((h) => countLiveTrunkStems(h.states[YOUNG_AGE]));
    expect(trunkCounts.some((c) => c > 1)).toBe(true);
    expect(trunkCounts.some((c) => c === 1)).toBe(true);
  });

  it('a forked co-dominant trunk is genuinely thick, not a thin twig', () => {
    // Find a seed that forked, and check the secondary trunk's radius
    // near its base is a substantial fraction of the primary trunk's.
    let checked = false;
    for (const history of historiesBySeed) {
      const state = history.states[MATURE_AGE];
      const trunkTipSegmentIds = new Set(
        state.buds.filter((b) => b.order === 0 && b.status !== 'dead').map((b) => b.segmentId)
      );
      if (trunkTipSegmentIds.size < 2) continue;

      // Walk each trunk-class bud's lineage back toward the root via
      // parentId, collecting order-0 segments, to find each stem's
      // thickest (basal) segment.
      const byId = new Map(state.segments.map((s) => [s.id, s]));
      const basalRadiusByTip = [...trunkTipSegmentIds].map((tipId) => {
        let cur = byId.get(tipId);
        let basal = cur;
        while (cur && cur.order === 0) {
          basal = cur;
          cur = cur.parentId !== null ? byId.get(cur.parentId) : undefined;
        }
        return basal!.baseRadius;
      });
      basalRadiusByTip.sort((a, b) => b - a);
      const [thickest, secondThickest] = basalRadiusByTip;
      expect(secondThickest).toBeGreaterThan(thickest * 0.3);
      checked = true;
      break;
    }
    expect(checked).toBe(true); // sanity: at least one forked example existed to check
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
    // top should hold up noticeably better than that.
    expect(mean(ratios)).toBeGreaterThan(0.6);
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
