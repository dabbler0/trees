import { describe, expect, it } from 'vitest';
import { defaultParams } from '../src/sim/params';
import { deserializeHistory, runSimulation, serializeHistory, SimulationRunner } from '../src/sim/simulate';
import { assertIsValidTree } from './testUtils';

describe('simulation determinism and I/O', () => {
  it('is deterministic for a fixed seed', () => {
    const a = runSimulation(defaultParams, 25);
    const b = runSimulation(defaultParams, 25);
    expect(serializeHistory(a)).toBe(serializeHistory(b));
  });

  it('produces one state per year including year 0 (the seedling)', () => {
    const history = runSimulation(defaultParams, 10);
    expect(history.states).toHaveLength(11);
    expect(history.states[0].year).toBe(0);
    expect(history.states[0].segments).toHaveLength(1);
    expect(history.states[10].year).toBe(10);
  });

  it('round-trips through JSON with no loss', () => {
    const history = runSimulation(defaultParams, 15);
    const restored = deserializeHistory(serializeHistory(history));
    expect(restored).toEqual(history);
    assertIsValidTree(restored.states[restored.states.length - 1]);
  });

  it('rejects an unrecognized format version', () => {
    expect(() => deserializeHistory(JSON.stringify({ formatVersion: 99 }))).toThrow();
  });

  it('SimulationRunner.stepMany matches an equivalent runSimulation run', () => {
    const runner = new SimulationRunner(defaultParams);
    runner.stepMany(20);
    const direct = runSimulation(defaultParams, 20);
    expect(serializeHistory(runner.history)).toBe(serializeHistory(direct));
  });
});
