import type { SimulationParams } from '../model/types';

/**
 * Default parameter set for a generic, moderately fast-growing broadleaf
 * tree. Values are informed by widely-cited forestry/plant-physiology
 * figures (see README "Biological basis" section for citations):
 *  - height:DBH slenderness ratios of ~50-100 for stable, forest/open
 *    grown trees (Wang et al.; various national forest inventory models);
 *  - the pipe model / Da Vinci rule for sapwood cross-section vs. distal
 *    leaf area (Shinozaki et al. 1964);
 *  - the hydraulic-limitation hypothesis for asymptotic tree height
 *    (Koch, Sillett, Jennings & Davis 2004, "The limits to tree height");
 *  - Beer-Lambert canopy light attenuation and shade-driven self-pruning,
 *    standard in forest canopy models.
 *
 * These are starting points meant to be tuned so the high-level allometry
 * tests in tests/ pass across the whole sapling-to-old-growth age range;
 * see tests/allometry.test.ts for the acceptance ranges.
 */
export const defaultParams: SimulationParams = {
  seed: 1,

  baseInternodeLength: 0.15,
  maxInternodeLength: 0.62,
  juvenileRampYears: 7,

  heightVigorHalfHeight: 18,

  branchingAngle: (72 * Math.PI) / 180,
  phyllotacticAngle: (137.508 * Math.PI) / 180, // golden angle: real spiral phyllotaxis
  nodesPerInternode: 3,
  budBreakProbability: 0.55,
  apicalVigorRetention: 0.999,
  lateralAgingPenalty: 0.0022,
  trunkAgingPenalty: 0.0009,
  lateralVigorRatio: 0.56,
  coDominanceProbability: 0.025,
  coDominantVigorRatio: 0.9,

  gravitropicDroop: 0.16,
  phototropicPull: 0.045,
  sunZenithAngle: 0,
  sunAzimuth: 0,
  heliotropismStrength: 0.5,
  trunkWaviness: (5 * Math.PI) / 180,

  pipeModelRatio: 0.00032,
  mechanicalThickeningFactor: 1,

  leafAreaPerShootLength: 0.18,
  leafLifespanYears: 2,
  lightExtinctionCoefficient: 3.5,
  senescenceLightThreshold: 0.16,
  senescenceYearsTolerance: 3,
  maxActiveBuds: 700,
  selfThinningOnsetFraction: 0.4,
  selfThinningMaxFraction: 0.12,
  abscissionYears: 4,
  spurSenescenceYears: 10,
  lowBranchOcclusionAge: 15,
  lowBranchOcclusionHeight: 1.4,

  respirationPerWoodyVolume: 25,
  carbonCostPerMeterGrowth: 0.04,

  rootCarbonAllocationFraction: 0.25,
  numMainRoots: 5,
  rootSpreadAngle: (55 * Math.PI) / 180,
  rootGeotropicPull: 0.05,
  rootDepthHalfDepth: 1.2,
  rootAbsorptiveAreaPerLength: 0.8,
};

export function cloneParams(p: SimulationParams): SimulationParams {
  return { ...p };
}

/** Wire format for a downloadable "preset" -- just the species/environment
 * parameter set (including seed) a user has dialed in, independent of any
 * grown tree/history. Versioned the same way SimulationHistory is, so a
 * future param shape change can still recognize and reject old files
 * cleanly instead of silently mis-applying them. */
export interface ParamsPreset {
  formatVersion: 1;
  kind: 'tree-params-preset';
  params: SimulationParams;
}

export function serializeParamsPreset(params: SimulationParams): string {
  const preset: ParamsPreset = { formatVersion: 1, kind: 'tree-params-preset', params };
  return JSON.stringify(preset, null, 2);
}

export function deserializeParamsPreset(json: string): SimulationParams {
  const parsed = JSON.parse(json) as Partial<ParamsPreset>;
  if (parsed.kind !== 'tree-params-preset') {
    throw new Error('Not a tree parameter preset file.');
  }
  if (parsed.formatVersion !== 1) {
    throw new Error(`Unsupported preset format version: ${parsed.formatVersion}`);
  }
  if (!parsed.params || typeof parsed.params !== 'object') {
    throw new Error('Preset file is missing its params.');
  }
  return { ...defaultParams, ...parsed.params };
}
