import type { BranchSegment, SimulationParams } from '../model/types';
import { distance } from '../model/vec3';

const MIN_TWIG_RADIUS = 0.0025; // 2.5mm floor, roughly a current-year twig
const GRAVITY = 9.81; // m/s^2

/**
 * Real wood/loading constants behind the mechanical-support floors below.
 * These are representative figures for green (living, full-moisture)
 * temperate hardwood, per the USDA Forest Products Laboratory's *Wood
 * Handbook: Wood as an Engineering Material* (the standard engineering
 * reference for wood mechanical properties) -- e.g. its green-condition
 * tables give red oak MOE ~11.3 GPa / MOR ~63 MPa / wet density
 * ~950-1000 kg/m^3, sugar maple MOE ~10.7 GPa / MOR ~65 MPa, and
 * yellow-poplar (a lighter wood) MOE ~8.1 GPa / MOR ~46 MPa. These
 * constants sit in the middle of that real range as one representative
 * "typical broadleaf" species rather than any single one.
 */
const GREEN_WOOD_DENSITY = 900; // kg/m^3
const GREEN_WOOD_MOE = 1.0e10; // Pa, modulus of elasticity along the grain
const GREEN_WOOD_MOR = 5.5e7; // Pa, modulus of rupture (bending strength)
/** Fresh (turgid) leaf mass per unit leaf area -- broadleaf specific leaf
 * area/mass literature commonly reports leaf dry mass per area around
 * 40-120 g/m^2, and fresh (living) leaves are roughly 50-60% water by
 * mass, putting fresh mass per area in the ~100-250 g/m^2 range; this
 * uses a middle-of-that-range figure. Leaf weight matters little next to
 * wood for anything but the thinnest twigs, but it's real load and easy
 * to include. */
const LEAF_FRESH_MASS_PER_AREA = 0.15; // kg/m^2

/**
 * Real trees don't grow right up against their ultimate failure stress --
 * they carry a working safety margin against occasional extreme loading
 * (storm wind, ice, snow) on top of ordinary static self-weight, which is
 * all this model actually simulates. Tree-biomechanics surveys of safety
 * factors in woody plant structures (e.g. Niklas 1992, *Plant
 * Biomechanics*) commonly report values roughly in the 3-6 range for
 * static loading; 4 is used here as a representative, round figure, and
 * also stands in for the extra margin a real tree needs for the dynamic
 * wind loading this simplified model doesn't otherwise account for.
 */
const STRUCTURAL_SAFETY_FACTOR = 4;
const ALLOWABLE_BENDING_STRESS = GREEN_WOOD_MOR / STRUCTURAL_SAFETY_FACTOR; // Pa

/**
 * Greenhill's (1881) critical self-buckling height for a freestanding,
 * tapered column under its own weight: H_crit = C * (E/(rho*g))^(1/3) *
 * D^(2/3), with C ~ 0.79 for the standard tapered/self-loaded case. This
 * is the real basis for McMahon's (1973, "Size and shape in biology",
 * Science 179) widely-cited "elastic similarity" scaling law that real
 * tree trunks approximately follow, D ~ H^1.5 -- exactly the form
 * mechanicalFloor already used, just previously with an arbitrary tuned
 * coefficient instead of one derived from real wood properties. Solving
 * for the diameter at which a column of height H sits a factor S below
 * its buckling threshold (H_crit = S*H):
 *
 *   D = (S/C)^1.5 * H^1.5 * sqrt(rho*g/E)
 *
 * so the D~H^1.5 coefficient itself is (S/C)^1.5 * sqrt(rho*g/E); halved
 * for radius.
 */
const GREENHILL_C = 0.79;
const GREENHILL_RADIUS_COEFFICIENT =
  (Math.pow(STRUCTURAL_SAFETY_FACTOR / GREENHILL_C, 1.5) * Math.sqrt((GREEN_WOOD_DENSITY * GRAVITY) / GREEN_WOOD_MOE)) / 2;

/**
 * Root anchorage against wind-overturning: a real, if necessarily
 * simplified, mechanical check distinct from buckling/bending, both of
 * which are about a piece of wood bending/crushing under load, not about
 * the whole tree tipping over. Standard tree-risk-assessment models
 * (e.g. Peltola 2006, "Mechanical stability of trees under static loads
 * and dynamic wind loading," *American Journal of Botany* 93) compute a
 * wind-drag overturning moment on the crown and compare it to the root
 * system's critical turning-resistance moment. This implementation:
 *  - Wind force via the standard drag equation, F = 0.5 * rho_air * Cd *
 *    A_frontal * v^2, using real air density (1.225 kg/m^3, ISA sea
 *    level) and a representative *reconfigured* (streamlined-in-wind)
 *    foliage drag coefficient -- real broadleaf crowns reduce their own
 *    drag substantially by reconfiguring/curling in strong wind (Vogel
 *    1989, "Drag and reconfiguration of broad leaves in high winds,"
 *    *Journal of Experimental Botany* 40), well below a flat plate's
 *    ~1.2, hence the lower figure here.
 *  - A representative "ordinary storm" design wind speed rather than a
 *    rare extreme event: 20 m/s is a strong gale (Beaufort force 9).
 *  - Root-soil anchorage resistance approximated as (total root
 *    cross-section at the collar) * (root system spread, the resisting
 *    lever arm) * (a root-soil grip stress). Real root-plate anchorage
 *    capacity is highly soil- and root-architecture-dependent (Coutts
 *    1983's classic root-plate model; Peltola et al.'s ForestGALES
 *    critical-turning-moment framework) -- unlike the wood constants
 *    above, which come from one consistent, precisely tabulated
 *    engineering reference, SOIL_GRIP_STRESS is a single illustrative,
 *    order-of-magnitude figure standing in for that real variability,
 *    not a specific measured constant.
 */
const AIR_DENSITY = 1.225; // kg/m^3, ISA sea-level
const CROWN_DRAG_COEFFICIENT = 0.4;
const DESIGN_WIND_SPEED = 12; // m/s, ~ Beaufort force 6 "strong breeze" -- an ordinary
// recurring design load, rather than a rare severe-storm event a tree isn't
// expected to survive fully undamaged every single year of its life
const SOIL_GRIP_STRESS = 5.0e5; // Pa, illustrative root-soil anchorage figure (a firm/compacted soil)

interface SubtreeLoads {
  mass: Map<number, number>; // kg
  momentX: Map<number, number>; // kg*m (mass-weighted sum of x position)
  momentZ: Map<number, number>;
  maxHeight: Map<number, number>; // m, highest point anywhere in this segment's own subtree
}

/**
 * Bottom-up (children before parents) accumulation of each segment's own
 * subtree's total mass, mass-weighted horizontal position (for a real
 * center-of-mass lever arm, not just "farthest point"), and maximum
 * height. Shared between the growth-time thickening pass below and
 * computeMechanicalStressReport, which independently checks the
 * *outcome* of that pass against real load-bearing physics (tests/
 * allometry.test.ts) -- both need exactly the same "how much is actually
 * hanging off this point, and how high does this point's own subtree
 * reach" facts about the tree.
 */
function computeSubtreeLoads(segments: readonly BranchSegment[]): SubtreeLoads {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const ordered = [...segments].sort((a, b) => b.id - a.id); // children (higher id) before parents

  const mass = new Map<number, number>();
  const momentX = new Map<number, number>();
  const momentZ = new Map<number, number>();
  const maxHeight = new Map<number, number>();
  for (const s of ordered) {
    const len = distance(s.start, s.end);
    const ownVolume = ((Math.PI * len) / 3) * (s.baseRadius * s.baseRadius + s.baseRadius * s.tipRadius + s.tipRadius * s.tipRadius);
    const ownMass = GREEN_WOOD_DENSITY * ownVolume + LEAF_FRESH_MASS_PER_AREA * s.leafArea;
    const midX = (s.start[0] + s.end[0]) / 2;
    const midZ = (s.start[2] + s.end[2]) / 2;

    let m = ownMass;
    let mx = ownMass * midX;
    let mz = ownMass * midZ;
    let h = s.end[1];
    for (const cid of s.childIds) {
      const child = byId.get(cid);
      // A root child's mass is soil-supported, not hanging off this
      // point -- only relevant at the shared root-collar segment (id 0),
      // which parents both the shoot system and the root system. Folding
      // root mass into the collar's own cantilever/buckling load here
      // would double-count weight the ground already carries directly,
      // as if the trunk needed extra wood to hold its own roots up.
      // (Root segments' own required thickness comes from a separate
      // anchorage calculation below, not from subtree mass at all.)
      if (!child || child.kind === 'root') continue;
      m += mass.get(cid) ?? 0;
      mx += momentX.get(cid) ?? 0;
      mz += momentZ.get(cid) ?? 0;
      h = Math.max(h, maxHeight.get(cid) ?? s.end[1]);
    }
    mass.set(s.id, m);
    momentX.set(s.id, mx);
    momentZ.set(s.id, mz);
    maxHeight.set(s.id, h);
  }
  return { mass, momentX, momentZ, maxHeight };
}

/** The horizontal distance from an arbitrary reference point (a
 * segment's own base, or its tip -- see call sites) to its subtree's
 * mass centroid -- the real cantilever lever arm for bending, and the
 * resulting bending moment (N*m) from that subtree's total weight.
 * Parameterized on the reference point rather than always using the
 * segment's base: the mechanical requirement genuinely varies along a
 * segment's own length (less height/mass remains above the tip than
 * above the base), and both applyPipeModelAndMechanics and
 * computeMechanicalStressReport need the base-anchored figure, while
 * applyPipeModelAndMechanics also needs the tip-anchored one -- see the
 * comment above the tip-floor code below for why. */
function bendingMoment(refPoint: readonly [number, number, number], s: BranchSegment, loads: SubtreeLoads): number {
  const mass = loads.mass.get(s.id) ?? 0;
  if (mass <= 0) return 0;
  const centroidX = (loads.momentX.get(s.id) ?? 0) / mass;
  const centroidZ = (loads.momentZ.get(s.id) ?? 0) / mass;
  const leverArm = Math.hypot(centroidX - refPoint[0], centroidZ - refPoint[2]);
  return mass * GRAVITY * leverArm;
}

export interface MechanicalStress {
  /** Actual bending stress (Pa) at this segment's base from its own
   * subtree's real weight and lever arm, using its *actual* radius. */
  bendingStressPa: number;
  /** This segment's own subtree height above its base, divided by the
   * Greenhill critical buckling height implied by its *actual* radius --
   * i.e. how close to elastic self-buckling it actually sits. Well under
   * 1 means a comfortable margin; approaching or past 1 means it's at or
   * beyond real theoretical buckling risk. */
  bucklingHeightRatio: number;
}

/**
 * Independently re-derives, from each segment's *actual* (already grown)
 * radius and real geometry/mass, how much mechanical stress it's actually
 * under -- the basis for tests/allometry.test.ts's real-numbers structural
 * sanity checks. This deliberately checks the *outcome* against real
 * physics rather than re-deriving what applyPipeModelAndMechanics would
 * have required: pipe-model demand or an ancestor/descendant's own floor
 * can independently push a radius above the bare mechanical minimum, and
 * floors only ever round radii *up* to an integer-ish accumulation of
 * per-year growth, so this is a genuine (if coarse) check that the
 * finished structure actually holds together, not a tautological replay
 * of the same formula.
 */
export function computeMechanicalStressReport(segments: readonly BranchSegment[]): Map<number, MechanicalStress> {
  const loads = computeSubtreeLoads(segments);
  const report = new Map<number, MechanicalStress>();
  for (const s of segments) {
    const moment = bendingMoment(s.start, s, loads);
    const bendingStressPa = moment > 0 ? (4 * moment) / (Math.PI * Math.pow(s.baseRadius, 3)) : 0;

    const heightAboveBase = Math.max(0, (loads.maxHeight.get(s.id) ?? s.end[1]) - s.start[1]);
    // Invert Greenhill for the critical height implied by this segment's
    // *actual* radius (D = 2*baseRadius): H_crit = C*(E/(rho*g))^(1/3)*D^(2/3).
    const criticalHeight =
      GREENHILL_C * Math.pow(GREEN_WOOD_MOE / (GREEN_WOOD_DENSITY * GRAVITY), 1 / 3) * Math.pow(2 * s.baseRadius, 2 / 3);
    const bucklingHeightRatio = criticalHeight > 0 ? heightAboveBase / criticalHeight : 0;

    report.set(s.id, { bendingStressPa, bucklingHeightRatio });
  }
  return report;
}

/**
 * The whole-tree wind-overturning requirement (see the constants' own
 * comment above): a real crown-geometry-driven overturning moment, and
 * the total root cross-section at the collar a real root-soil anchorage
 * model says is needed to resist it with a safety margin. Pulled out as
 * its own pure function of segment geometry (no `params` dependency --
 * mechanicalThickeningFactor is applied by each call site) so
 * applyPipeModelAndMechanics and computeAnchorageReport share the exact
 * same requirement calculation.
 */
function computeOverturnRequirement(segments: readonly BranchSegment[]): { requiredTotalRootCrossSection: number; rootSpread: number } {
  let crownRadius = 0;
  let crownTop = 0;
  let crownBaseHeight = Infinity;
  let rootSpread = 0;
  for (const s of segments) {
    if (s.kind === 'root') {
      rootSpread = Math.max(rootSpread, Math.hypot(s.end[0], s.end[2]));
      continue;
    }
    if (s.leafArea <= 0) continue;
    crownRadius = Math.max(crownRadius, Math.hypot(s.end[0], s.end[2]));
    crownTop = Math.max(crownTop, s.end[1], s.start[1]);
    crownBaseHeight = Math.min(crownBaseHeight, s.start[1]);
  }
  // No artificial minimum here (unlike the lever-arm floor below): a
  // young tree's real canopy depth genuinely is small, giving a small
  // real frontal area and a small real wind load -- self-consistent, not
  // a hazard the way dividing by rootSpread is. An earlier version
  // floored this at 0.5m regardless of actual crown size, manufacturing
  // a nontrivial wind-load requirement even for a bare seedling with a
  // literal point of canopy, whose resulting mechanical floor -- being
  // permanent, since radius never shrinks -- persisted as a large,
  // unjustified head start on total root volume for the rest of the
  // tree's life.
  const canopyDepth = Number.isFinite(crownBaseHeight) ? Math.max(0, crownTop - crownBaseHeight) : 0;
  const frontalArea = crownRadius * 2 * canopyDepth * 0.5;
  const leverArmHeight = Number.isFinite(crownBaseHeight) ? Math.max(0, (crownBaseHeight + crownTop) / 2) : 0;
  const windForce = 0.5 * AIR_DENSITY * CROWN_DRAG_COEFFICIENT * frontalArea * DESIGN_WIND_SPEED * DESIGN_WIND_SPEED;
  const overturnMoment = windForce * leverArmHeight;
  // A floor on the resisting lever arm, not just a >0 guard: a real root
  // system's resistance doesn't come *only* from the horizontal reach of
  // its longest root, and dividing by the tree's *actual* current spread
  // directly is a real numerical hazard here in a way it isn't for
  // buckling/bending -- a young tree's roots start every simulation at
  // literally zero spread (right at the collar) and grow outward
  // gradually, same as the crown does, but crown geometry only ever
  // *multiplies* into the moment (a small young crown -> a small real
  // wind load, self-consistently), while an undefended spread here sits
  // in the *denominator*: a tiny spread would demand an enormous
  // cross-section to compensate for its short lever arm, which would
  // then cost an enormous respiration bill, starving the very elongation
  // that would otherwise grow the spread out of the danger zone --
  // a runaway feedback loop with no natural exit once triggered. Real
  // young trees are never actually in this position (a sapling's crown
  // is proportionately just as small as its root spread, so the real
  // wind load it must resist is tiny too); the floor keeps this model's
  // simplified fixed-formula version from manufacturing a crisis a real
  // tree never actually faces.
  const MIN_ANCHORAGE_LEVER_ARM = 0.3; // m
  const effectiveRootSpread = Math.max(rootSpread, MIN_ANCHORAGE_LEVER_ARM);
  const requiredTotalRootCrossSection = (overturnMoment * STRUCTURAL_SAFETY_FACTOR) / (effectiveRootSpread * SOIL_GRIP_STRESS);
  return { requiredTotalRootCrossSection, rootSpread };
}

export interface AnchorageReport {
  /** Total cross-sectional area (m^2) a real wind-overturning-resistance
   * model says the root system needs at the collar, with a structural
   * safety margin already applied. */
  requiredRootCrossSectionM2: number;
  /** The root system's *actual* combined cross-sectional area (m^2) at
   * the collar, from each main root's actually-grown radius -- an
   * independent measurement, not a replay of the growth-time formula
   * (see computeMechanicalStressReport's own comment for why that
   * distinction matters for a real test). */
  actualRootCrossSectionM2: number;
}

/** Non-tautological anchorage check for tests/roots.test.ts: independently
 * re-measures the root system's actual grown cross-section at the collar
 * against the real wind-overturning requirement. */
export function computeAnchorageReport(segments: readonly BranchSegment[]): AnchorageReport {
  const { requiredTotalRootCrossSection } = computeOverturnRequirement(segments);
  let actualRootCrossSectionM2 = 0;
  for (const s of segments) {
    if (s.kind === 'root' && s.parentId === 0) actualRootCrossSectionM2 += Math.PI * s.baseRadius * s.baseRadius;
  }
  return { requiredRootCrossSectionM2: requiredTotalRootCrossSection, actualRootCrossSectionM2 };
}

export const MECHANICAL_CONSTANTS = {
  GREEN_WOOD_DENSITY,
  GREEN_WOOD_MOE,
  GREEN_WOOD_MOR,
  LEAF_FRESH_MASS_PER_AREA,
  STRUCTURAL_SAFETY_FACTOR,
  ALLOWABLE_BENDING_STRESS,
  GREENHILL_C,
  AIR_DENSITY,
  CROWN_DRAG_COEFFICIENT,
  DESIGN_WIND_SPEED,
  SOIL_GRIP_STRESS,
};

/**
 * Secondary growth ("thickening") pass, applied once per simulated year
 * after this year's elongation/branching decisions are final.
 *
 * Three biologically/physically-motivated mechanisms, combined by taking
 * whichever demands more wood (radius can only ever grow, matching real
 * cambial growth):
 *
 *  1. Pipe model theory (Shinozaki et al. 1964) / Leonardo da Vinci's
 *     branching rule: the sapwood cross-sectional area at any point must
 *     be enough to supply every unit of leaf area distal to it, and the
 *     cross-section is conserved across a branching point (sum of
 *     children's basal area ~= parent's cross-section just below them).
 *     We implement this as a bottom-up accumulation of "area demand" over
 *     the branch graph.
 *
 *  2. Mechanical self-support against buckling: a free-standing,
 *     roughly-vertical column needs disproportionately more radius as
 *     the height overhead grows, well past what photosynthetic pipe-model
 *     demand alone would require -- Greenhill's real critical-buckling
 *     formula above, scaled by how much height *this segment's own
 *     subtree* actually reaches above it (not a fixed "trunk" axis). Any
 *     segment that a lot of the tree's height still depends on gets a
 *     strong floor, whether it's the original leader or a co-dominant
 *     fork, from the same formula.
 *
 *  3. Mechanical self-support against bending: a laterally-extending
 *     branch's dominant failure mode isn't buckling (that's a
 *     roughly-vertical-column phenomenon) but bending under the
 *     cantilevered weight of its own distal subtree -- real physics
 *     (beam bending stress sigma = M*c/I = 4M/(pi*r^3) for a solid
 *     circular cross-section) applied to the actual mass (wood + foliage)
 *     and horizontal lever arm (from this segment's own base to its
 *     subtree's mass centroid, not just its farthest tip, so one distant
 *     outlying twig doesn't dominate the estimate) hanging off each
 *     segment. This is what makes lateral branches -- which the
 *     buckling floor above barely constrains, since their own subtree
 *     rarely reaches much *height* above them -- thicken to match the
 *     real load they're cantilevering, not just whatever pipe-model
 *     leaf-area demand alone would give them.
 *
 * This function mutates baseRadius/tipRadius/hydraulicResistance in place
 * on the provided segments (which should already carry this year's
 * leafArea and the previous year's radii as a floor).
 */
export function applyPipeModelAndMechanics(segments: Map<number, BranchSegment>, params: SimulationParams): void {
  const ordered = [...segments.values()].sort((a, b) => b.id - a.id); // children (higher id) before parents
  const segmentById = segments;

  // Mass/lever-arm loads are computed from each segment's *incoming*
  // (last year's, pre-thickening) radius: this year's growth can only add
  // to what's already standing, so using the not-yet-updated radius here
  // avoids a circular "how thick it needs to be depends on how thick it
  // is" and just applies a one-year lag, same as the leafArea-driven pipe
  // demand below already does relative to the tree's still-previous-year
  // shape.
  const loads = computeSubtreeLoads(ordered);

  // Root anchorage against wind-overturning (see computeOverturnRequirement
  // and the constants' own comment above): a whole-tree property, computed
  // once per year rather than per segment, then applied below as an extra
  // floor along each *main* root's own direct lineage (order === 0 --
  // main roots keep order 0 for their own continuing axis exactly like a
  // shoot leader does, with order only ever incrementing on a lateral
  // branch), tapered smoothly to zero over ANCHORAGE_TAPER_LENGTH out
  // from the collar, rather than applied only at each main root's very
  // *base* and left completely unconstrained one internode further out.
  // That "only at the base" version is exactly the same thick-base/
  // vanishing-tip discontinuity the tip-continuity fix above exists to
  // prevent for buckling/bending, just for a floor that hadn't been
  // given the same treatment: an anchorage-sized main root could go from
  // tens of centimeters at its very base to ordinary twig thickness
  // within a single, often just centimeters-long, first internode -- and
  // every subsequent segment along that same lineage reverts fully to
  // whatever ordinary pipe-model/bending demand alone would give it, with
  // nothing bridging the two. Root real anchorage *does* taper away from
  // the trunk over a real, if modest, distance (real "root plate"
  // structural thickening), not within a single internode's length
  // regardless of how short that happens to be.
  //
  // Restricted to order === 0 specifically (not just "any root segment,
  // by its raw distance from the collar"): a real root plate's structural
  // thickening belongs to the handful of *main* roots themselves, not to
  // every fine lateral that happens to branch off one of them close to
  // the trunk. An earlier version keyed the taper on distance alone, so
  // a lateral branching off just centimeters from the collar inherited
  // almost the *full* anchorage requirement too, even though it wasn't
  // one of the tree's actual load-bearing main roots -- with potentially
  // thousands of such laterals within ANCHORAGE_TAPER_LENGTH of the
  // collar, this inflated total root volume far beyond anything real
  // (observed: over 95% of the whole tree's wood, when a real root
  // system commonly runs a small fraction of total biomass).
  const ANCHORAGE_TAPER_LENGTH = 1.5; // meters, an illustrative root-plate tapering distance
  const { requiredTotalRootCrossSection } = computeOverturnRequirement(ordered);
  const collarRootSegments = ordered.filter((s) => s.kind === 'root' && s.parentId === 0);
  const anchorageRadiusAtCollar =
    collarRootSegments.length > 0
      ? params.mechanicalThickeningFactor * Math.sqrt(requiredTotalRootCrossSection / collarRootSegments.length / Math.PI)
      : 0;
  // Cumulative path distance from the collar to each root segment's own
  // base and tip, walked parent-before-child (ascending id) so a
  // segment's own distance is always available before its children need
  // it.
  const rootDistanceFromCollarAtBase = new Map<number, number>();
  const rootDistanceFromCollarAtTip = new Map<number, number>();
  const rootsAscending = [...ordered].filter((s) => s.kind === 'root').sort((a, b) => a.id - b.id);
  for (const s of rootsAscending) {
    const baseDistance = s.parentId !== null ? (rootDistanceFromCollarAtTip.get(s.parentId) ?? 0) : 0;
    rootDistanceFromCollarAtBase.set(s.id, baseDistance);
    rootDistanceFromCollarAtTip.set(s.id, baseDistance + distance(s.start, s.end));
  }
  const anchorageRadiusAt = (distanceFromCollar: number): number =>
    anchorageRadiusAtCollar * Math.max(0, 1 - distanceFromCollar / ANCHORAGE_TAPER_LENGTH);

  // Sap-conducting cross-section is conserved through a branching point
  // (parent ~= sum of children) whether the branching is above ground
  // (a shoot splitting into laterals) or, at the shared root-collar
  // segment (id 0), below ground (the trunk's own base vs. its main
  // roots) -- but conserved, not summed on top of each other: the
  // collar's own demand must come *only* from its shoot subtree, the
  // same total that would apply if it had no roots at all, not shoot
  // demand plus root demand added together (which would double-count the
  // same continuous pipe network as if going up and going down each
  // needed their own separate supply). The `child.kind === s.kind` guard
  // is what keeps that separation: it only actually excludes anything at
  // the collar, since every other segment's children all share its own
  // kind already.
  const subtreeAreaDemand = new Map<number, number>();
  for (const s of ordered) {
    const ownDemand = params.pipeModelRatio * s.leafArea;
    let childDemand = 0;
    for (const cid of s.childIds) {
      const child = segmentById.get(cid);
      if (child && child.kind === s.kind) childDemand += subtreeAreaDemand.get(cid) ?? 0;
    }
    subtreeAreaDemand.set(s.id, ownDemand + childDemand);
  }

  for (const s of ordered) {
    const total = subtreeAreaDemand.get(s.id) ?? 0;
    let childDemand = 0;
    for (const cid of s.childIds) {
      const child = segmentById.get(cid);
      if (child && child.kind === s.kind) childDemand += subtreeAreaDemand.get(cid) ?? 0;
    }

    const pipeBaseRadius = Math.sqrt(total / Math.PI);
    const pipeTipRadius = s.childIds.length > 0 ? Math.sqrt(childDemand / Math.PI) : MIN_TWIG_RADIUS;

    const heightAboveBase = Math.max(0, (loads.maxHeight.get(s.id) ?? s.end[1]) - s.start[1]);
    const buckling = params.mechanicalThickeningFactor * GREENHILL_RADIUS_COEFFICIENT * Math.pow(heightAboveBase, 1.5);

    const moment = bendingMoment(s.start, s, loads);
    const bendingRadius = moment > 0 ? Math.pow((4 * moment) / (Math.PI * ALLOWABLE_BENDING_STRESS), 1 / 3) : 0;
    const bending = params.mechanicalThickeningFactor * bendingRadius;

    // Wind-overturning anchorage, tapered smoothly from its full value at
    // the collar (distance 0) to nothing by ANCHORAGE_TAPER_LENGTH out --
    // see the comment above anchorageRadiusAt.
    const anchorageBase = s.kind === 'root' && s.order === 0 ? anchorageRadiusAt(rootDistanceFromCollarAtBase.get(s.id) ?? 0) : 0;

    s.baseRadius = Math.max(s.baseRadius, pipeBaseRadius, buckling, bending, anchorageBase, MIN_TWIG_RADIUS);

    // The buckling/bending mechanical floors above are evaluated at this
    // segment's *base* -- but real trunk taper is continuous, not a
    // sawtooth that jumps back down at every single node. Without an
    // equivalent floor at the *tip*, a segment could satisfy its base
    // requirement (e.g. a big Greenhill floor from a tall subtree) while
    // its tip -- just a few centimeters higher, for a short-internode
    // species -- carries none of that requirement at all, since only
    // pipeTipRadius (pure leaf-area demand, no mechanical floor)
    // constrained it. That produces a physically nonsensical
    // thick-base/thin-tip discontinuity *within* every single segment,
    // repeated at every node -- harmless for a species with a few long
    // internodes (the discontinuity is a small fraction of the real
    // taper over that length), but for a species with many short ones
    // (dense, short-internode branching), the trunk is built from
    // hundreds of these sawtooth resets stacked on top of each other, so
    // *any* single height sampled along it -- including breast height,
    // where DBH is measured -- is likely to land near a tip and read as
    // dramatically thinner than the tree's real, physically-required
    // supporting cross-section at that height. Mirroring the same two
    // formulas at the tip (using the tip's own, smaller
    // height-still-above-it and its own lever arm) makes the floor -- and
    // so the taper -- continuous along the segment's length instead.
    const heightAboveTip = Math.max(0, (loads.maxHeight.get(s.id) ?? s.end[1]) - s.end[1]);
    const bucklingTip = params.mechanicalThickeningFactor * GREENHILL_RADIUS_COEFFICIENT * Math.pow(heightAboveTip, 1.5);
    const momentTip = bendingMoment(s.end, s, loads);
    const bendingTipRadius = momentTip > 0 ? Math.pow((4 * momentTip) / (Math.PI * ALLOWABLE_BENDING_STRESS), 1 / 3) : 0;
    const bendingTip = params.mechanicalThickeningFactor * bendingTipRadius;

    const anchorageTip = s.kind === 'root' && s.order === 0 ? anchorageRadiusAt(rootDistanceFromCollarAtTip.get(s.id) ?? 0) : 0;

    s.tipRadius = Math.max(Math.min(s.tipRadius, s.baseRadius), pipeTipRadius, bucklingTip, bendingTip, anchorageTip, MIN_TWIG_RADIUS);
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
