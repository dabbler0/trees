import type { BranchSegment } from '../model/types';
import type { Vec3 } from '../model/vec3';

/**
 * Below-ground root-space competition: the below-ground counterpart of
 * light.ts's shadow-casting canopy competition, isotropic instead of
 * directional (soil moisture/nutrients don't have a "sun side" -- a
 * competing root a meter to the north contests the same shared soil
 * volume exactly as much as one a meter to the south), and built the same
 * way structurally: bin every living tree's absorptive root area
 * (BranchSegment.leafArea, repurposed for kind === 'root' segments -- see
 * its own field doc) into a shared horizontal grid, then let each query
 * point read off how much of the locally shared resource is already
 * spoken for by *other* trees' roots occupying the same soil patch.
 *
 * Real root systems compete for a shared, finite pool of soil moisture
 * and nutrients wherever they physically overlap (this is Brouwer's
 * functional-equilibrium/resource-competition picture from the same
 * literature cited for rootCarbonAllocationFraction) -- a tree whose
 * roots are heavily contested by close neighbors gets less of that pool
 * per unit of its own root length than one growing in open soil, which
 * throttles its below-ground vigor (and, via a modest whole-tree
 * carbon-supply penalty applied in the forest growth loop, its overall
 * growth) the same real, gradual way canopy shading throttles a shaded
 * bud rather than killing it outright.
 *
 * Deliberately reuses the exact same Beer-Lambert-style extinction shape
 * as light.ts's own self-shading (`exp(-k * density)`) rather than a
 * hard-capacity threshold: with a fixed absolute "carrying capacity per
 * cell" a lone tree's own root density would need to be calibrated
 * *against* that constant to guarantee it never self-throttles, which is
 * exactly the kind of magic-number tuning the codebase otherwise avoids.
 * Excluding a tree's own contribution when computing the density it
 * itself experiences (see factorAt's ownTreeId parameter) instead makes a
 * lone tree's factor *always* exactly 1 regardless of how dense its own
 * root system is or how the constant below is tuned -- competition can
 * only ever come from *other* trees' roots sharing the same soil patch,
 * matching this feature's "a lone tree grows exactly as before" contract
 * the same way stepYear's own external-inputs default does.
 */
export interface RootResourceProfile {
  /** In (0, 1] -- the fraction of the locally-contested soil resource a
   * root belonging to `ownTreeId` gets to keep at this world position,
   * given every *other* living tree's combined root demand sharing the
   * same soil patch. 1 = uncontested. */
  factorAt(position: Vec3, ownTreeId: number): number;
}

/** Horizontal grid cell size, meters -- deliberately coarser than light's
 * own COLUMN_SIZE: real fine-root competition zones (the scale at which
 * two trees' root systems meaningfully contest the same soil volume)
 * span a good deal more than a single canopy self-shading column. */
const ROOT_CELL_SIZE = 2;

/** How strongly one unit of *other* trees' root-area density (area per
 * cell area, the same dimensionless-density shape as light's own LAI)
 * depletes this tree's own local share. Deliberately gentler than
 * lightExtinctionCoefficient's typical range: real below-ground
 * competition for a diffuse, partially-replenished resource (soil
 * moisture, nutrients) is generally less starkly all-or-nothing than
 * direct light interception, so this saturates more slowly -- a
 * moderately-overlapping neighbor measurably throttles growth without a
 * densely packed one crushing it to zero. */
const ROOT_COMPETITION_COEFFICIENT = 1.2;

interface RootAreaSource {
  treeId: number;
  x: number;
  z: number;
  area: number;
}

function cellKey(x: number, z: number): string {
  return `${Math.floor(x / ROOT_CELL_SIZE)},${Math.floor(z / ROOT_CELL_SIZE)}`;
}

export function buildRootResourceProfile(
  trees: readonly { id: number; segments: readonly BranchSegment[]; offset: readonly [number, number] }[]
): RootResourceProfile {
  const cellTotals = new Map<string, Map<number, number>>(); // cellKey -> treeId -> absorptive area

  for (const t of trees) {
    for (const s of t.segments) {
      if (s.kind !== 'root' || s.leafArea <= 0) continue;
      const source: RootAreaSource = {
        treeId: t.id,
        x: (s.start[0] + s.end[0]) / 2 + t.offset[0],
        z: (s.start[2] + s.end[2]) / 2 + t.offset[1],
        area: s.leafArea,
      };
      const key = cellKey(source.x, source.z);
      let byTree = cellTotals.get(key);
      if (!byTree) {
        byTree = new Map();
        cellTotals.set(key, byTree);
      }
      byTree.set(t.id, (byTree.get(t.id) ?? 0) + source.area);
    }
  }

  const cellArea = ROOT_CELL_SIZE * ROOT_CELL_SIZE;

  return {
    factorAt(position: Vec3, ownTreeId: number): number {
      const byTree = cellTotals.get(cellKey(position[0], position[2]));
      if (!byTree) return 1;
      let competingArea = 0;
      for (const [treeId, area] of byTree) {
        if (treeId !== ownTreeId) competingArea += area;
      }
      if (competingArea <= 0) return 1;
      const density = competingArea / cellArea;
      return Math.exp(-ROOT_COMPETITION_COEFFICIENT * density);
    },
  };
}
