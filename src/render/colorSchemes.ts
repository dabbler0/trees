import * as THREE from 'three';
import type { Bud, BranchSegment } from '../model/types';

/**
 * Color modes are kept as small, independent functions from
 * (segment, associated tip bud | undefined) -> THREE.Color so that adding
 * a new debug overlay (e.g. a future hormone signal) is a matter of
 * adding one function here and one entry in COLOR_MODES, with nothing
 * else in the renderer needing to change.
 */
export type ColorModeId = 'natural' | 'branchOrder' | 'age' | 'lightExposure' | 'hydraulicStress' | 'vigor' | 'photo';

export interface ColorModeContext {
  segment: BranchSegment;
  tipBud: Bud | undefined;
  currentYear: number;
  maxHydraulicResistance: number;
}

export interface ColorMode {
  id: ColorModeId;
  label: string;
  /** Short explanation shown in the UI legend. */
  description: string;
  color(ctx: ColorModeContext): THREE.Color;
}

const WOOD_COLOR = new THREE.Color('#7a5230');
const YOUNG_WOOD_COLOR = new THREE.Color('#9c7a4a');
const DEAD_WOOD_COLOR = new THREE.Color('#5a5450');

/** Blue (low) -> yellow -> red (high) heatmap for a value in [0, 1]. */
function heatmap(t: number): THREE.Color {
  const clamped = Math.max(0, Math.min(1, t));
  const c = new THREE.Color();
  c.setHSL(0.66 * (1 - clamped), 0.85, 0.5);
  return c;
}

export const COLOR_MODES: ColorMode[] = [
  {
    id: 'natural',
    label: 'Natural',
    description: 'Bark-brown wood, brighter for current growth; gray for dead/senesced wood.',
    color: ({ segment, currentYear }) => {
      if (!segment.alive) return DEAD_WOOD_COLOR.clone();
      const age = currentYear - segment.createdYear;
      return age <= 1 ? YOUNG_WOOD_COLOR.clone() : WOOD_COLOR.clone();
    },
  },
  {
    id: 'branchOrder',
    label: 'Branch order',
    description: 'Hue cycles by branch order (0 = trunk) so successive branching generations are easy to tell apart.',
    color: ({ segment }) => new THREE.Color().setHSL((segment.order * 0.13) % 1, 0.6, 0.5),
  },
  {
    id: 'age',
    label: 'Wood age',
    description: 'Heatmap of years since a segment formed: blue = brand new, red = oldest wood.',
    color: ({ segment, currentYear }) => {
      const age = currentYear - segment.createdYear;
      return heatmap(1 - Math.exp(-age / 20));
    },
  },
  {
    id: 'lightExposure',
    label: 'Light exposure',
    description: 'Beer-Lambert canopy light exposure reaching this segment (blue = shaded, red = full sun).',
    color: ({ segment }) => heatmap(segment.lightExposure),
  },
  {
    id: 'hydraulicStress',
    label: 'Hydraulic resistance',
    description: 'Cumulative path resistance from root to this segment (blue = low, red = high -- the hydraulic-limitation signal).',
    color: ({ segment, maxHydraulicResistance }) =>
      heatmap(maxHydraulicResistance > 0 ? segment.hydraulicResistance / maxHydraulicResistance : 0),
  },
  {
    id: 'vigor',
    label: 'Bud vigor (tips only)',
    description: 'Realized growth vigor of the bud currently at this segment\'s tip, if any (blue = starved, red = vigorous); gray elsewhere.',
    color: ({ tipBud }) => (tipBud ? heatmap(tipBud.vigor) : new THREE.Color('#888888')),
  },
  {
    id: 'photo',
    label: 'Photo',
    description:
      'Textured, leaf-shaped foliage casting real leaf-shaped shadows through the canopy (the debug renderer\'s attempt at a natural look), same bark coloring as Natural for the wood.',
    // Branches use the same coloring as 'natural'; the renderer swaps the
    // *leaf* geometry/material entirely for this mode (textured,
    // shadow-casting leaf sprites) rather than expressing it through this
    // per-segment color function, which only ever governs branch color.
    color: ({ segment, currentYear }) => {
      if (!segment.alive) return DEAD_WOOD_COLOR.clone();
      const age = currentYear - segment.createdYear;
      return age <= 1 ? YOUNG_WOOD_COLOR.clone() : WOOD_COLOR.clone();
    },
  },
];

export function getColorMode(id: ColorModeId): ColorMode {
  return COLOR_MODES.find((m) => m.id === id) ?? COLOR_MODES[0];
}
