import type { SimulationParams } from './model/types';

/**
 * Declarative definitions for the "species & environment" sliders in the
 * UI. Each entry maps a single SimulationParams field to a slider whose
 * own numeric range may differ from the underlying param (e.g. an angle
 * shown in degrees but stored in radians, or a param best explored on a
 * log scale) -- toParam/toSlider convert between the two directions.
 *
 * Kept separate from main.ts so the curated list of "things worth
 * exposing" -- and the reasoning for each -- lives in one place.
 */
export interface ParamControlDef {
  key: keyof SimulationParams;
  label: string;
  description: string;
  group: 'environment' | 'species';
  min: number;
  max: number;
  step: number;
  toParam: (sliderValue: number) => number;
  toSlider: (paramValue: number) => number;
  format: (paramValue: number) => string;
}

const identity = (x: number): number => x;

function linear(
  key: keyof SimulationParams,
  label: string,
  description: string,
  group: ParamControlDef['group'],
  min: number,
  max: number,
  step: number,
  format: (v: number) => string
): ParamControlDef {
  return { key, label, description, group, min, max, step, toParam: identity, toSlider: identity, format };
}

/** A slider shown in degrees for a param stored in radians. */
function angleDeg(
  key: keyof SimulationParams,
  label: string,
  description: string,
  group: ParamControlDef['group'],
  minDeg: number,
  maxDeg: number,
  stepDeg: number
): ParamControlDef {
  return {
    key,
    label,
    description,
    group,
    min: minDeg,
    max: maxDeg,
    step: stepDeg,
    toParam: (deg) => (deg * Math.PI) / 180,
    toSlider: (rad) => (rad * 180) / Math.PI,
    format: (rad) => `${Math.round((rad * 180) / Math.PI)}°`,
  };
}

/** A slider that's linear in log10(param) -- for params whose effect is
 * more perceptually even across orders of magnitude than across a raw
 * linear range. */
function logScale(
  key: keyof SimulationParams,
  label: string,
  description: string,
  group: ParamControlDef['group'],
  min: number,
  max: number,
  step: number,
  format: (v: number) => string
): ParamControlDef {
  return {
    key,
    label,
    description,
    group,
    min: Math.log10(min),
    max: Math.log10(max),
    step,
    toParam: (log) => Math.pow(10, log),
    toSlider: (v) => Math.log10(v),
    format,
  };
}

export const PARAM_CONTROLS: ParamControlDef[] = [
  // --- Environment: site/season settings, not species traits ---
  angleDeg(
    'sunZenithAngle',
    'Sun angle (from overhead)',
    '0° = sun directly overhead (equatorial noon). Higher = a lower, more oblique sun (high latitude, or morning/evening light). Combined with heliotropism below, an oblique sun makes the canopy lean toward it.',
    'environment',
    0,
    80,
    5
  ),
  angleDeg(
    'sunAzimuth',
    'Sun direction (compass)',
    "Which horizontal direction the sun is in. Only visible when the sun angle above is > 0.",
    'environment',
    0,
    355,
    5
  ),
  linear(
    'heliotropismStrength',
    'Heliotropism (bending toward light)',
    'How strongly shaded shoots bend their growth toward the sun (capped so it always stays a lean, never overriding the tendency to grow upward). 0 = no directional bending at all -- the canopy stays radially symmetric even under a low sun.',
    'environment',
    0,
    1.2,
    0.1,
    (v) => v.toFixed(1)
  ),

  // --- Species traits: the sort of thing that differs between species ---
  linear(
    'heightVigorHalfHeight',
    'Hydraulic limit (mature height)',
    "Height (m) at which hydraulic limitation -- the increasing difficulty of supplying water against gravity as a shoot gets taller -- has cut both its growth vigor and its foliage's photosynthetic efficiency in half. The main knob for a species' asymptotic height: lower = a shorter, more hydraulically-limited species; higher = a taller one.",
    'species',
    3,
    40,
    1,
    (v) => `${v}m`
  ),
  linear(
    'maxInternodeLength',
    'Growth rate (max shoot length/yr)',
    'Maximum annual leader elongation at full vigor. Fast-growing pioneer species (poplar, willow) vs. slow-growing ones (oak, beech).',
    'species',
    0.2,
    1.2,
    0.02,
    (v) => `${v.toFixed(2)}m`
  ),
  angleDeg(
    'branchingAngle',
    'Branching angle',
    'Divergence angle of a new branch from its parent axis. Narrow = upright/columnar habit; wide = spreading.',
    'species',
    20,
    85,
    1
  ),
  linear(
    'gravitropicDroop',
    'Droop / weeping habit',
    'How much a branch sags under its own weight as it loses vigor. 0 = rigid and upright (Lombardy poplar); higher = weeping (willow).',
    'species',
    0,
    0.6,
    0.02,
    (v) => v.toFixed(2)
  ),
  angleDeg(
    'trunkWaviness',
    'Trunk waviness',
    "Random per-year wobble in a growing axis's direction, before it straightens back toward vertical. 0 = ruler-straight (an excurrent conifer's unbroken apical dominance); higher = a leaning, zigzagging main stem, since a real deciduous tree's weaker/more interruptible apical control lets small deviations happen and then -- since wood never unbends once laid down -- stick around permanently.",
    'species',
    0,
    12,
    0.5
  ),
  linear(
    'leafLifespanYears',
    'Foliage retention (years)',
    "How many years a shoot keeps its leaves before shedding them. Short (~1-2) reads as deciduous; conifers commonly retain needles 3-8+ years.",
    'species',
    1,
    8,
    1,
    (v) => `${v}yr`
  ),
  linear(
    'senescenceLightThreshold',
    'Shade tolerance',
    'Minimum light level a branch can survive on. Lower = more shade-tolerant (beech, hemlock keep lower branches in deep shade); higher = a shade-intolerant pioneer that self-prunes aggressively (birch, pine).',
    'species',
    0.02,
    0.35,
    0.01,
    (v) => `${Math.round(v * 100)}%`
  ),
  linear(
    'lightExtinctionCoefficient',
    'Canopy density (self-shading)',
    'How strongly the canopy shades itself per unit leaf area. Broad, densely-leaved species self-shade more than sparse or needle-leaved ones.',
    'species',
    1,
    8,
    0.25,
    (v) => v.toFixed(2)
  ),
  linear(
    'coDominanceProbability',
    'Forking tendency',
    'Chance a new branch becomes a co-dominant peer instead of a clearly subordinate lateral. Higher gives multi-stemmed/clumping habits (river birch, many shrubs); lower gives a single-leader habit.',
    'species',
    0,
    0.15,
    0.005,
    (v) => `${Math.round(v * 100)}%`
  ),
  linear(
    'leafAreaPerShootLength',
    'Foliage density per shoot',
    'Leaf area produced per meter of new shoot growth. Large-leaved/lush species vs. sparse-leaved ones.',
    'species',
    0.05,
    0.4,
    0.01,
    (v) => v.toFixed(2)
  ),
  linear(
    'mechanicalThickeningFactor',
    'Trunk taper / wind-firmness',
    'Multiplier on the real-wood-physics mechanical-support floor (Greenhill buckling for the trunk, cantilever bending for lateral branches -- see pipeModel.ts): 1.0 is a real green-hardwood safety margin. Higher gives a stouter, more over-built trunk (open-grown/wind-exposed form); lower gives a slenderer, more marginally-built one (sheltered forest-grown, living closer to the structural edge).',
    'species',
    0.3,
    3,
    0.1,
    (v) => v.toFixed(1)
  ),
];
