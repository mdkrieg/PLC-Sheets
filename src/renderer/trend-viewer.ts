/**
 * Trend Viewer renderer.
 *
 * Renders historical data using uPlot. The window is opened as a standalone
 * BrowserWindow by `history:openViewer` from the main process.
 *
 * Data flow:
 *  - On load: invoke `history:tagList` to populate tag selector.
 *  - On user interaction (tag select / time range): invoke `history:query`
 *    and rebuild the uPlot instance.
 *  - Live mode: subscribe to `history:point` push events; append new points
 *    and shift the time range forward.
 */

import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

// ---- Types ----------------------------------------------------------------

interface HistoryPoint {
  ts: number;
  value: number | boolean | null;
}

interface TagInfo {
  id: number;
  name: string;
}

// ---- State ----------------------------------------------------------------

const COLORS = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2',
  '#59a14f', '#edc948', '#b07aa1', '#ff9da7',
  '#9c755f', '#bab0ac',
];

let plot: uPlot | null = null;
let liveModeActive = false;
let liveCleanup: (() => void) | null = null;
let currentTags: string[] = [];
let currentStart = 0;
let currentEnd = 0;

// ---- DOM refs -------------------------------------------------------------

const tagSelect = document.getElementById('tv-tag-select') as HTMLSelectElement;
const fromInput = document.getElementById('tv-from') as HTMLInputElement;
const toInput = document.getElementById('tv-to') as HTMLInputElement;
const queryBtn = document.getElementById('tv-query-btn') as HTMLButtonElement;
const liveBtn = document.getElementById('tv-live-btn') as HTMLButtonElement;
const chartEl = document.getElementById('tv-chart') as HTMLDivElement;
const statusEl = document.getElementById('tv-status') as HTMLSpanElement;

// ---- Helpers --------------------------------------------------------------

function toDatetimeLocal(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocal(s: string): number {
  return new Date(s).getTime();
}

function setStatus(msg: string) {
  statusEl.textContent = msg;
}

function selectedTags(): string[] {
  return Array.from(tagSelect.selectedOptions).map((o) => o.value);
}

// ---- Tag list loading -----------------------------------------------------

async function loadTagList(): Promise<void> {
  const result = await window.api.invoke('history:tagList');
  const tags = (result as { tags: TagInfo[] }).tags;
  const prev = selectedTags();
  tagSelect.innerHTML = '';
  if (tags.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = '(no tags recorded yet)';
    opt.disabled = true;
    tagSelect.appendChild(opt);
    return;
  }
  tagSelect.size = Math.min(tags.length, 8);
  for (const t of tags) {
    const opt = document.createElement('option');
    opt.value = t.name;
    opt.textContent = t.name;
    if (prev.includes(t.name)) opt.selected = true;
    tagSelect.appendChild(opt);
  }
}

// ---- Query and render ------------------------------------------------------

async function runQuery(): Promise<void> {
  const tags = selectedTags();
  if (tags.length === 0) {
    setStatus('Select one or more tags.');
    return;
  }
  const start = fromInput.value ? fromDatetimeLocal(fromInput.value) : Date.now() - 3600_000;
  const end = toInput.value ? fromDatetimeLocal(toInput.value) : Date.now();

  currentTags = tags;
  currentStart = start;
  currentEnd = end;

  setStatus('Loading…');

  // Fetch all series in parallel
  const series = await Promise.all(
    tags.map(async (tag) => {
      const r = await window.api.invoke('history:query', { tag, startTs: start, endTs: end });
      return (r as { tag: string; points: HistoryPoint[] }).points;
    }),
  );

  renderPlot(tags, series, start, end);
  setStatus(`Showing ${tags.join(', ')} — ${new Date(start).toLocaleString()} → ${new Date(end).toLocaleString()}`);
}

function renderPlot(tags: string[], series: HistoryPoint[][], start: number, end: number): void {
  // Destroy previous plot
  if (plot) {
    plot.destroy();
    plot = null;
  }

  // Build a unified sorted timestamp axis from all series
  const allTs = Array.from(new Set(series.flatMap((s) => s.map((p) => p.ts)))).sort((a, b) => a - b);
  if (allTs.length === 0) {
    setStatus('No data in selected range.');
    return;
  }

  // uPlot data: first array = timestamps in seconds, then one array per series
  const uData: (number | null)[][] = [
    allTs.map((t) => t / 1000), // uPlot uses Unix seconds
  ];

  for (const pts of series) {
    const map = new Map(pts.map((p) => [p.ts, p.value]));
    // Step-hold: carry last known value forward
    let last: number | null = null;
    uData.push(
      allTs.map((t) => {
        if (map.has(t)) {
          const v = map.get(t)!;
          last = v === null ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v;
        }
        return last;
      }),
    );
  }

  const uSeries: uPlot.Series[] = [
    {}, // x-axis (timestamps)
    ...tags.map((name, i) => ({
      label: name,
      stroke: COLORS[i % COLORS.length],
      width: 1.5,
      spanGaps: false,
    } satisfies uPlot.Series)),
  ];

  const w = chartEl.clientWidth || 800;
  const h = chartEl.clientHeight || 400;

  plot = new uPlot(
    {
      width: w,
      height: h,
      series: uSeries,
      scales: { x: { time: true } },
      axes: [
        { stroke: 'var(--fg)', ticks: { stroke: 'var(--border)' }, grid: { stroke: 'var(--border)' } },
        { stroke: 'var(--fg)', ticks: { stroke: 'var(--border)' }, grid: { stroke: 'var(--border)' } },
      ],
      cursor: { show: true },
    } as uPlot.Options,
    uData as uPlot.AlignedData,
    chartEl,
  );

  // Resize observer
  const ro = new ResizeObserver(() => {
    if (plot) {
      plot.setSize({ width: chartEl.clientWidth, height: chartEl.clientHeight });
    }
  });
  ro.observe(chartEl);
}

// ---- Live mode ------------------------------------------------------------

function startLive(): void {
  liveModeActive = true;
  liveBtn.classList.add('active');
  liveBtn.textContent = 'Live ●';

  liveCleanup = window.api.on('history:point', (point: unknown) => {
    const { tag, ts, value } = point as { tag: string; ts: number; value: number | boolean | null };
    if (!currentTags.includes(tag) || !plot) return;

    const numericValue = value === null ? null : typeof value === 'boolean' ? (value ? 1 : 0) : value;
    const tsSec = ts / 1000;
    const seriesIdx = currentTags.indexOf(tag) + 1; // +1 for x-axis

    // Extend the x-axis and this series; other series get null for the new point
    const xData = plot.data[0] as number[];
    xData.push(tsSec);
    for (let i = 1; i < plot.data.length; i++) {
      (plot.data[i] as (number | null)[]).push(i === seriesIdx ? numericValue : null);
    }

    // Advance the window to keep the last (currentEnd - currentStart) worth of data
    const windowMs = currentEnd - currentStart;
    currentEnd = ts;
    currentStart = currentEnd - windowMs;
    plot.setData(plot.data as uPlot.AlignedData, true);
  });
}

function stopLive(): void {
  liveModeActive = false;
  liveBtn.classList.remove('active');
  liveBtn.textContent = 'Live';
  if (liveCleanup) {
    liveCleanup();
    liveCleanup = null;
  }
}

// ---- Event wiring ---------------------------------------------------------

document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const presets: Record<string, number> = {
      '1h': 3600_000,
      '6h': 6 * 3600_000,
      '24h': 24 * 3600_000,
      '7d': 7 * 24 * 3600_000,
    };
    const ms = presets[btn.dataset.preset!] ?? 3600_000;
    const end = Date.now();
    const start = end - ms;
    fromInput.value = toDatetimeLocal(start);
    toInput.value = toDatetimeLocal(end);
    void runQuery();
  });
});

queryBtn.addEventListener('click', () => void runQuery());

tagSelect.addEventListener('change', () => void runQuery());

liveBtn.addEventListener('click', () => {
  if (liveModeActive) stopLive();
  else startLive();
});

// ---- Init -----------------------------------------------------------------

// Set default time range to last 1h
const defaultEnd = Date.now();
const defaultStart = defaultEnd - 3600_000;
fromInput.value = toDatetimeLocal(defaultStart);
toInput.value = toDatetimeLocal(defaultEnd);

void loadTagList().then(() => {
  // Auto-select first tag if none selected
  if (selectedTags().length === 0 && tagSelect.options.length > 0 && !tagSelect.options[0]!.disabled) {
    tagSelect.options[0]!.selected = true;
  }
  void runQuery();
});
