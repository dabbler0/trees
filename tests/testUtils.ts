import type { BranchSegment, TreeState } from '../src/model/types';
import { distance } from '../src/model/vec3';

export const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

export function pearsonCorrelation(xs: number[], ys: number[]): number {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

export function segmentMidHeight(s: BranchSegment): number {
  return (s.start[1] + s.end[1]) / 2;
}

export function segmentMeanRadius(s: BranchSegment): number {
  return (s.baseRadius + s.tipRadius) / 2;
}

export function segmentLength(s: BranchSegment): number {
  return distance(s.start, s.end);
}

/** Every non-root segment's parent must exist and appear exactly where the
 * parent's own childIds say it should -- i.e. the record really is a tree,
 * not just an unstructured bag of segments. */
export function assertIsValidTree(state: TreeState): void {
  const byId = new Map(state.segments.map((s) => [s.id, s]));
  let roots = 0;
  for (const s of state.segments) {
    if (s.parentId === null) {
      roots++;
      continue;
    }
    const parent = byId.get(s.parentId);
    if (!parent) throw new Error(`segment ${s.id} references missing parent ${s.parentId}`);
    if (!parent.childIds.includes(s.id)) {
      throw new Error(`segment ${s.id}'s parent ${s.parentId} does not list it as a child`);
    }
  }
  if (roots !== 1) throw new Error(`expected exactly 1 root segment, found ${roots}`);
  for (const s of state.segments) {
    for (const cid of s.childIds) {
      const child = byId.get(cid);
      if (!child) throw new Error(`segment ${s.id} lists missing child ${cid}`);
      if (child.parentId !== s.id) throw new Error(`child ${cid} does not point back to parent ${s.id}`);
    }
  }
}
