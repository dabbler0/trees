import type { ForestParams, ForestSnapshot, SimulationParams } from '../model/types';
import { ForestRunner } from './forest';

/**
 * Runs a forest simulation inside a dedicated Web Worker so a long
 * generation (see ForestRunner/ForestParams.years -- much larger now that
 * equilibrium freezing keeps most mature trees cheap) doesn't block the
 * main thread/UI, and streams progress back as it goes rather than
 * making the caller wait for the whole thing to finish.
 *
 * Loaded from main.ts via Vite's `?worker&inline` import suffix, which
 * bundles this file's compiled output as an inlined data URL rather than
 * a separate physical file -- required for this app's single-HTML-file
 * build (see vite.config.ts's own doc) to stay genuinely self-contained.
 *
 * Message protocol (see ForestWorkerStartMessage/ForestWorkerOutMessage):
 * the caller posts one `start` message; this worker replies with zero or
 * more `progress` messages (each carrying only the *new* snapshots
 * computed since the last one, not the whole history so far -- resending
 * the whole accumulated array every message would be an O(n^2) cost over
 * a long run) followed by exactly one final `done` message. `done`
 * deliberately does *not* resend every snapshot either: the caller is
 * expected to have already accumulated them all from the `progress`
 * messages, and `done` just carries the small metadata needed to
 * assemble the final ForestHistory around them.
 *
 * `self` is typed narrowly and explicitly below (just the two members
 * this file actually uses) rather than by pulling in TypeScript's
 * "webworker" lib, which isn't compatible with the "dom" lib the rest of
 * this project's single shared tsconfig already needs for the main
 * thread's window/document code.
 */
export interface ForestWorkerStartMessage {
  type: 'start';
  params: SimulationParams;
  forestParams: ForestParams;
  forestSeed: number;
}

export type ForestWorkerOutMessage =
  | { type: 'progress'; snapshots: ForestSnapshot[]; totalYears: number }
  | { type: 'done'; formatVersion: 1; params: SimulationParams; forestParams: ForestParams; forestSeed: number }
  | { type: 'error'; message: string };

declare const self: {
  onmessage: ((ev: { data: ForestWorkerStartMessage }) => void) | null;
  postMessage: (message: ForestWorkerOutMessage) => void;
};

/** Minimum real (wall-clock) time between progress messages, ms -- caps
 * postMessage/structured-clone overhead on a long run (which could
 * otherwise mean thousands of small messages) while still keeping the
 * UI's progress display and live scrubber feeling responsive during a
 * fast one. The very last year's snapshot is always sent immediately
 * regardless of this interval, so `done` never has to wait on it. */
const POST_MIN_INTERVAL_MS = 120;

self.onmessage = (e) => {
  const { params, forestParams, forestSeed } = e.data;
  try {
    const runner = new ForestRunner(params, forestParams, forestSeed);
    let pending: ForestSnapshot[] = [runner.snapshot()];
    let lastPostTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

    const flush = (): void => {
      if (pending.length === 0) return;
      self.postMessage({ type: 'progress', snapshots: pending, totalYears: forestParams.years });
      pending = [];
    };

    for (let y = 0; y < forestParams.years; y++) {
      pending.push(runner.stepOne());
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const isLast = y === forestParams.years - 1;
      if (isLast || now - lastPostTime >= POST_MIN_INTERVAL_MS) {
        flush();
        lastPostTime = now;
      }
    }
    flush();

    self.postMessage({ type: 'done', formatVersion: 1, params, forestParams, forestSeed });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
