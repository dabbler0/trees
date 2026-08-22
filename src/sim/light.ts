import type { BranchSegment, SimulationParams } from '../model/types';

/**
 * A cheap "big-leaf" Beer-Lambert canopy light model. Real canopy light
 * transport is a 3D ray-tracing problem; a full solution is not
 * computationally feasible for an interactive per-year growth step, so we
 * fall back to the standard forestry approximation: bin leaf area into
 * horizontal height layers, treat each layer as a uniform absorbing slab
 * over the tree's own crown footprint, and attenuate exponentially with
 * cumulative leaf-area-index (LAI) above each height.
 *
 * exposure(z) = exp(-k * LAI_above(z))
 *
 * This is exactly the light profile used in most gap-model / forest canopy
 * simulations (e.g. Beer-Lambert extinction with k ~ 0.3-0.7).
 */
export interface LightProfile {
  exposureAt(height: number): number;
}

const LAYER_THICKNESS = 0.5; // meters

export function buildLightProfile(
  segments: readonly BranchSegment[],
  params: SimulationParams
): LightProfile {
  let maxHeight = 0;
  let footprintRadius = 0.5; // avoid division by zero for very young saplings
  for (const s of segments) {
    maxHeight = Math.max(maxHeight, s.end[1], s.start[1]);
    const r = Math.hypot(s.end[0], s.end[2]);
    if (r > footprintRadius) footprintRadius = r;
  }
  const footprintArea = Math.PI * footprintRadius * footprintRadius;

  const layerCount = Math.max(1, Math.ceil(maxHeight / LAYER_THICKNESS) + 1);
  const layerLeafArea = new Float64Array(layerCount);

  for (const s of segments) {
    if (s.leafArea <= 0) continue;
    const midHeight = (s.start[1] + s.end[1]) / 2;
    const layer = Math.min(layerCount - 1, Math.max(0, Math.floor(midHeight / LAYER_THICKNESS)));
    layerLeafArea[layer] += s.leafArea;
  }

  // Cumulative LAI strictly above each layer (light reaching layer i has
  // already been filtered by every layer above it, not including itself).
  const cumulativeAbove = new Float64Array(layerCount);
  let running = 0;
  for (let i = layerCount - 1; i >= 0; i--) {
    cumulativeAbove[i] = running;
    running += layerLeafArea[i] / footprintArea;
  }

  const k = params.lightExtinctionCoefficient;
  return {
    exposureAt(height: number) {
      const layer = Math.min(layerCount - 1, Math.max(0, Math.floor(height / LAYER_THICKNESS)));
      const lai = cumulativeAbove[layer];
      return Math.exp(-k * lai);
    },
  };
}
