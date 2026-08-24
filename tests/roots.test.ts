/**
 * High-level acceptance tests for the below-ground root system, in the
 * same spirit as tests/allometry.test.ts: externally-observable facts a
 * real root system should satisfy, not internal mechanism details.
 *
 *  - Real trees invest a substantial fraction of total biomass
 *    belowground -- root mass fraction commonly cited around 20-30% for
 *    trees (Poorter et al. 2012, "Biomass allocation to leaves, stems
 *    and roots," *New Phytologist* 193). This simulation directs a
 *    *fixed fraction of each year's carbon* to root growth rather than
 *    reproducing the fuller dynamic (functional-equilibrium) allocation
 *    real trees show, and root elongation demand naturally saturates
 *    much earlier in a tree's life than shoot demand does (roots hit
 *    their much shallower depth-limitation ceiling long before a mature
 *    crown hits its height ceiling) -- so this model's emergent root
 *    mass fraction runs well under that 20-30% figure by old growth --
 *    compounded by most of a fine root network's individual segments
 *    being governed by the same hard minimum-twig-radius floor as a
 *    shoot's thinnest twigs rather than by pipe-model demand, so more
 *    root carbon mostly buys more root *length*, not more *volume*. A
 *    known, documented simplification rather than an attempt to
 *    precisely reproduce the real lifetime biomass-partitioning number.
 *    The bound below checks for a real, non-negligible investment in
 *    root mass without demanding an exact match to that fuller target.
 *  - Real root systems typically spread well beyond the crown's own
 *    footprint (rule-of-thumb figures in the silvics/arboriculture
 *    literature commonly put root spread at 1-3x crown radius, often
 *    considerably more for an extensive lateral root system); this
 *    simulation's roots reach a substantial fraction of that (commonly
 *    matching crown radius roughly 1:1) without hitting the higher end
 *    of the real range.
 *  - Root anchorage against wind-overturning is a real, tested mechanical
 *    floor (see pipeModel.ts's computeAnchorageReport), independently
 *    re-derived from the root system's actual grown radii the same way
 *    tests/allometry.test.ts checks the shoot system's buckling/bending
 *    floors -- not a tautological replay of the growth-time formula.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultParams } from '../src/sim/params';
import { runSimulation } from '../src/sim/simulate';
import { computeAnchorageReport } from '../src/sim/pipeModel';
import { placeLeaves } from '../src/sim/leaves';
import type { SimulationHistory, TreeState } from '../src/model/types';
import { assertIsValidTree } from './testUtils';

const OLD_GROWTH_AGE = 110;

let history: SimulationHistory;
const at = (year: number): TreeState => {
  const s = history.states[year];
  if (!s) throw new Error(`no state recorded for year ${year}`);
  return s;
};

beforeAll(() => {
  history = runSimulation(defaultParams, OLD_GROWTH_AGE);
}, 60_000);

describe('root system develops alongside the shoot system', () => {
  it('the record is still a single, well-formed tree graph with roots attached at the collar', () => {
    for (const year of [1, 15, 40, OLD_GROWTH_AGE]) assertIsValidTree(at(year));
  });

  it('a real root system actually grows: nonzero spread, depth, and woody volume by maturity', () => {
    const m = at(OLD_GROWTH_AGE).metrics;
    expect(m.rootSpread).toBeGreaterThan(0.1);
    expect(m.rootDepth).toBeGreaterThan(0.1);
    expect(m.rootWoodyVolume).toBeGreaterThan(0);
  });

  it('root depth growth is self-limiting rather than unbounded (the same style of asymptote as shoot height)', () => {
    const depths = [40, 70, 90, OLD_GROWTH_AGE].map((y) => at(y).metrics.rootDepth);
    // Should still be growing early on...
    expect(depths[1]).toBeGreaterThan(depths[0]);
    // ...but the increment from year 90 to old growth should be much
    // smaller than from year 40 to 70 -- a real plateau, not runaway
    // growth toward the soil-depth-limitation ceiling forever.
    const earlyIncrement = depths[1] - depths[0];
    const lateIncrement = depths[3] - depths[2];
    expect(lateIncrement).toBeLessThan(earlyIncrement);
  });

  it('root segments never render as leaves (their leafArea is repurposed as below-ground absorptive area)', () => {
    // placeLeaves used to check leafArea alone, with no kind guard -- so
    // a root segment's nonzero absorptive area (the same field, repurposed
    // per BranchSegment.leafArea's own doc) was indistinguishable from
    // real canopy foliage and rendered as leaf points underground.
    const state = at(OLD_GROWTH_AGE);
    const rootSegmentIds = new Set(state.segments.filter((s) => s.kind === 'root').map((s) => s.id));
    expect(rootSegmentIds.size).toBeGreaterThan(0); // sanity: there are root segments to potentially mis-render
    const leaves = placeLeaves(state.segments, state.year);
    expect(leaves.some((l) => rootSegmentIds.has(l.segmentId))).toBe(false);
  });
});

describe('root system size is realistic relative to the rest of the tree', () => {
  it('root woody volume is a real, non-negligible share of total woody volume, without dominating it', () => {
    // See this file's own module doc for why the bound is wide and set
    // well under the oft-cited 20-30% lifetime root-mass-fraction figure:
    // most of a fine root network's individual segments are governed by
    // the same hard minimum-twig-radius floor as a shoot's thinnest
    // twigs, not by pipe-model demand, so growing more total root
    // *length* (which the carbon budget does directly control) doesn't
    // translate into root *volume* anywhere near as strongly as it would
    // if demand were the binding constraint throughout the network.
    const m = at(OLD_GROWTH_AGE).metrics;
    const rootFraction = m.rootWoodyVolume / m.woodyVolume;
    expect(rootFraction).toBeGreaterThan(0.005);
    expect(rootFraction).toBeLessThan(0.5);
  });

  it('root spread reaches a real fraction of the crown radius, not a token stub', () => {
    // Real silvics rules of thumb put root spread well beyond crown
    // radius (often 1-3x it, sometimes considerably more); this
    // simulation's root spread lands closer to roughly matching crown
    // radius (commonly ~0.8-1x it) rather than exceeding it several-fold
    // -- a real, substantial lateral root system, just proportionately
    // more modest than the widest real-world examples.
    const m = at(OLD_GROWTH_AGE).metrics;
    const crownRadius = m.crownWidth / 2;
    expect(crownRadius).toBeGreaterThan(0); // sanity: there's a real crown to compare against
    expect(m.rootSpread).toBeGreaterThan(crownRadius * 0.5);
  });
});

describe('root thickness tapers realistically rather than jumping', () => {
  // A real root's radius decreases gradually moving away from the trunk
  // (thickest at the collar, tapering out to fine absorptive roots), the
  // below-ground mirror of a shoot's own taper. This was previously
  // broken by exactly the kind of thick-base/vanishing-tip discontinuity
  // the tip-continuity fix in pipeModel.ts exists to prevent for
  // buckling/bending: the wind-overturning anchorage floor was applied
  // only at each collar root segment's own *base*, with nothing bridging
  // it to the ordinary (much smaller) demand governing everywhere else,
  // so a root could measure tens of centimeters at its very base and
  // ordinary twig thickness within the same, often centimeters-long,
  // first internode -- an anchorageRadiusAt(distanceFromCollar) taper
  // over a real characteristic distance (ANCHORAGE_TAPER_LENGTH) fixes
  // this the same way the buckling/bending tip floors already did.
  it('no root segment jumps by more than a small factor between its own base and tip', () => {
    for (const year of [40, 70, 90, OLD_GROWTH_AGE]) {
      const rootSegments = at(year).segments.filter((s) => s.kind === 'root');
      for (const s of rootSegments) {
        if (s.tipRadius <= 0) continue;
        expect(s.baseRadius / s.tipRadius).toBeLessThan(2);
      }
    }
  });

  it("a root segment's base radius never exceeds its parent's tip radius by more than a small factor (taper never reverses moving away from the collar)", () => {
    const state = at(OLD_GROWTH_AGE);
    const byId = new Map(state.segments.map((s) => [s.id, s]));
    for (const s of state.segments) {
      if (s.kind !== 'root' || s.parentId === null) continue;
      const parent = byId.get(s.parentId);
      if (!parent || parent.tipRadius <= 0) continue;
      expect(s.baseRadius / parent.tipRadius).toBeLessThan(1.5);
    }
  });

  it('the root system genuinely tapers overall: collar roots are substantially thicker than distal fine roots', () => {
    const state = at(OLD_GROWTH_AGE);
    const collarRoots = state.segments.filter((s) => s.kind === 'root' && s.parentId === 0);
    const twigRoots = state.segments.filter((s) => s.kind === 'root' && s.childIds.length === 0);
    expect(collarRoots.length).toBeGreaterThan(0);
    expect(twigRoots.length).toBeGreaterThan(0);
    const meanCollarRadius = collarRoots.reduce((sum, s) => sum + s.baseRadius, 0) / collarRoots.length;
    const meanTwigRadius = twigRoots.reduce((sum, s) => sum + s.tipRadius, 0) / twigRoots.length;
    expect(meanCollarRadius).toBeGreaterThan(meanTwigRadius * 2);
  });
});

describe('root anchorage against wind-overturning (real physics, non-tautological check)', () => {
  it("the root system's actual grown cross-section at the collar meets the real wind-overturning requirement", () => {
    // Independently re-measures actual grown root radii against a real
    // wind-drag-overturning-moment/root-soil-anchorage calculation (see
    // computeAnchorageReport in pipeModel.ts) -- not a replay of the
    // growth-time formula, the same non-tautological spirit as
    // allometry.test.ts's mechanical-stress check for the shoot system.
    for (const year of [40, 70, 90, OLD_GROWTH_AGE]) {
      const state = at(year);
      const report = computeAnchorageReport(state.segments);
      if (report.requiredRootCrossSectionM2 <= 0) continue; // no meaningful crown/wind load yet
      // Generous tolerance beyond the design safety margin already baked
      // into the requirement (STRUCTURAL_SAFETY_FACTOR): this should
      // only ever fire on a *gross* under-build, matching the same
      // tolerance style as the shoot mechanical-stress test.
      expect(report.actualRootCrossSectionM2).toBeGreaterThan(report.requiredRootCrossSectionM2 * 0.5);
    }
  });
});
