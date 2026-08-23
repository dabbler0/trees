import type { SimulationHistory, SimulationParams, TreeState } from '../model/types';
import { makeRng } from '../model/rng';
import { createInitialState, stepYear, type GrowthContext } from './growth';
import { decodeStates, encodeStates } from './historyCodec';

/**
 * Run a full simulation from a bare seedling for `years` growing seasons.
 * Deterministic for a given (params, years) pair via params.seed.
 *
 * The simulation is entirely decoupled from rendering: this returns a
 * plain, JSON-serializable SimulationHistory that can be saved, re-loaded,
 * and scrubbed through by a renderer with no re-computation needed.
 */
export function runSimulation(params: SimulationParams, years: number, species = 'generic broadleaf'): SimulationHistory {
  const rng = makeRng(params.seed);
  const { state: initial, ctx } = createInitialState();
  const states: TreeState[] = [initial];
  let current = initial;
  for (let y = 0; y < years; y++) {
    current = stepYear(current, params, rng, ctx);
    states.push(current);
  }
  return { formatVersion: 1, species, params, states };
}

/** Incremental runner for interactive use (e.g. "grow 10 more years" in the
 * UI without redoing the whole history). Mutates nothing; returns a new
 * history object sharing the unaffected state objects. */
export class SimulationRunner {
  private ctx: GrowthContext;
  private rng: () => number;
  public history: SimulationHistory;

  constructor(params: SimulationParams, species = 'generic broadleaf') {
    const { state, ctx } = createInitialState();
    this.ctx = ctx;
    this.rng = makeRng(params.seed);
    this.history = { formatVersion: 1, species, params, states: [state] };
  }

  stepOne(): TreeState {
    const prev = this.history.states[this.history.states.length - 1];
    const next = stepYear(prev, this.history.params, this.rng, this.ctx);
    this.history.states.push(next);
    return next;
  }

  stepMany(n: number): TreeState {
    let last = this.history.states[this.history.states.length - 1];
    for (let i = 0; i < n; i++) last = this.stepOne();
    return last;
  }
}

/**
 * Serializes to a compact wire format (see historyCodec.ts): each year
 * stores only which segments are new/changed/removed relative to the
 * last, and drops the `leaves`/`metrics`/per-segment
 * `hydraulicResistance` entirely, since all three are pure functions of
 * the segment set and are recomputed on load. The in-memory
 * SimulationHistory/TreeState shapes this function accepts (and
 * deserializeHistory returns) are unaffected -- this is purely a
 * wire-format detail, and the round trip is lossless.
 */
export function serializeHistory(history: SimulationHistory): string {
  return JSON.stringify({ ...history, states: encodeStates(history.states) });
}

export function deserializeHistory(json: string): SimulationHistory {
  const parsed = JSON.parse(json) as SimulationHistory;
  if (parsed.formatVersion !== 1) {
    throw new Error(`Unsupported simulation history format version: ${parsed.formatVersion}`);
  }
  return { ...parsed, states: decodeStates(parsed.states as unknown as Parameters<typeof decodeStates>[0]) };
}
