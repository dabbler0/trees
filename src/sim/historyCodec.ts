import type { Bud, BranchSegment, TreeState } from '../model/types';
import { computeHydraulicResistances } from './pipeModel';
import { computeMetrics } from './metrics';
import { placeLeaves } from './leaves';

/**
 * Compact wire format for a SimulationHistory.
 *
 * A mature tree spends most of its later life with the vast majority of
 * its segments completely unchanged year over year (only whichever
 * segments are still actively extending, plus their ancestors, ever
 * change) -- but every segment's `hydraulicResistance` is a *cumulative*
 * sum from the root, so it drifts by some tiny amount for literally
 * every segment whenever anything upstream grows at all. Left in, that
 * one derived field alone defeats any attempt to skip storing unchanged
 * segments. Since it (like `leaves` and `metrics`) is 100% a pure
 * function of the segments' own geometry/topology, all three are dropped
 * from the wire format entirely and recomputed on load -- this loses no
 * information, so a round trip still reconstructs an identical
 * SimulationHistory.
 *
 * What's actually stored per year is just which segments are new or
 * changed, and which ids were removed (abscised); everything else
 * carries forward untouched. Buds are cheap enough (tens to low
 * hundreds, vs. thousands of segments) that they're just stored in full
 * every year rather than diffed.
 */

type WireSegment = Omit<BranchSegment, 'hydraulicResistance'>;

export interface EncodedYear {
  year: number;
  segUpserts: WireSegment[];
  segRemoved: number[];
  buds: Bud[];
}

function vecEqual(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** Equality on every field except the derived, root-cumulative hydraulicResistance. */
function segmentUnchanged(a: BranchSegment, b: WireSegment): boolean {
  return (
    a.parentId === b.parentId &&
    a.kind === b.kind &&
    a.order === b.order &&
    a.alive === b.alive &&
    a.createdYear === b.createdYear &&
    a.baseRadius === b.baseRadius &&
    a.tipRadius === b.tipRadius &&
    a.leafArea === b.leafArea &&
    a.lightExposure === b.lightExposure &&
    vecEqual(a.start, b.start) &&
    vecEqual(a.end, b.end) &&
    a.childIds.length === b.childIds.length &&
    a.childIds.every((id, i) => id === b.childIds[i])
  );
}

export function encodeStates(states: readonly TreeState[]): EncodedYear[] {
  const prevById = new Map<number, WireSegment>();
  const encoded: EncodedYear[] = [];

  for (const state of states) {
    const segUpserts: WireSegment[] = [];
    const currentIds = new Set<number>();
    for (const s of state.segments) {
      currentIds.add(s.id);
      const prev = prevById.get(s.id);
      if (!prev || !segmentUnchanged(s, prev)) {
        const { hydraulicResistance: _drop, ...wire } = s;
        segUpserts.push(wire);
      }
    }
    const segRemoved: number[] = [];
    for (const id of prevById.keys()) {
      if (!currentIds.has(id)) segRemoved.push(id);
    }

    encoded.push({ year: state.year, segUpserts, segRemoved, buds: state.buds });

    for (const id of segRemoved) prevById.delete(id);
    for (const wire of segUpserts) prevById.set(wire.id, wire);
  }

  return encoded;
}

export function decodeStates(encoded: readonly EncodedYear[]): TreeState[] {
  const canonical = new Map<number, WireSegment>();
  const states: TreeState[] = [];

  for (const enc of encoded) {
    for (const id of enc.segRemoved) canonical.delete(id);
    for (const wire of enc.segUpserts) canonical.set(wire.id, wire);

    // Recompute hydraulicResistance fresh into per-year segment objects --
    // it must NOT be computed in place on shared `canonical` entries,
    // since that field's correct value differs every year even for a
    // segment whose own geometry hasn't changed (see module doc above).
    const yearSegments = new Map<number, BranchSegment>();
    for (const [id, wire] of canonical) yearSegments.set(id, { ...wire, hydraulicResistance: 0 });
    computeHydraulicResistances(yearSegments);

    const segments = [...yearSegments.values()];
    const leaves = placeLeaves(segments, enc.year);
    states.push({
      year: enc.year,
      segments,
      buds: enc.buds,
      leaves,
      metrics: computeMetrics(segments),
    });
  }

  return states;
}
