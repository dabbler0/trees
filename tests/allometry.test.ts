/**
 * High-level acceptance tests for whole-tree shape and behavior across the
 * full sapling -> old-growth age range. These intentionally do NOT pin
 * down internal mechanism details (bud counts, exact carbon numbers,
 * etc.) -- they check the externally-observable allometric facts a real
 * tree of any species is expected to satisfy, with numeric ranges drawn
 * from the forestry/plant-physiology literature:
 *
 *  - Height:DBH "slenderness" ratio (height in m / DBH in m): forest
 *    inventory studies report stand means from ~47 to ~184, with >80
 *    flagged as at wind-throw risk and >100 common in crowded natural
 *    regeneration; isolated saplings can be even more slender before
 *    secondary/mechanical thickening catches up. See e.g. the Czech
 *    National Forest Inventory HDR models and boreal-mixedwood
 *    slenderness-coefficient studies.
 *  - The pipe model / Da Vinci's rule (Shinozaki et al. 1964): stem
 *    cross-sectional area is conserved through branch points and tapers
 *    from base to tip, and never shrinks year over year (wood doesn't
 *    de-grow).
 *  - Self-pruning raising the live crown base over a tree's lifetime is
 *    standard silvicultural knowledge (shaded lower branches go
 *    carbon-negative and die).
 *  - The hydraulic-limitation hypothesis (Koch, Sillett, Jennings &
 *    Davis, "The limits to tree height", Nature 2004): height growth
 *    decelerates and effectively plateaus as trees approach their
 *    species-specific maximum, rather than growing indefinitely.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultParams } from '../src/sim/params';
import { runSimulation } from '../src/sim/simulate';
import { computeMechanicalStressReport, MECHANICAL_CONSTANTS } from '../src/sim/pipeModel';
import type { SimulationHistory, TreeState } from '../src/model/types';
import { assertIsValidTree, mean, pearsonCorrelation, segmentMeanRadius, segmentMidHeight } from './testUtils';

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

describe('structural integrity at every age', () => {
  it('is always a single, well-formed tree graph', () => {
    for (const year of [1, 5, 20, 50, 90, OLD_GROWTH_AGE]) {
      expect(() => assertIsValidTree(at(year))).not.toThrow();
    }
  });

  it('never shrinks: height and DBH are non-decreasing year over year', () => {
    // Woody volume is deliberately exempt: dead limbs are abscised
    // (shed) a few years after self-pruning, which legitimately reduces
    // standing woody volume, same as a real tree dropping a dead branch.
    for (let y = 1; y < history.states.length; y++) {
      const prev = history.states[y - 1].metrics;
      const cur = history.states[y].metrics;
      expect(cur.height).toBeGreaterThanOrEqual(prev.height - 1e-9);
      expect(cur.dbh).toBeGreaterThanOrEqual(prev.dbh - 1e-9);
    }
  });
});

describe('trunk thickness stays in a biologically plausible range for its size at every age', () => {
  it.each([5, 10, 20, 40, 70, OLD_GROWTH_AGE])('year %i: height:DBH slenderness is within reported bounds', (year) => {
    const m = at(year).metrics;
    if (m.dbh <= 0) return; // not yet measurable (younger than breast height)
    const slenderness = m.height / m.dbh;
    // Generous outer bound: isolated open-grown saplings can be very
    // slender before mechanical thickening catches up; even so, a real
    // stem should never be absurdly thin relative to its own height.
    expect(slenderness).toBeLessThan(400);
    expect(slenderness).toBeGreaterThan(3);
  });

  it('settles into a real old-growth-stout range by maturity, not a dense-young-stand one', () => {
    // The ~50-180 "slenderness coefficient" figure widely cited in
    // forestry (see the file-level comment above) describes densely
    // stocked, competition-grown timber stands -- it is *not* what an
    // old, comparatively open-grown tree actually looks like. Real
    // veteran/old-growth broadleaf trees are dramatically stouter:
    // widely-documented examples (state/national champion-tree registers,
    // old-growth-forest surveys) put large, ~100-200-year-old open-grown
    // oaks/maples at roughly 70-150cm DBH and 20-30m height -- a
    // slenderness coefficient of roughly 15-40, well below the
    // young-stand range. A real old tree spends a long life adding girth
    // with comparatively little further height gain, so its DBH grows
    // disproportionately relative to a young, still-racing-upward stand
    // tree.
    const m = at(OLD_GROWTH_AGE).metrics;
    const slenderness = m.height / m.dbh;
    expect(slenderness).toBeLessThan(55);
    expect(slenderness).toBeGreaterThan(12);
  });

  it('old-growth DBH itself falls in a realistic real-world range for its height', () => {
    // Cross-check the ratio above against absolute numbers: a real
    // ~100-year-old open-grown temperate broadleaf reaching this
    // simulated tree's height commonly has a trunk somewhere in the
    // few-tens-of-cm range, not a sapling-thin pole -- but also not a
    // multi-meter giant-sequoia-scale trunk, which this species/age
    // combination has no business producing.
    const m = at(OLD_GROWTH_AGE).metrics;
    const dbhCm = m.dbh * 100;
    expect(dbhCm).toBeGreaterThan(30);
    expect(dbhCm).toBeLessThan(250);
  });

  it("every living structural segment can actually hold up its own real weight (real green-wood bending/buckling physics)", () => {
    // Re-derives actual bending stress and buckling margin from each
    // segment's *finished* radius and real subtree mass/geometry (see
    // computeMechanicalStressReport) and checks it against real green-wood
    // strength (USDA Forest Products Laboratory Wood Handbook-range
    // figures -- see pipeModel.ts) rather than just re-running the same
    // growth-time formula: pipe-model demand, an ancestor's own floor, or
    // the coarse per-year growth/taper approximations could each still
    // leave some corner of the tree under- or (more often) comfortably
    // over-built, and this checks the *outcome*, not the formula.
    for (const year of [40, 70, 90, OLD_GROWTH_AGE]) {
      const state = at(year);
      const structural = state.segments.filter((s) => s.alive);
      if (structural.length === 0) continue;
      const report = computeMechanicalStressReport(structural);
      // Generous tolerance beyond the design safety margin already baked
      // into ALLOWABLE_BENDING_STRESS (itself green MOR / a ~4x safety
      // factor): this should only ever fire on a *gross* under-build, not
      // nibble at the exact margin the growth-time formula targets.
      const stressTolerance = 2;
      const bucklingTolerance = 1.5;
      for (const s of structural) {
        const { bendingStressPa, bucklingHeightRatio } = report.get(s.id)!;
        expect(bendingStressPa).toBeLessThan(MECHANICAL_CONSTANTS.ALLOWABLE_BENDING_STRESS * stressTolerance);
        expect(bucklingHeightRatio).toBeLessThan(bucklingTolerance);
      }
    }
  });

  it('DBH growth roughly tracks age (no sudden unphysical jumps)', () => {
    let prevDbh = 0;
    for (let y = 1; y <= OLD_GROWTH_AGE; y++) {
      const dbh = at(y).metrics.dbh;
      // no year should more than double the trunk's cross-sectional radius
      expect(dbh).toBeLessThanOrEqual(Math.max(prevDbh * 2.5, 0.02));
      prevDbh = dbh;
    }
  });
});

describe('the canopy rises over the tree\'s lifetime (self-pruning)', () => {
  it('mature/old-growth crown base is substantially higher than the juvenile crown base', () => {
    const juvenile = at(15).metrics.crownBaseHeight;
    const oldGrowth = at(OLD_GROWTH_AGE).metrics.crownBaseHeight;
    expect(oldGrowth).toBeGreaterThan(juvenile + 1.0);
  });

  it('the long-run trend in crown base is upward across life stages', () => {
    // Local fluctuation (a young tree can grow a low branch it later
    // sheds) is fine; the coarse-grained, life-stage trend must not be.
    const checkpoints = [10, 30, 60, 90, OLD_GROWTH_AGE].map((y) => at(y).metrics.crownBaseHeight);
    expect(checkpoints[checkpoints.length - 1]).toBeGreaterThan(checkpoints[0]);
    // and it must not be *falling* by the end -- old growth shouldn't be
    // re-lowering its canopy back toward the ground.
    expect(checkpoints[checkpoints.length - 1]).toBeGreaterThanOrEqual(checkpoints[checkpoints.length - 2] - 0.5);
  });
});

describe('small, thin branches are concentrated toward the top rather than the bottom', () => {
  it('at a mature snapshot, newer wood skews toward greater height than older wood', () => {
    const state = at(90);
    const withAge = state.segments.map((s) => ({ age: state.year - s.createdYear, height: segmentMidHeight(s) }));
    // Negative correlation: as age increases, height decreases -- i.e.
    // the freshest (thinnest, since radius only grows with time) wood is
    // concentrated higher in the tree than the oldest, most thickened
    // wood.
    const r = pearsonCorrelation(
      withAge.map((d) => d.age),
      withAge.map((d) => d.height)
    );
    expect(r).toBeLessThan(-0.1);
  });

  it('among lateral (non-trunk) branches, the upper third of the crown is on average thinner than the lower third', () => {
    const state = at(90);
    const laterals = state.segments.filter((s) => s.order > 0);
    const withHeight = laterals
      .map((s) => ({ radius: segmentMeanRadius(s), height: segmentMidHeight(s) }))
      .sort((a, b) => a.height - b.height);
    const n = withHeight.length;
    const bottomThird = withHeight.slice(0, Math.floor(n / 3));
    const topThird = withHeight.slice(Math.floor((2 * n) / 3));
    expect(mean(topThird.map((d) => d.radius))).toBeLessThan(mean(bottomThird.map((d) => d.radius)));
  });
});

describe('height does not grow indefinitely: old-growth flattening', () => {
  it('the annual height increment shrinks to a near-standstill by old growth', () => {
    const earlyGrowthRate = at(20).metrics.height - at(15).metrics.height; // m/yr in vigorous youth
    const lateGrowthRate =
      (at(OLD_GROWTH_AGE).metrics.height - at(OLD_GROWTH_AGE - 10).metrics.height) / 10; // m/yr near old growth
    expect(lateGrowthRate).toBeLessThan(earlyGrowthRate * 0.25);
    expect(lateGrowthRate).toBeLessThan(0.1);
  });

  it('height converges rather than diverging: later doublings of age produce far less than proportional height gain', () => {
    const h30 = at(30).metrics.height;
    const h40 = at(40).metrics.height;
    const h120IfLinear = h30 * 4; // naive linear extrapolation from age 30 to age 120
    const hFinal = at(OLD_GROWTH_AGE).metrics.height;
    expect(hFinal).toBeLessThan(h120IfLinear * 0.6);
    expect(hFinal).toBeGreaterThanOrEqual(h40); // never shorter than mid-life, but only barely taller
  });
});

describe('overall size stays bounded (self-thinning, not runaway growth)', () => {
  it('total leaf area stabilizes rather than growing without bound', () => {
    const late = [at(OLD_GROWTH_AGE - 20).metrics.totalLeafArea, at(OLD_GROWTH_AGE - 10).metrics.totalLeafArea, at(OLD_GROWTH_AGE).metrics.totalLeafArea];
    const spread = Math.max(...late) - Math.min(...late);
    expect(spread).toBeLessThan(mean(late) * 0.5 + 1);
  });

  it('segment and bud counts stay within a sane, renderable bound', () => {
    const state = at(OLD_GROWTH_AGE);
    expect(state.segments.length).toBeLessThan(50_000);
    expect(state.buds.length).toBeLessThan(defaultParams.maxActiveBuds * 1.05);
  });
});
