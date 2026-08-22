import type { BranchSegment, Leaf } from '../model/types';
import { add, distance, lerp, normalize, type Vec3 } from '../model/vec3';

/** Typical broadleaf leaf blade area, m^2 (~40 cm^2). Only used to turn a
 * segment's continuous leafArea into a discrete, renderable point cloud. */
const AVG_LEAF_AREA = 0.004;

export function placeLeaves(
  segments: readonly BranchSegment[],
  year: number,
  rng: () => number,
  nextLeafId: { current: number }
): Leaf[] {
  const leaves: Leaf[] = [];
  for (const s of segments) {
    if (s.leafArea <= 0 || !s.alive) continue;
    const count = Math.max(1, Math.round(s.leafArea / AVG_LEAF_AREA));
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const base = lerp(s.start, s.end, t);
      const jitterDir = normalize([rng() - 0.5, rng() * 0.6, rng() - 0.5]);
      const jitterDist = 0.05 + rng() * 0.15;
      const position: Vec3 = add(base, [
        jitterDir[0] * jitterDist,
        jitterDir[1] * jitterDist,
        jitterDir[2] * jitterDist,
      ]);
      leaves.push({
        id: nextLeafId.current++,
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
