/**
 * Acceptance tests for the forest feature (src/sim/forest.ts), in the same
 * externally-observable-facts spirit as allometry.test.ts/roots.test.ts:
 * not internal mechanism details, but the real behaviors a forest of
 * competing trees should show.
 */
import { describe, expect, it } from 'vitest';
import { defaultParams } from '../src/sim/params';
import { defaultForestParams } from '../src/sim/forestParams';
import { runForestSimulation } from '../src/sim/forest';
import { runSimulation } from '../src/sim/simulate';
import { buildRootResourceProfile } from '../src/sim/rootCompetition';
import type { BranchSegment } from '../src/model/types';
import { assertIsValidTree } from './testUtils';

function rootSegment(overrides: Partial<BranchSegment> = {}): BranchSegment {
  return {
    id: 1,
    parentId: 0,
    childIds: [],
    kind: 'root',
    order: 0,
    start: [0, -0.1, 0],
    end: [0, -0.2, 0],
    baseRadius: 0.01,
    tipRadius: 0.01,
    createdYear: 0,
    alive: true,
    leafArea: 1,
    lightExposure: 1,
    hydraulicResistance: 0,
    ...overrides,
  };
}

describe('root-space competition (buildRootResourceProfile)', () => {
  it("a lone tree's own roots never throttle themselves, however dense", () => {
    const profile = buildRootResourceProfile([{ id: 0, offset: [0, 0], segments: [rootSegment({ leafArea: 50 })] }]);
    expect(profile.factorAt([0, -0.15, 0], 0)).toBe(1);
  });

  it("two trees' overlapping root systems measurably throttle each other, at the point of overlap", () => {
    const profile = buildRootResourceProfile([
      { id: 0, offset: [0, 0], segments: [rootSegment({ id: 1, start: [0, -0.1, 0], end: [0, -0.2, 0], leafArea: 2 })] },
      { id: 1, offset: [0.3, 0], segments: [rootSegment({ id: 2, start: [0.3, -0.1, 0], end: [0.3, -0.2, 0], leafArea: 2 })] },
    ]);
    // Both roots land in the same grid cell (well under ROOT_CELL_SIZE
    // apart) -- each tree's own factor at its own root should now be
    // measurably reduced by the *other* tree's competing root area there.
    expect(profile.factorAt([0, -0.15, 0], 0)).toBeLessThan(1);
    expect(profile.factorAt([0.3, -0.15, 0], 1)).toBeLessThan(1);
  });

  it('a query far from every root system sees no competition at all', () => {
    const profile = buildRootResourceProfile([
      { id: 0, offset: [0, 0], segments: [rootSegment({ leafArea: 50 })] },
      { id: 1, offset: [5, 5], segments: [rootSegment({ leafArea: 50 })] },
    ]);
    expect(profile.factorAt([40, -0.15, 40], 0)).toBe(1);
  });
});

describe('a lone tree in a forest of one grows exactly as it would alone', () => {
  it('matches a standalone single-tree run with the same (minted) seed, year by year', () => {
    const forestParams = { ...defaultForestParams, years: 30, maxTrees: 1, reproductionProbability: 0 };
    const forest = runForestSimulation(defaultParams, forestParams, 123);
    const founderSeed = forest.states[0].trees[0].seed;
    const solo = runSimulation({ ...defaultParams, seed: founderSeed }, 30);
    for (let year = 0; year <= 30; year++) {
      const forestTree = forest.states[year].trees[0].state;
      const soloTree = solo.states[year];
      expect(forestTree.segments.length).toBe(soloTree.segments.length);
      expect(forestTree.buds.length).toBe(soloTree.buds.length);
      expect(forestTree.metrics.height).toBeCloseTo(soloTree.metrics.height, 9);
      expect(forestTree.metrics.dbh).toBeCloseTo(soloTree.metrics.dbh, 9);
      expect(forestTree.metrics.rootWoodyVolume).toBeCloseTo(soloTree.metrics.rootWoodyVolume, 9);
    }
  }, 30_000);
});

describe('reproduction: a forest grows from one founder into a population', () => {
  it('starts with exactly one tree, planted at the origin', () => {
    const forest = runForestSimulation(defaultParams, { ...defaultForestParams, years: 1 }, 42);
    expect(forest.states[0].trees.length).toBe(1);
    expect(forest.states[0].trees[0].position).toEqual([0, 0]);
    expect(forest.states[0].trees[0].plantedYear).toBe(0);
  });

  it('propagates via reproduction and scattering into a real population over time, without exceeding the tree-count cap', () => {
    const forestParams = { ...defaultForestParams, years: 100 };
    const forest = runForestSimulation(defaultParams, forestParams, 42);
    for (const snap of forest.states) {
      expect(snap.trees.length).toBeLessThanOrEqual(forestParams.maxTrees);
    }
    const last = forest.states[forest.states.length - 1];
    expect(last.trees.length).toBeGreaterThan(1);
    // Scattering means offspring land away from their parent, not exactly
    // on top of it.
    const nonFounders = last.trees.filter((t) => t.id !== 0);
    for (const t of nonFounders) {
      expect(Math.hypot(t.position[0], t.position[1])).toBeGreaterThan(0);
    }
    // A later-germinated tree is strictly younger than the founder at the
    // same forest year.
    const founder = last.trees.find((t) => t.id === 0)!;
    for (const t of nonFounders) {
      expect(t.state.year).toBeLessThan(founder.state.year);
    }
  }, 60_000);

  it('every currently-alive tree is still a well-formed tree graph', () => {
    const forest = runForestSimulation(defaultParams, { ...defaultForestParams, years: 60 }, 8);
    const last = forest.states[forest.states.length - 1];
    expect(last.trees.length).toBeGreaterThan(0);
    for (const t of last.trees) assertIsValidTree(t.state);
  }, 30_000);
});

describe('light competition measurably suppresses a crowded tree relative to growing alone', () => {
  it('every offspring tree in a densely-packed stand grows less (height, leaf area) than the same individual (same seed) would growing by itself for the same number of years', () => {
    const forestParams = {
      ...defaultForestParams,
      years: 40,
      maxTrees: 25,
      seedDispersalRadius: 2.5,
      minTreeSpacing: 0.6,
      reproductionProbability: 0.5,
      seedsPerEvent: 3,
    };
    const forest = runForestSimulation(defaultParams, forestParams, 99);
    const last = forest.states[forest.states.length - 1];
    const offspring = last.trees.filter((t) => t.id !== 0 && t.state.year > 0);
    expect(offspring.length).toBeGreaterThan(0); // sanity: reproduction actually happened
    for (const t of offspring) {
      const solo = runSimulation({ ...defaultParams, seed: t.seed }, t.state.year);
      const soloState = solo.states[t.state.year];
      expect(t.state.metrics.height).toBeLessThan(soloState.metrics.height);
      expect(t.state.metrics.totalLeafArea).toBeLessThan(soloState.metrics.totalLeafArea);
    }
  }, 60_000);
});

describe('light-starved trees die and are removed from the forest', () => {
  it('a densely-packed population produces at least one whole-tree death, and the dead tree disappears from the living list', () => {
    const forestParams = {
      ...defaultForestParams,
      years: 150,
      seedDispersalRadius: 3,
      minTreeSpacing: 0.8,
      maxTrees: 25,
      reproductionProbability: 0.3,
      seedsPerEvent: 3,
    };
    const forest = runForestSimulation(defaultParams, forestParams, 7);
    const last = forest.states[forest.states.length - 1];
    expect(last.deadTrees.length).toBeGreaterThan(0);

    const deadIds = new Set(last.deadTrees.map((d) => d.id));
    const aliveIds = new Set(last.trees.map((t) => t.id));
    for (const id of deadIds) expect(aliveIds.has(id)).toBe(false);

    for (const d of last.deadTrees) {
      expect(d.cause).toBe('light starvation');
      expect(d.diedYear).toBeGreaterThan(d.plantedYear);
      expect(d.finalHeight).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);
});

describe('determinism', () => {
  it('is deterministic for a fixed forest seed', () => {
    const forestParams = { ...defaultForestParams, years: 30 };
    const a = runForestSimulation(defaultParams, forestParams, 55);
    const b = runForestSimulation(defaultParams, forestParams, 55);
    const lastA = a.states[a.states.length - 1];
    const lastB = b.states[b.states.length - 1];
    expect(lastA.trees.length).toBe(lastB.trees.length);
    for (let i = 0; i < lastA.trees.length; i++) {
      expect(lastA.trees[i].id).toBe(lastB.trees[i].id);
      expect(lastA.trees[i].position).toEqual(lastB.trees[i].position);
      expect(lastA.trees[i].state.metrics.height).toBeCloseTo(lastB.trees[i].state.metrics.height, 9);
      expect(lastA.trees[i].state.segments.length).toBe(lastB.trees[i].state.segments.length);
    }
  }, 30_000);
});
