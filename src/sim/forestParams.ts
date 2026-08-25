import type { ForestParams } from '../model/types';

/**
 * Default forest-management parameters. Kept deliberately conservative on
 * scale (see ForestParams.maxTrees's own doc): every tree in the forest
 * keeps the exact same full mechanical/root model and full per-year
 * scrubbable history a single tree does today, so tree count is a real
 * cost multiplier, not just a visual density knob.
 */
export const defaultForestParams: ForestParams = {
  years: 120,
  maxTrees: 25,
  // An explicit age, not tied to the species' own height parameters.
  // Real reproductive-maturity ages vary widely by species -- fast
  // pioneers (birch, poplar, willow) commonly reach it in ~5-10 years,
  // while slower, longer-lived hardwoods (oak, beech) are commonly cited
  // at ~20-30 years to a first significant seed crop -- so this sits at a
  // generic-broadleaf middle ground between those two real ranges rather
  // than favoring either.
  maturityAge: 20,
  // A modest per-tree annual chance once mature -- real mast years are
  // irregular and most seed crops fail to establish at all, which the
  // germination-light-threshold and min-spacing checks below handle
  // separately; this just controls how often a dispersal event is even
  // attempted.
  reproductionProbability: 0.12,
  seedsPerEvent: 2,
  // Real seed dispersal (wind, gravity, animals) commonly reaches several
  // tree-heights from the parent for a wind-dispersed species; this sits
  // at a modest multiple of a mature crown radius so a "small stand" (see
  // maxTrees) actually fills in around its founder rather than each
  // generation immediately scattering off the edge of the visible plot.
  seedDispersalRadius: 9,
  minTreeSpacing: 1.5,
  // Same [0,1] Beer-Lambert scale as a bud's own senescenceLightThreshold;
  // real tree seedlings need noticeably more light to establish at all
  // than an already-established branch needs to merely survive, so this
  // sits above the shoot-level default rather than reusing it.
  germinationLightThreshold: 0.3,
  // Deliberately more forgiving than a single bud's own light-death
  // tolerance (senescenceYearsTolerance, typically ~3 years): a whole
  // established tree carries real stored reserves (the same
  // smoothedCarbonSupply buffering a single year's dip already models)
  // and shouldn't die from a single bad season the way one shaded twig
  // reasonably can.
  lightStarvationThreshold: 0.12,
  lightStarvationYears: 6,
};
