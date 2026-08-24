import type { BranchSegment, Leaf } from '../model/types';
import { makeRng } from '../model/rng';
import { add, distance, lerp, normalize, type Vec3 } from '../model/vec3';

/** Typical broadleaf leaf blade area, m^2 (~40 cm^2). Only used to turn a
 * segment's continuous leafArea into a discrete, renderable point cloud. */
const AVG_LEAF_AREA = 0.004;
/** Generous upper bound on leaves per segment, used to build stable,
 * collision-free leaf ids from (segmentId, index) below. */
const MAX_LEAVES_PER_SEGMENT = 1000;

/**
 * Leaf placement is a pure function of a segment's own (id, start, end,
 * leafArea, createdYear) -- it deliberately does NOT consume the shared
 * simulation rng, so an unchanged segment produces byte-identical leaves
 * (same ids, same jittered positions) year after year instead of
 * reshuffling its foliage every season. This is both more realistic
 * (real leaves don't randomly relocate on an otherwise-unchanged twig)
 * and what lets a fully plateaued, no-longer-changing tree be recognized
 * and compactly encoded when a SimulationHistory is serialized (see
 * simulate.ts).
 */
export function placeLeaves(segments: readonly BranchSegment[], year: number): Leaf[] {
  const leaves: Leaf[] = [];
  for (const s of segments) {
    // Root segments repurpose leafArea to mean absorptive fine-root
    // surface area (see BranchSegment.leafArea) -- real, but not actual
    // foliage, so it must never turn into rendered leaf points.
    if (s.kind !== 'shoot' || s.leafArea <= 0 || !s.alive) continue;
    const count = Math.min(MAX_LEAVES_PER_SEGMENT, Math.max(1, Math.round(s.leafArea / AVG_LEAF_AREA)));
    const localRng = makeRng((s.id * 2654435761) >>> 0);
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const base = lerp(s.start, s.end, t);
      const jitterDir = normalize([localRng() - 0.5, localRng() * 0.6, localRng() - 0.5]);
      const jitterDist = 0.05 + localRng() * 0.15;
      const position: Vec3 = add(base, [
        jitterDir[0] * jitterDist,
        jitterDir[1] * jitterDist,
        jitterDir[2] * jitterDist,
      ]);
      leaves.push({
        id: s.id * MAX_LEAVES_PER_SEGMENT + i,
        segmentId: s.id,
        position,
        normal: jitterDir,
        area: s.leafArea / count,
        ageYears: year - s.createdYear,
      });
    }
  }
  return leaves;
}

// re-export for callers that just need segment length without importing vec3 directly
export { distance as segmentLength };
