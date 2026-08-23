import type { BranchSegment, SimulationParams } from '../model/types';
import { cross, dot, normalize, arbitraryOrthogonal, type Vec3 } from '../model/vec3';
import { sunDirection } from './sun';

/**
 * A real shadow-casting light model: exposure at any point is how much
 * leaf area lies between it and the sky along a handful of sample
 * directions, not a height-only heuristic. This replaces the earlier
 * "bin into horizontal layers, assume a uniform circular footprint"
 * approximation with something that:
 *
 *  - actually uses the sun's direction for its direct-beam component (a
 *    low, oblique sun casts long, consistently-angled shadows; an
 *    overhead sun casts short, mostly straight-down ones), instead of
 *    only ever measuring cumulative leaf area strictly above a height;
 *  - resolves shading in the two axes perpendicular to each sample
 *    direction as well as depth along it, instead of averaging every
 *    point at a given height together;
 *  - is a natural home for future obstructions/competition (another
 *    tree, a building, terrain): anything that can contribute
 *    `{ position, area }` entries to the same shadow-casting index would
 *    just as well occlude light, with no change to how a query works.
 *
 * The technique is a shadow map from real-time rendering: project every
 * leaf-bearing point into a 2D grid of "columns" perpendicular to a
 * light direction, sort each column by depth along that direction, and
 * prefix-sum so any query point can binary-search for how much leaf area
 * sits between it and the light in its own column. Building one
 * direction's index is O(n log n) in the number of leaf-bearing
 * segments; each query is O(log n) into its column.
 *
 * A single direction (straight at the sun) turns out to badly
 * under-shade a real, laterally-spreading broadleaf crown: a bud near
 * the trunk has almost nothing from a *wide* canopy directly in its own
 * narrow overhead column, even though in reality it sits under a dense
 * dome of foliage occluding most of the sky. Real canopy photosynthesis
 * is driven by total intercepted photosynthetically-active radiation,
 * which arrives from the *whole* sky hemisphere -- a mix of the direct
 * solar beam plus diffuse skylight scattered from every other direction
 * (the same reasoning behind hemispherical-photography/gap-fraction LAI
 * instruments used in real forestry, which look at the whole sky, not
 * just the sun's disc). So exposure here is a weighted blend of shadow
 * maps built along several fixed directions spanning the upper
 * hemisphere (the "diffuse sky" component, most of the weight) plus one
 * more built along the actual sun direction (the "direct beam"
 * component, which is what makes the sun-angle parameter visibly steer
 * shading/heliotropism). Each direction keeps the same Beer-Lambert
 * extinction law (`exposure = exp(-k * LAI)`) standard in forest canopy
 * models; the final exposure is their weighted average.
 */
export interface LightProfile {
  exposureAt(position: Vec3): number;
}

/** Side length of one shadow-map column, meters -- also used as the
 * column's cross-sectional area (columnSize^2) when converting
 * accumulated leaf area into an areal density (LAI-like quantity) for
 * the Beer-Lambert exponent. Coarse relative to a single leaf: it's
 * meant to catch canopy-scale overlap (one branch's foliage shading
 * another a meter or two over), not resolve individual leaves. */
const COLUMN_SIZE = 1.5;

/** How much of total exposure weight goes to the direct solar beam
 * (the one direction that actually moves with sunZenithAngle/sunAzimuth)
 * vs. the fixed diffuse-sky hemisphere below. Real clear-sky PAR is
 * mostly direct beam; real overcast-sky PAR is almost all diffuse. This
 * sits in between so the sun angle has a real, visible effect without
 * making the diffuse "ambient occlusion" component (the thing that
 * actually gives a wide broadleaf crown believable interior self-shading)
 * negligible. */
const DIRECT_BEAM_WEIGHT = 0.35;

/**
 * A small, fixed set of unit directions spanning the upper hemisphere,
 * used as the diffuse-sky component. Deliberately independent of the
 * sun's position -- it represents the whole sky dome scattering light
 * from every direction, not the sun itself. One straight up (the sky's
 * zenith) plus a ring at a moderate zenith angle spread evenly in
 * azimuth, so a shading mass off to any side still casts some diffuse
 * shadow instead of only ever being "not overhead, so irrelevant".
 */
function diffuseSkyDirections(): Vec3[] {
  const dirs: Vec3[] = [[0, 1, 0]];
  const ringZenith = (55 * Math.PI) / 180;
  const ringCount = 6;
  const sinZ = Math.sin(ringZenith);
  const cosZ = Math.cos(ringZenith);
  for (let i = 0; i < ringCount; i++) {
    const az = (2 * Math.PI * i) / ringCount;
    dirs.push([sinZ * Math.cos(az), cosZ, sinZ * Math.sin(az)]);
  }
  return dirs;
}

const DIFFUSE_DIRECTIONS = diffuseSkyDirections();

interface ShadingSource {
  position: Vec3;
  area: number;
}

interface Column {
  /** Depths (along the sample direction), descending -- index 0 is closest to the light. */
  depths: Float64Array;
  /** Prefix sum of area strictly before each index, i.e. prefixArea[i] = sum of area for depths[0..i-1].
   * Length is depths.length + 1: the extra trailing slot holds the sum of
   * the whole column, so a query point behind every entry (lo === depths.length)
   * still has a valid, correct total to read. */
  prefixArea: Float64Array;
}

interface DirectionalIndex {
  right: Vec3;
  up: Vec3;
  dir: Vec3;
  columns: Map<string, Column>;
}

/**
 * Builds the shadow-casting index for one sample direction (or, in the
 * future, a tree plus whatever else should cast shade on it). Exposed
 * separately from buildLightProfile so obstruction sources can later be
 * merged into the same `sources` list before indexing.
 */
function buildColumnIndex(sources: readonly ShadingSource[], dir: Vec3): DirectionalIndex {
  const right = arbitraryOrthogonal(dir);
  const up = normalize(cross(dir, right));

  const byColumn = new Map<string, { depth: number; area: number }[]>();
  for (const src of sources) {
    const su = Math.floor(dot(src.position, right) / COLUMN_SIZE);
    const sv = Math.floor(dot(src.position, up) / COLUMN_SIZE);
    const key = `${su},${sv}`;
    const depth = dot(src.position, dir);
    let list = byColumn.get(key);
    if (!list) {
      list = [];
      byColumn.set(key, list);
    }
    list.push({ depth, area: src.area });
  }

  const columns = new Map<string, Column>();
  for (const [key, entries] of byColumn) {
    entries.sort((a, b) => b.depth - a.depth); // closest to the light first
    const depths = new Float64Array(entries.length);
    const prefixArea = new Float64Array(entries.length + 1);
    let running = 0;
    for (let i = 0; i < entries.length; i++) {
      depths[i] = entries[i].depth;
      prefixArea[i] = running;
      running += entries[i].area;
    }
    prefixArea[entries.length] = running; // total, for queries behind every entry
    columns.set(key, { depths, prefixArea });
  }

  return { right, up, dir, columns };
}

/** How much shading area lies strictly between `position` and the light,
 * within its own column, for one directional index. */
function shadowingAreaAt(index: DirectionalIndex, position: Vec3): number {
  const su = Math.floor(dot(position, index.right) / COLUMN_SIZE);
  const sv = Math.floor(dot(position, index.up) / COLUMN_SIZE);
  const column = index.columns.get(`${su},${sv}`);
  if (!column || column.depths.length === 0) return 0;

  const depth = dot(position, index.dir);
  // Binary search for the first entry with depth <= this point's depth --
  // everything before that index is strictly closer to the light (i.e.
  // between the light and this point).
  const { depths, prefixArea } = column;
  let lo = 0;
  let hi = depths.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (depths[mid] > depth) lo = mid + 1;
    else hi = mid;
  }
  return prefixArea[lo]; // lo may equal depths.length; prefixArea has one extra trailing "total" slot for that case
}

export function buildLightProfile(segments: readonly BranchSegment[], params: SimulationParams): LightProfile {
  const sunDir = sunDirection(params);

  const sources: ShadingSource[] = [];
  for (const s of segments) {
    if (s.leafArea <= 0) continue;
    sources.push({
      position: [(s.start[0] + s.end[0]) / 2, (s.start[1] + s.end[1]) / 2, (s.start[2] + s.end[2]) / 2],
      area: s.leafArea,
    });
  }

  const directIndex = buildColumnIndex(sources, sunDir);
  const diffuseIndices = DIFFUSE_DIRECTIONS.map((dir) => buildColumnIndex(sources, dir));
  const diffuseWeight = (1 - DIRECT_BEAM_WEIGHT) / diffuseIndices.length;

  const k = params.lightExtinctionCoefficient;
  const columnArea = COLUMN_SIZE * COLUMN_SIZE;
  const transmittance = (index: DirectionalIndex, position: Vec3): number => {
    const lai = shadowingAreaAt(index, position) / columnArea;
    return Math.exp(-k * lai);
  };

  return {
    exposureAt(position: Vec3) {
      let exposure = DIRECT_BEAM_WEIGHT * transmittance(directIndex, position);
      for (const index of diffuseIndices) {
        exposure += diffuseWeight * transmittance(index, position);
      }
      return exposure;
    },
  };
}
