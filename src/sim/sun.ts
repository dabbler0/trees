import type { SimulationParams } from '../model/types';
import type { Vec3 } from '../model/vec3';

/**
 * Unit vector from the tree toward the sun, given the site's zenith/azimuth.
 * Shared by the light model (shadow-casting) and the growth engine
 * (heliotropic bending), both of which need the same direction.
 */
export function sunDirection(params: SimulationParams): Vec3 {
  const sinZ = Math.sin(params.sunZenithAngle);
  const cosZ = Math.cos(params.sunZenithAngle);
  return [sinZ * Math.cos(params.sunAzimuth), cosZ, sinZ * Math.sin(params.sunAzimuth)];
}
