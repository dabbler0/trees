import type { SimulationHistory, SimulationParams } from './model/types';
import { defaultParams } from './sim/params';
import { deserializeHistory, runSimulation, serializeHistory } from './sim/simulate';
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

let history: SimulationHistory | null = null;
let playTimer: number | null = null;

function setStatus(text: string | null): void {
  if (text === null) {
    statusEl.style.display = 'none';
  } else {
    statusEl.style.display = 'block';
    statusEl.textContent = text;
  }
}

function updateLegend(): void {
  const mode = COLOR_MODES.find((m) => m.id === colorModeSelect.value) ?? COLOR_MODES[0];
  legend.textContent = mode.description;
}

function showAtIndex(index: number): void {
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

async function simulate(params: SimulationParams, years: number): Promise<void> {
  setStatus(`Growing tree for ${years} years…`);
  // Yield to the browser so the status message actually paints before the
  // (synchronous, potentially multi-second) simulation runs.
  await new Promise((r) => setTimeout(r, 20));
  const h = runSimulation(params, years);
  loadHistory(h);
  setStatus(null);
}

simulateBtn.addEventListener('click', () => {
  const years = Math.max(1, Math.min(500, Number(yearsInput.value) || 110));
  const seed = Math.max(0, Number(seedInput.value) || 0);
  void simulate({ ...defaultParams, ...paramOverrides, seed }, years);
});

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
    if (!history) return;
    const next = Number(scrubber.value) + 1;
    if (next >= history.states.length) {
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
  if (info.kind === 'segment') {
    const s = info.segment;
    const lines = [
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
  return [`Leaf #${l.id}`, `on segment: ${l.segmentId}`, `age: ${l.ageYears}yr`, `area: ${(l.area * 10000).toFixed(1)} cm²`, `position: ${formatVec3(l.position)}`].join('\n');
}

renderer.onHover = (info) => {
  if (!info) {
    tooltip.style.display = 'none';
    return;
  }
  tooltip.style.display = 'block';
  tooltip.textContent = formatHover(info);
};

updateLegend();
void simulate({ ...defaultParams, ...paramOverrides, seed: Number(seedInput.value) || 1 }, Number(yearsInput.value) || 110);
