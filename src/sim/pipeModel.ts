import type { BranchSegment, SimulationParams } from '../model/types';
import { distance } from '../model/vec3';

const MIN_TWIG_RADIUS = 0.0025; // 2.5mm floor, roughly a current-year twig

/**
 * Secondary growth ("thickening") pass, applied once per simulated year
 * after this year's elongation/branching decisions are final.
 *
 * Two biologically-motivated mechanisms, combined by taking whichever
 * demands more wood (radius can only ever grow, matching real cambial
 * growth):
 *
 *  1. Pipe model theory (Shinozaki et al. 1964) / Leonardo da Vinci's
 *     branching rule: the sapwood cross-sectional area at any point must
 *     be enough to supply every unit of leaf area distal to it, and the
 *     cross-section is conserved across a branching point (sum of
 *     children's basal area ~= parent's cross-section just below them).
 *     We implement this as a bottom-up accumulation of "area demand" over
 *     the branch graph.
 *
 *  2. Mechanical self-support: a free-standing column/cantilever needs
 *     disproportionately more radius as the load overhead (its own height
 *     and the crown it carries) grows, well past what photosynthetic
 *     pipe-model demand alone would require (real trunks keep thickening
 *     long after their lower limbs have died and stopped producing
 *     leaves). We approximate this with a Greenhill-style d ~ h^1.5 floor
 *     on the trunk axis.
 *
 * This function mutates baseRadius/tipRadius/hydraulicResistance in place
 * on the provided segments (which should already carry this year's
 * leafArea and the previous year's radii as a floor).
 */
export function applyPipeModelAndMechanics(
  segments: Map<number, BranchSegment>,
  treeHeight: number,
  params: SimulationParams
): void {
  const ordered = [...segments.values()].sort((a, b) => b.id - a.id); // children (higher id) before parents

  const subtreeAreaDemand = new Map<number, number>();
  for (const s of ordered) {
    const ownDemand = params.pipeModelRatio * s.leafArea;
    let childDemand = 0;
    for (const cid of s.childIds) {
      childDemand += subtreeAreaDemand.get(cid) ?? 0;
    }
    subtreeAreaDemand.set(s.id, ownDemand + childDemand);
  }

  for (const s of ordered) {
    const total = subtreeAreaDemand.get(s.id) ?? 0;
    let childDemand = 0;
    for (const cid of s.childIds) childDemand += subtreeAreaDemand.get(cid) ?? 0;

    const pipeBaseRadius = Math.sqrt(total / Math.PI);
    const pipeTipRadius = s.childIds.length > 0 ? Math.sqrt(childDemand / Math.PI) : MIN_TWIG_RADIUS;

    let mechanicalFloor = 0;
    if (s.order === 0) {
      const heightAboveBase = Math.max(0, treeHeight - s.start[1]);
      mechanicalFloor = params.mechanicalThickeningFactor * Math.pow(heightAboveBase, 1.5);
    }

    s.baseRadius = Math.max(s.baseRadius, pipeBaseRadius, mechanicalFloor, MIN_TWIG_RADIUS);
    s.tipRadius = Math.max(Math.min(s.tipRadius, s.baseRadius), pipeTipRadius, MIN_TWIG_RADIUS);
    if (s.tipRadius > s.baseRadius) s.baseRadius = s.tipRadius;
  }

  computeHydraulicResistances(segments);
}

/**
 * Hydraulic path resistance: a simple resistor-network analogy. Sapwood
 * is a bundle of many fine conduits, so total conductance scales with
 * cross-sectional area (not radius^4, which is the single-pipe
 * Hagen-Poiseuille case) -- resistance_i = length_i / area_i. Path
 * resistance to a tip is the sum of resistances from the root down.
 *
 * Pulled out as its own pure function (a function of radius/geometry
 * only) because it's *also* used to recompute this purely-derived field
 * after loading a serialized history, where it's dropped from the wire
 * format entirely: cumulative-from-root fields like this one change by a
 * tiny amount on literally every segment whenever anything upstream
 * grows at all, which would defeat any attempt to compactly diff one
 * year's tree against the next (see historyCodec.ts).
 */
export function computeHydraulicResistances(segments: Map<number, BranchSegment>): void {
  const resistanceCache = new Map<number, number>();
  const sortedByIdAsc = [...segments.values()].sort((a, b) => a.id - b.id); // parents before children
  for (const s of sortedByIdAsc) {
    const len = Math.max(0.01, distance(s.start, s.end));
    const meanRadius = (s.baseRadius + s.tipRadius) / 2;
    const area = Math.PI * meanRadius * meanRadius;
    const ownResistance = len / area;
    const parentResistance = s.parentId !== null ? resistanceCache.get(s.parentId) ?? 0 : 0;
    const total = parentResistance + ownResistance;
    resistanceCache.set(s.id, total);
    segments.get(s.id)!.hydraulicResistance = total;
  }
}
