import type { BranchSegment, TreeMetrics } from '../model/types';
import { distance } from '../model/vec3';

const BREAST_HEIGHT = 1.3; // meters, standard forestry DBH measurement height

/** Recompute each segment's derived `alive` flag: a segment is alive if it
 * currently carries foliage or supports at least one living descendant.
 * This makes "alive" a pure function of current leaf placement rather than
 * something that has to be threaded through as separate mutable state. */
export function recomputeAliveFlags(segments: Map<number, BranchSegment>): void {
  const ordered = [...segments.values()].sort((a, b) => b.id - a.id); // children before parents
  for (const s of ordered) {
    const anyChildAlive = s.childIds.some((cid) => segments.get(cid)?.alive);
    s.alive = s.leafArea > 0 || anyChildAlive;
  }
}

/**
 * Walks down from the root always following whichever child is currently
 * the *physically* dominant lineage (the one whose own subtree reaches
 * the greatest radius anywhere), not whichever child happens to share the
 * root's original `order`. Matching on order looks like "follow the
 * trunk" but isn't: a co-dominant fork always gets `order + 1` and never
 * inherits its parent's order (see growth.ts), so the original seedling
 * leader keeps order 0 for life even when -- as the sympodial-succession
 * mechanism this tree exercises intends -- a *different* axis has since
 * become the tree's real, structurally dominant stem. A diffusely-forking
 * tree (many early co-dominant splits) is exactly the case where this
 * bites hardest: DBH would end up measured on whatever the original
 * leader happens to have grown into, which by maturity can be a
 * comparatively minor stem, making a tree with substantial real total
 * wood cross-section (correctly summed across every branch by the pipe
 * model in pipeModel.ts) read as a deceptively thin trunk. Following
 * subtree-max-radius instead measures whichever stem is actually thickest
 * at every fork, exactly like the "which branch is the trunk" logic
 * exercised in tests/shape.test.ts's sympodial-growth test.
 */
function findTrunkChain(segments: readonly BranchSegment[]): BranchSegment[] {
  const byParent = new Map<number | null, BranchSegment[]>();
  for (const s of segments) {
    const list = byParent.get(s.parentId) ?? [];
    list.push(s);
    byParent.set(s.parentId, list);
  }

  const ordered = [...segments].sort((a, b) => b.id - a.id); // children before parents
  const subtreeMaxRadius = new Map<number, number>();
  for (const s of ordered) {
    let maxRadius = s.baseRadius;
    for (const cid of s.childIds) maxRadius = Math.max(maxRadius, subtreeMaxRadius.get(cid) ?? 0);
    subtreeMaxRadius.set(s.id, maxRadius);
  }

  const chain: BranchSegment[] = [];
  let current = byParent.get(null)?.[0];
  while (current) {
    chain.push(current);
    const children = byParent.get(current.id) ?? [];
    let best: BranchSegment | undefined;
    let bestRadius = -1;
    for (const c of children) {
      const r = subtreeMaxRadius.get(c.id) ?? 0;
      if (r > bestRadius) {
        bestRadius = r;
        best = c;
      }
    }
    current = best;
  }
  return chain;
}

function radiusAtHeight(chain: readonly BranchSegment[], height: number): number {
  for (const s of chain) {
    const y0 = s.start[1];
    const y1 = s.end[1];
    if (height >= y0 - 1e-9 && height <= y1 + 1e-9) {
      const t = y1 > y0 ? (height - y0) / (y1 - y0) : 0;
      return s.baseRadius + (s.tipRadius - s.baseRadius) * t;
    }
  }
  // Height is above the whole trunk (very young tree) or below it: clamp.
  if (chain.length === 0) return 0;
  if (height <= chain[0].start[1]) return chain[0].baseRadius;
  return chain[chain.length - 1].tipRadius;
}

export function computeMetrics(segments: readonly BranchSegment[]): TreeMetrics {
  let height = 0;
  for (const s of segments) height = Math.max(height, s.start[1], s.end[1]);

  const trunkChain = findTrunkChain(segments);
  const dbhHeight = Math.min(BREAST_HEIGHT, height * 0.9);
  const dbh = 2 * radiusAtHeight(trunkChain, dbhHeight);

  let crownBaseHeight = height;
  let crownRadius = 0;
  let totalLeafArea = 0;
  let liveSegmentCount = 0;
  let deadSegmentCount = 0;
  let woodyVolume = 0;
  let liveWoodyVolume = 0;

  for (const s of segments) {
    totalLeafArea += s.leafArea;
    if (s.alive) liveSegmentCount++;
    else deadSegmentCount++;

    if (s.leafArea > 0) {
      crownBaseHeight = Math.min(crownBaseHeight, s.start[1]);
      crownRadius = Math.max(crownRadius, Math.hypot(s.end[0], s.end[2]));
    }

    const len = distance(s.start, s.end);
    const r1 = s.baseRadius;
    const r2 = s.tipRadius;
    const volume = ((Math.PI * len) / 3) * (r1 * r1 + r1 * r2 + r2 * r2);
    woodyVolume += volume;
    if (s.alive) liveWoodyVolume += volume;
  }

  if (totalLeafArea === 0) crownBaseHeight = height; // fully dormant/leafless tree

  return {
    height,
    dbh,
    crownBaseHeight,
    crownWidth: crownRadius * 2,
    totalLeafArea,
    liveSegmentCount,
    deadSegmentCount,
    woodyVolume,
    liveWoodyVolume,
  };
}
