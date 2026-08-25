import type { ForestHistory, SimulationHistory, SimulationParams } from './model/types';
import { defaultParams } from './sim/params';
import { deserializeHistory, runSimulation, serializeHistory } from './sim/simulate';
import { deserializeParamsPreset, serializeParamsPreset } from './sim/params';
import type { ForestWorkerOutMessage, ForestWorkerStartMessage } from './sim/forestWorker';
import ForestWorkerCtor from './sim/forestWorker?worker&inline';
import { defaultForestParams } from './sim/forestParams';
import { sunDirection } from './sim/sun';
import { TreeDebugRenderer, COLOR_MODES, type ColorModeId, type HoverInfo } from './render/debugRenderer';
import { PARAM_CONTROLS } from './paramControls';

const canvasContainer = document.getElementById('canvas-container') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const scrubber = document.getElementById('scrubber') as HTMLInputElement;
const yearLabel = document.getElementById('year-label') as HTMLSpanElement;
const metricsLine = document.getElementById('metrics-line') as HTMLDivElement;
const tooltip = document.getElementById('tooltip') as HTMLDivElement;
const thicknessToggle = document.getElementById('thickness-toggle') as HTMLInputElement;
const leavesToggle = document.getElementById('leaves-toggle') as HTMLInputElement;
const colorModeSelect = document.getElementById('color-mode-select') as HTMLSelectElement;
const legend = document.getElementById('legend') as HTMLDivElement;
const yearsInput = document.getElementById('years-input') as HTMLInputElement;
const seedInput = document.getElementById('seed-input') as HTMLInputElement;
const simulateBtn = document.getElementById('simulate-btn') as HTMLButtonElement;
const downloadBtn = document.getElementById('download-btn') as HTMLButtonElement;
const uploadBtn = document.getElementById('upload-btn') as HTMLButtonElement;
const uploadInput = document.getElementById('upload-input') as HTMLInputElement;
const playBtn = document.getElementById('play-btn') as HTMLButtonElement;
const resetBtn = document.getElementById('reset-btn') as HTMLButtonElement;
const envControls = document.getElementById('env-controls') as HTMLDivElement;
const speciesControls = document.getElementById('species-controls') as HTMLDivElement;
const resetParamsBtn = document.getElementById('reset-params-btn') as HTMLButtonElement;
const savePresetBtn = document.getElementById('save-preset-btn') as HTMLButtonElement;
const loadPresetBtn = document.getElementById('load-preset-btn') as HTMLButtonElement;
const loadPresetInput = document.getElementById('load-preset-input') as HTMLInputElement;

const modeSingleBtn = document.getElementById('mode-single-btn') as HTMLButtonElement;
const modeForestBtn = document.getElementById('mode-forest-btn') as HTMLButtonElement;
const singleTreeControls = document.getElementById('single-tree-controls') as HTMLDivElement;
const forestControls = document.getElementById('forest-controls') as HTMLDivElement;
const forestYearsInput = document.getElementById('forest-years-input') as HTMLInputElement;
const forestSeedInput = document.getElementById('forest-seed-input') as HTMLInputElement;
const forestMaxTreesInput = document.getElementById('forest-max-trees-input') as HTMLInputElement;
const forestReproductionInput = document.getElementById('forest-reproduction-input') as HTMLInputElement;
const forestDispersalInput = document.getElementById('forest-dispersal-input') as HTMLInputElement;
const forestSimulateBtn = document.getElementById('forest-simulate-btn') as HTMLButtonElement;
const deathLog = document.getElementById('death-log') as HTMLDivElement;
const statusText = document.getElementById('status-text') as HTMLSpanElement;
const statusCancelBtn = document.getElementById('status-cancel-btn') as HTMLButtonElement;
const walkBtn = document.getElementById('walk-btn') as HTMLButtonElement;
const exitWalkBtn = document.getElementById('exit-walk-btn') as HTMLButtonElement;
const walkOverlay = document.getElementById('walk-overlay') as HTMLDivElement;
const walkCrosshair = document.getElementById('walk-crosshair') as HTMLDivElement;
const controlsPanel = document.getElementById('controls') as HTMLDivElement;
const scrubberBar = document.getElementById('scrubber-bar') as HTMLDivElement;

const renderer = new TreeDebugRenderer(canvasContainer);

for (const mode of COLOR_MODES) {
  const opt = document.createElement('option');
  opt.value = mode.id;
  opt.textContent = mode.label;
  colorModeSelect.appendChild(opt);
}

// --- Species & environment parameter sliders ---
// Overrides are collected here and merged over defaultParams the next
// time a tree is grown (via the "Grow new tree" button) -- they don't
// retroactively change an already-grown tree, same as the seed/years
// inputs above.
const paramOverrides: Partial<SimulationParams> = {};

function buildParamSlider(container: HTMLElement, def: (typeof PARAM_CONTROLS)[number]): void {
  const row = document.createElement('div');
  row.className = 'slider-row';

  const labelRow = document.createElement('div');
  labelRow.className = 'slider-label-row';
  const label = document.createElement('label');
  label.textContent = def.label;
  label.htmlFor = `param-${def.key}`;
  const valueEl = document.createElement('span');
  valueEl.className = 'slider-value';
  labelRow.append(label, valueEl);

  const input = document.createElement('input');
  input.type = 'range';
  input.id = `param-${def.key}`;
  input.min = String(def.min);
  input.max = String(def.max);
  input.step = String(def.step);

  const desc = document.createElement('div');
  desc.className = 'slider-desc';
  desc.textContent = def.description;

  const applyDisplay = (paramValue: number): void => {
    valueEl.textContent = def.format(paramValue);
  };

  const setFromParamValue = (paramValue: number): void => {
    input.value = String(def.toSlider(paramValue));
    applyDisplay(paramValue);
  };

  setFromParamValue(defaultParams[def.key] as number);

  input.addEventListener('input', () => {
    const paramValue = def.toParam(Number(input.value));
    (paramOverrides as Record<string, number>)[def.key] = paramValue;
    applyDisplay(paramValue);
  });

  // Expose so the reset button can restore the displayed slider position.
  (input as HTMLInputElement & { __setFromParamValue?: (v: number) => void }).__setFromParamValue = setFromParamValue;

  row.append(labelRow, input, desc);
  container.appendChild(row);
}

for (const def of PARAM_CONTROLS) {
  buildParamSlider(def.group === 'environment' ? envControls : speciesControls, def);
}

resetParamsBtn.addEventListener('click', () => {
  for (const key of Object.keys(paramOverrides)) delete (paramOverrides as Record<string, unknown>)[key];
  for (const def of PARAM_CONTROLS) {
    const input = document.getElementById(`param-${def.key}`) as (HTMLInputElement & { __setFromParamValue?: (v: number) => void }) | null;
    input?.__setFromParamValue?.(defaultParams[def.key] as number);
  }
});

/** The full parameter set the "Grow new tree" button would use right now,
 * given the current sliders and seed field -- this is what "save the
 * current parameters" means, independent of whether a tree has actually
 * been grown with them yet. */
function currentEffectiveParams(): SimulationParams {
  const seed = Math.max(0, Number(seedInput.value) || 0);
  return { ...defaultParams, ...paramOverrides, seed };
}

savePresetBtn.addEventListener('click', () => {
  const params = currentEffectiveParams();
  const json = serializeParamsPreset(params);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tree-preset.json';
  a.click();
  URL.revokeObjectURL(url);
});

loadPresetBtn.addEventListener('click', () => loadPresetInput.click());
loadPresetInput.addEventListener('change', () => {
  const file = loadPresetInput.files?.[0];
  if (!file) return;
  void (async () => {
    try {
      const text = await file.text();
      const params = deserializeParamsPreset(text);
      // Apply every field the preset carries as an override (not just the
      // ones exposed as sliders -- a preset is the *whole* params object),
      // then sync slider positions/seed field to match what's now active.
      for (const key of Object.keys(params) as (keyof SimulationParams)[]) {
        (paramOverrides as Record<string, number>)[key] = params[key] as number;
      }
      seedInput.value = String(params.seed);
      for (const def of PARAM_CONTROLS) {
        const input = document.getElementById(`param-${def.key}`) as (HTMLInputElement & { __setFromParamValue?: (v: number) => void }) | null;
        input?.__setFromParamValue?.(params[def.key] as number);
      }
    } catch (err) {
      alert(`Could not load that file as a tree preset: ${(err as Error).message}`);
    }
  })();
  loadPresetInput.value = '';
});

type ViewMode = 'single' | 'forest';
let viewMode: ViewMode = 'single';

let history: SimulationHistory | null = null;
let forestHistory: ForestHistory | null = null;
let playTimer: number | null = null;
/** Set while a forest generation is streaming in from forestWorker.ts;
 * calling it cancels that generation (the status bar's own Cancel button,
 * and starting a new generation while one is already running, both use
 * this). */
let cancelForestGeneration: (() => void) | null = null;
/** Whether the view should keep jumping to the newest forest-year as
 * progress messages stream in (a live "watch it grow" preview) -- turned
 * off the moment the user manually touches the scrubber during
 * generation, so scrubbing back to look at an earlier year doesn't get
 * yanked forward again on the next progress message. Reset to true each
 * time a new generation starts. */
let followLiveForestGrowth = true;

function setStatus(text: string | null, cancelable = false): void {
  if (text === null) {
    statusEl.style.display = 'none';
    statusCancelBtn.style.display = 'none';
  } else {
    statusEl.style.display = 'flex';
    statusText.textContent = text;
    statusCancelBtn.style.display = cancelable ? '' : 'none';
  }
}

statusCancelBtn.addEventListener('click', () => cancelForestGeneration?.());

function updateLegend(): void {
  const mode = COLOR_MODES.find((m) => m.id === colorModeSelect.value) ?? COLOR_MODES[0];
  legend.textContent = mode.description;
}

/** Length of whichever history (single-tree or forest) is currently
 * active, for the scrubber/play/reset controls, which don't otherwise
 * need to know which mode they're operating in. */
function currentStatesLength(): number {
  if (viewMode === 'single') return history?.states.length ?? 0;
  return forestHistory?.states.length ?? 0;
}

function showAtIndex(index: number): void {
  if (viewMode === 'single') {
    if (!history) return;
    const state = history.states[index];
    renderer.setState(state);
    yearLabel.textContent = `Year ${state.year}`;
    const m = state.metrics;
    metricsLine.textContent =
      `H=${m.height.toFixed(2)}m  DBH=${(m.dbh * 100).toFixed(1)}cm  ` +
      `crownBase=${m.crownBaseHeight.toFixed(2)}m  crownWidth=${m.crownWidth.toFixed(2)}m  ` +
      `rootSpread=${m.rootSpread.toFixed(2)}m  rootDepth=${m.rootDepth.toFixed(2)}m  ` +
      `leafArea=${m.totalLeafArea.toFixed(1)}m²  segments=${state.segments.length}  buds=${state.buds.length}`;
    deathLog.style.display = 'none';
    return;
  }

  if (!forestHistory) return;
  const snap = forestHistory.states[index];
  renderer.setForestState(snap.trees.map((t) => ({ id: t.id, offset: t.position, state: t.state })));
  yearLabel.textContent = `Forest year ${snap.forestYear}`;

  const totalLeafArea = snap.trees.reduce((sum, t) => sum + t.state.metrics.totalLeafArea, 0);
  const totalSegments = snap.trees.reduce((sum, t) => sum + t.state.segments.length, 0);
  const meanHeight = snap.trees.length > 0 ? snap.trees.reduce((sum, t) => sum + t.state.metrics.height, 0) / snap.trees.length : 0;
  const tallest = snap.trees.reduce((m, t) => Math.max(m, t.state.metrics.height), 0);
  metricsLine.textContent =
    `living trees=${snap.trees.length}  dead so far=${snap.deadTrees.length}  ` +
    `meanHeight=${meanHeight.toFixed(2)}m  tallest=${tallest.toFixed(2)}m  ` +
    `totalLeafArea=${totalLeafArea.toFixed(1)}m²  totalSegments=${totalSegments}`;

  if (snap.deadTrees.length > 0) {
    deathLog.style.display = 'block';
    // Most recent first -- the tail of the (already forest-year-ordered)
    // death log is what a user scrubbing forward just caused.
    deathLog.textContent = [...snap.deadTrees]
      .reverse()
      .slice(0, 12)
      .map((d) => `year ${d.diedYear}: tree #${d.id} died (${d.cause}), planted year ${d.plantedYear}, reached ${d.finalHeight.toFixed(2)}m`)
      .join('\n');
  } else {
    deathLog.style.display = 'none';
  }
}

function loadHistory(h: SimulationHistory): void {
  history = h;
  scrubber.max = String(h.states.length - 1);
  scrubber.value = String(h.states.length - 1);
  const finalMetrics = h.states[h.states.length - 1].metrics;
  renderer.frame(finalMetrics.height, finalMetrics.crownWidth);
  // "Photo" mode's shadows follow the actual sun angle this tree was
  // grown under, not a fixed studio-light position.
  renderer.setSunDirection(sunDirection(h.params));
  showAtIndex(h.states.length - 1);
}

/** Points the camera at the whole current forest population and syncs the
 * sun direction -- called once generation finishes, and also on the
 * user's very first progress update (so it doesn't stay pointed at
 * wherever the camera happened to be before "Grow forest" was clicked
 * while a long generation streams in). */
function frameCurrentForest(h: ForestHistory, atIndex: number): void {
  renderer.frameForest(
    h.states[atIndex].trees.map((t) => ({ offset: t.position, height: t.state.metrics.height, crownWidth: t.state.metrics.crownWidth }))
  );
  renderer.setSunDirection(sunDirection(h.params));
}

async function simulate(params: SimulationParams, years: number): Promise<void> {
  setStatus(`Growing tree for ${years} years…`);
  // Yield to the browser so the status message actually paints before the
  // (synchronous, potentially multi-second) simulation runs.
  await new Promise((r) => setTimeout(r, 20));
  const h = runSimulation(params, years);
  loadHistory(h);
  setStatus(null);
}

/**
 * Runs a forest generation in a background Web Worker (forestWorker.ts)
 * so a long run (now practical thanks to equilibrium freezing -- see
 * ForestTree.frozen) never blocks the page, streaming progress back one
 * or more forest-years at a time (see ForestWorkerOutMessage) instead of
 * making the caller wait for the whole thing to finish. The view follows
 * along live (growing the scrubber, showing the newest year) unless the
 * user has manually scrubbed elsewhere, and a Cancel button in the status
 * bar can stop generation early -- whatever years have streamed in by
 * then stay fully usable, just shorter than requested.
 */
async function simulateForest(): Promise<void> {
  const years = Math.max(1, Math.min(3000, Number(forestYearsInput.value) || defaultForestParams.years));
  const forestSeed = Math.max(0, Number(forestSeedInput.value) || 0);
  const maxTrees = Math.max(1, Math.min(150, Number(forestMaxTreesInput.value) || defaultForestParams.maxTrees));
  const reproductionProbability = Math.max(0, Math.min(1, Number(forestReproductionInput.value) || 0));
  const seedDispersalRadius = Math.max(0.5, Number(forestDispersalInput.value) || defaultForestParams.seedDispersalRadius);
  const forestParams = { ...defaultForestParams, years, maxTrees, reproductionProbability, seedDispersalRadius };
  const params = currentEffectiveParams();

  // Starting a new generation always supersedes one already in flight.
  cancelForestGeneration?.();

  forestHistory = { formatVersion: 1, params, forestParams, forestSeed, states: [] };
  followLiveForestGrowth = true;
  walkBtn.disabled = true;
  setStatus(`Growing forest… (0/${years} years, 1 tree)`, true);

  const worker = new ForestWorkerCtor();
  let framedYet = false;
  // Re-rendering the whole forest scene (showAtIndex -> setForestState,
  // which rebuilds every instanced mesh from scratch) is real, non-trivial
  // work once a forest has any size to it -- doing that on *every*
  // progress message for a long generation would pile rendering cost on
  // top of the worker's own computation and can make the tab unresponsive
  // for no real benefit (a human can't perceive the difference between a
  // live view updating every 120ms of worker time vs. a few times a
  // second). This throttles the live-follow re-render independently of
  // how often progress messages themselves arrive; the scrubber max and
  // status text above still update on every message, since those are cheap.
  let lastLiveRenderTime = 0;
  const LIVE_RENDER_MIN_INTERVAL_MS = 500;

  await new Promise<void>((resolve) => {
    const finish = (): void => {
      cancelForestGeneration = null;
      worker.terminate();
      resolve();
    };
    cancelForestGeneration = (): void => {
      setStatus(null);
      finish();
    };

    worker.onmessage = (e: MessageEvent<ForestWorkerOutMessage>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        const h = forestHistory!;
        for (const snap of msg.snapshots) h.states.push(snap);
        const lastIndex = h.states.length - 1;
        const latest = h.states[lastIndex];
        scrubber.max = String(lastIndex);
        setStatus(`Growing forest… (${latest.forestYear}/${msg.totalYears} years, ${latest.trees.length} trees)`, true);
        if (!framedYet) {
          frameCurrentForest(h, lastIndex);
          framedYet = true;
        }
        if (latest.trees.length > 0) walkBtn.disabled = false;
        if (followLiveForestGrowth) {
          scrubber.value = String(lastIndex);
          const now = performance.now();
          if (now - lastLiveRenderTime >= LIVE_RENDER_MIN_INTERVAL_MS) {
            showAtIndex(lastIndex);
            lastLiveRenderTime = now;
          }
        }
      } else if (msg.type === 'done') {
        const h = forestHistory!;
        const lastIndex = h.states.length - 1;
        frameCurrentForest(h, lastIndex);
        scrubber.value = String(lastIndex);
        followLiveForestGrowth = true;
        showAtIndex(lastIndex);
        setStatus(null);
        finish();
      } else if (msg.type === 'error') {
        alert(`Forest generation failed: ${msg.message}`);
        setStatus(null);
        finish();
      }
    };
    worker.onerror = (err) => {
      alert(`Forest generation failed: ${err.message}`);
      setStatus(null);
      finish();
    };

    const start: ForestWorkerStartMessage = { type: 'start', params, forestParams, forestSeed };
    worker.postMessage(start);
  });
}

simulateBtn.addEventListener('click', () => {
  const years = Math.max(1, Math.min(500, Number(yearsInput.value) || 110));
  const seed = Math.max(0, Number(seedInput.value) || 0);
  void simulate({ ...defaultParams, ...paramOverrides, seed }, years);
});

forestSimulateBtn.addEventListener('click', () => void simulateForest());

function setViewMode(next: ViewMode): void {
  if (viewMode === next) return;
  stopPlayback();
  viewMode = next;
  modeSingleBtn.classList.toggle('active', next === 'single');
  modeForestBtn.classList.toggle('active', next === 'forest');
  singleTreeControls.style.display = next === 'single' ? '' : 'none';
  forestControls.style.display = next === 'forest' ? '' : 'none';
  if (next === 'forest' && !forestHistory) {
    void simulateForest();
    return;
  }
  const len = currentStatesLength();
  if (len > 0) {
    scrubber.max = String(len - 1);
    scrubber.value = String(len - 1);
    showAtIndex(len - 1);
  }
}

modeSingleBtn.addEventListener('click', () => setViewMode('single'));
modeForestBtn.addEventListener('click', () => setViewMode('forest'));

// A saved history is already a compact per-year diff (see historyCodec.ts),
// but it's still a large, highly-repetitive JSON blob (numeric arrays,
// repeated key names for thousands of segments) that gzip compresses
// very well. CompressionStream/DecompressionStream are supported in all
// current major browsers; fall back to plain, uncompressed JSON if not.
const supportsGzip = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function gzipText(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

async function gunzipToText(blob: Blob): Promise<string> {
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

downloadBtn.addEventListener('click', () => {
  void (async () => {
    if (!history) return;
    const json = serializeHistory(history);
    const namePrefix = `tree-history-${history.species.replace(/\s+/g, '-')}-${history.states.length - 1}yr`;
    const blob = supportsGzip ? await gzipText(json) : new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = supportsGzip ? `${namePrefix}.json.gz` : `${namePrefix}.json`;
    a.click();
    URL.revokeObjectURL(url);
  })();
});

uploadBtn.addEventListener('click', () => uploadInput.click());
uploadInput.addEventListener('change', () => {
  const file = uploadInput.files?.[0];
  if (!file) return;
  void (async () => {
    try {
      const text = file.name.endsWith('.gz') ? await gunzipToText(file) : await file.text();
      const h = deserializeHistory(text);
      loadHistory(h);
    } catch (err) {
      alert(`Could not load that file as a simulation history: ${(err as Error).message}`);
    }
  })();
  uploadInput.value = '';
});

scrubber.addEventListener('input', () => {
  stopPlayback();
  followLiveForestGrowth = false;
  showAtIndex(Number(scrubber.value));
});

thicknessToggle.addEventListener('change', () => renderer.setOptions({ showThickness: thicknessToggle.checked }));
leavesToggle.addEventListener('change', () => renderer.setOptions({ showLeaves: leavesToggle.checked }));
colorModeSelect.addEventListener('change', () => {
  renderer.setOptions({ colorMode: colorModeSelect.value as ColorModeId });
  updateLegend();
});

function stopPlayback(): void {
  if (playTimer !== null) {
    clearInterval(playTimer);
    playTimer = null;
    playBtn.textContent = '▶ Play';
  }
}

playBtn.addEventListener('click', () => {
  if (playTimer !== null) {
    stopPlayback();
    return;
  }
  playBtn.textContent = '⏸ Pause';
  playTimer = window.setInterval(() => {
    const len = currentStatesLength();
    if (len === 0) return;
    const next = Number(scrubber.value) + 1;
    if (next >= len) {
      stopPlayback();
      return;
    }
    scrubber.value = String(next);
    showAtIndex(next);
  }, 120);
});

resetBtn.addEventListener('click', () => {
  stopPlayback();
  scrubber.value = '0';
  showAtIndex(0);
});

function formatVec3(v: readonly [number, number, number]): string {
  return `(${v[0].toFixed(2)}, ${v[1].toFixed(2)}, ${v[2].toFixed(2)})`;
}

function formatHover(info: HoverInfo): string {
  // In forest mode, multiple trees' geometry share the scene, so the
  // tooltip needs to say *which* tree was hit; in single-tree mode
  // treeId is always 0 and would just be visual noise.
  const treePrefix = viewMode === 'forest' ? [`tree #${info.treeId}`] : [];
  if (info.kind === 'segment') {
    const s = info.segment;
    const lines = [
      ...treePrefix,
      `${s.kind === 'root' ? 'Root segment' : 'Branch segment'} #${s.id}`,
      `order: ${s.order}   alive: ${s.alive}`,
      `created year: ${s.createdYear}`,
      `start: ${formatVec3(s.start)}`,
      `end:   ${formatVec3(s.end)}`,
      `radius: ${(s.baseRadius * 1000).toFixed(1)}mm → ${(s.tipRadius * 1000).toFixed(1)}mm`,
      s.kind === 'root' ? `absorptive area: ${s.leafArea.toFixed(3)} m²` : `leaf area: ${s.leafArea.toFixed(3)} m²`,
      `light exposure: ${(s.lightExposure * 100).toFixed(0)}%`,
      `hydraulic resistance: ${s.hydraulicResistance.toFixed(1)}`,
    ];
    if (info.tipBud) {
      const b = info.tipBud;
      lines.push('--- tip bud ---', `status: ${b.status}`, `vigor: ${(b.vigor * 100).toFixed(0)}%`, `hormonal vigor: ${(b.hormonalVigor * 100).toFixed(0)}%`);
    }
    return lines.join('\n');
  }
  const l = info.leaf;
  return [
    ...treePrefix,
    `Leaf #${l.id}`,
    `on segment: ${l.segmentId}`,
    `age: ${l.ageYears}yr`,
    `area: ${(l.area * 10000).toFixed(1)} cm²`,
    `position: ${formatVec3(l.position)}`,
  ].join('\n');
}

renderer.onHover = (info) => {
  // No hover tooltip while walking -- there's no pointer to hover with
  // (the mouse is pointer-locked and driving look direction instead),
  // and the whole analytic UI (including this tooltip) is hidden anyway.
  if (renderer.isWalking() || !info) {
    tooltip.style.display = 'none';
    return;
  }
  tooltip.style.display = 'block';
  tooltip.textContent = formatHover(info);
};

// --- Walking mode: an immersive first-person view of a generated forest.
// Most of the analytic UI (the whole controls panel and scrubber bar)
// hides while walking; see TreeDebugRenderer.enterWalkMode's own doc for
// the WASD-turn/mouse-look control scheme and how/when it exits.
function setWalkUiVisible(walking: boolean): void {
  controlsPanel.style.display = walking ? 'none' : '';
  scrubberBar.style.display = walking ? 'none' : '';
  walkOverlay.style.display = walking ? 'block' : 'none';
  walkCrosshair.style.display = walking ? 'block' : 'none';
  if (walking) tooltip.style.display = 'none';
}

walkBtn.addEventListener('click', () => {
  if (!forestHistory) return;
  stopPlayback();
  renderer.enterWalkMode();
});
exitWalkBtn.addEventListener('click', () => renderer.exitWalkMode());
// onWalkModeChange (not just these two click handlers) is the single
// source of truth for UI visibility: walking mode can also end on its
// own (pressing Escape releases pointer lock, which the renderer treats
// as "leave walking mode" -- see its own doc), and the UI needs to sync
// to that just as much as to an explicit button click.
renderer.onWalkModeChange = (active) => setWalkUiVisible(active);

// A lost WebGL context is the browser/GPU driver forcibly reclaiming the
// canvas (see disposeMesh's own doc in debugRenderer.ts for the leak that
// used to make this likely) -- rendering itself pauses and, once the
// browser fires 'webglcontextrestored', resumes automatically; this is
// purely user-facing feedback in the meantime.
renderer.onContextLost = () => setStatus('Graphics context lost -- attempting to recover…');
renderer.onContextRestored = () => setStatus(null);

updateLegend();
void simulate({ ...defaultParams, ...paramOverrides, seed: Number(seedInput.value) || 1 }, Number(yearsInput.value) || 110);
