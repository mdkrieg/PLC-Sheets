/**
 * Renderer entry point.
 *
 * Builds the static layout shell (title bar + sidebar + main + bottom log)
 * and wires open/save/find/undo/redo to the active WorkbookView.
 */

import { w2layout } from 'w2ui/w2ui-2.0.es6.min.js';
import 'w2ui/w2ui-2.0.min.css';
import { TitleBar } from './titlebar';
import { Sidebar } from './sidebar';
import { WorkbookView } from './workbook-view';
import { FindReplaceDialog } from './find-replace';
import { SettingsView } from './settings-view';
import { LogPanel } from './log-panel';
import { AboutDialog } from './about-dialog';
import type { WorkbookModel } from '@shared/types';

const root = document.getElementById('app')!;

const titleBarEl = document.createElement('div');
titleBarEl.id = 'titlebar';
titleBarEl.className = 'titlebar';
root.appendChild(titleBarEl);

const layoutEl = document.createElement('div');
layoutEl.id = 'layout-root';
root.appendChild(layoutEl);

let activeView: WorkbookView | null = null;
let connected = false;
let writesEnabled = false;
let sidebarVisible = true;

const titleBar = new TitleBar(titleBarEl, {
  onToggleSidebar: () => toggleSidebar(),
  onConnect: () => toggleConnect(),
  onWrites: () => toggleWrites(),
  onAbout: () => aboutDialog.show(),
});
titleBar.render();

const aboutDialog = new AboutDialog();

const layout = new w2layout({
  name: 'layout',
  panels: [
    { type: 'left', size: 280, resizable: true, minSize: 220 },
    { type: 'main', size: '70%' },
    { type: 'bottom', size: 140, resizable: true, minSize: 60 },
  ],
});
layout.render('#layout-root');

layout.html('left', '<div id="sidebar-host" style="width:100%;height:100%;"></div>');
const sidebarHost = document.getElementById('sidebar-host')!;
const sidebar = new Sidebar(sidebarHost, {
  onNew: () => newWorkbook(),
  onOpen: () => openWorkbook(),
  onSave: () => saveWorkbook(false),
  onSaveAs: () => saveWorkbook(true),
  onSheetSelect: (name) => {
    if (!activeView) return;
    const idx = activeView.model.sheets.findIndex((s) => s.name === name);
    if (idx < 0) return;
    showWorkbook();
    activeView.activeSheetIndex = idx;
    activeView.render();
    sidebar.setActiveSheet(name);
  },
  onShowSettings: (tab) => showSettings(tab),
});
void sidebar.init();

// w2layout.html() accepts strings or w2ui widgets — *not* DOM nodes (passing one
// coerces to '[object HTMLDivElement]'). We inject a placeholder string then
// query the element back out to use as a mount point.
layout.html(
  'main',
  '<div id="main-host" style="width:100%;height:100%;display:flex;flex-direction:column;">' +
    '<div style="margin:auto;color:var(--fg-muted)">Open a workbook to get started.</div>' +
    '</div>',
);
const mainHost = document.getElementById('main-host')!;

layout.html(
  'bottom',
  '<div id="log-host" style="width:100%;height:100%;"></div>',
);
const logHost = document.getElementById('log-host')!;
const logPanel = new LogPanel(logHost);
void logPanel.mount();

const findDialog = new FindReplaceDialog(() => activeView);
const settingsView = new SettingsView(mainHost, {
  onConfigChanged: () => void sidebar.refreshConfig(),
});
let inSettings = false;

window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;
  switch (e.key.toLowerCase()) {
    case 's':
      e.preventDefault();
      saveWorkbook(e.shiftKey);
      break;
    case 'o':
      e.preventDefault();
      openWorkbook();
      break;
    case 'n':
      e.preventDefault();
      newWorkbook();
      break;
    case 'f':
      e.preventDefault();
      findDialog.show();
      break;
    case 'z':
      if (activeView) {
        e.preventDefault();
        activeView.performUndo();
      }
      break;
    case 'y':
      if (activeView) {
        e.preventDefault();
        activeView.performRedo();
      }
      break;
  }
});

window.addEventListener('resize', () => layout.resize());

window.api
  .invoke('app:ping')
  .then((r) => console.log('[ipc] ping ok', r))
  .catch((e) => console.error('[ipc] ping failed', e));

// Phase 4: receive cell-update pushes from the main process (driven by the
// Modbus poll engine recomputing volatile formulas).
window.api.on('cell:update', (payload) => {
  if (!activeView) return;
  // The wildcard "sheet=*" form is a cycle marker (start-of-batch); ignore.
  if (payload.sheet === '*') return;
  activeView.applyPushedChange(
    payload.sheet,
    payload.address,
    payload.value,
    payload.status === 'error',
  );
});

window.api.on('modbus:status', (payload) => {
  console.log('[modbus] status', payload);
  titleBar.setConnected?.(payload.connected);
});

// `log:append` is consumed by LogPanel; nothing to do here.

function toggleSidebar(): void {
  sidebarVisible = !sidebarVisible;
  if (sidebarVisible) {
    layout.show('left', true);
  } else {
    layout.hide('left', true);
  }
}

function newWorkbook(): void {
  const model: WorkbookModel = {
    filePath: null,
    fileName: 'Untitled.xlsx',
    modifiedAt: null,
    sheets: [
      {
        name: 'Sheet1',
        cells: {},
        mergedRanges: [],
        rowCount: 100,
        columnCount: 26,
      },
    ],
    legacyXls: false,
  };
  loadWorkbook(model);
}

async function openWorkbook(): Promise<void> {
  const dlg = await window.api.invoke('workbook:openDialog');
  if (!dlg) return;
  try {
    const model = await window.api.invoke('workbook:open', { filePath: dlg.filePath });
    loadWorkbook(model);
  } catch (err) {
    console.error('[open] failed', err);
    alert('Failed to open workbook: ' + (err instanceof Error ? err.message : String(err)));
  }
}

function loadWorkbook(model: WorkbookModel): void {
  if (activeView) activeView.destroy();
  inSettings = false;
  mainHost.innerHTML = '';
  activeView = new WorkbookView(model, mainHost, (dirty) => titleBar.setDirty(dirty));
  activeView.render();
  titleBar.setFile(model.fileName + (model.legacyXls ? ' (legacy .xls — Save As .xlsx)' : ''), model.modifiedAt);
  sidebar.setWorkbook(model, model.sheets[0]?.name ?? null);
}

async function saveWorkbook(forceDialog: boolean): Promise<void> {
  if (!activeView) return;
  let filePath = activeView.model.filePath;
  if (forceDialog || !filePath || activeView.model.legacyXls) {
    const dlg = await window.api.invoke('workbook:saveAsDialog', {
      suggestedName: activeView.model.fileName.replace(/\.(xls|csv)$/i, '.xlsx'),
    });
    if (!dlg) return;
    filePath = dlg.filePath;
  }
  try {
    const result = await window.api.invoke('workbook:save', {
      filePath,
      workbook: { ...activeView.model, filePath },
    });
    activeView.model.filePath = filePath;
    activeView.model.modifiedAt = result.modifiedAt;
    activeView.model.legacyXls = false;
    const fileName = filePath.split(/[\\/]/).pop() ?? activeView.model.fileName;
    activeView.model.fileName = fileName;
    activeView.setSaved();
    titleBar.setFile(activeView.model.fileName, result.modifiedAt);
    sidebar.setWorkbook(activeView.model, activeView.model.sheets[activeView.activeSheetIndex]?.name ?? null);
  } catch (err) {
    console.error('[save] failed', err);
    alert('Failed to save workbook: ' + (err instanceof Error ? err.message : String(err)));
  }
}

// ---- Settings <-> Workbook view toggling ----

async function showSettings(tab: 'servers' | 'diagnostics'): Promise<void> {
  // Tear down workbook view (the w2grid lives inside mainHost) so SettingsView
  // can fully take over the main panel.
  if (activeView && !inSettings) activeView.destroy();
  inSettings = true;
  await settingsView.show(tab);
}

function showWorkbook(): void {
  if (!inSettings) return;
  inSettings = false;
  mainHost.innerHTML = '';
  if (activeView) activeView.render();
  else {
    mainHost.innerHTML =
      '<div style="margin:auto;color:var(--fg-muted);display:flex;align-items:center;justify-content:center;height:100%;">Open a workbook to get started.</div>';
  }
}

// ---- Modbus connect / writes ----

async function toggleConnect(): Promise<void> {
  try {
    if (connected) {
      await window.api.invoke('modbus:disconnect');
      connected = false;
    } else {
      await window.api.invoke('modbus:connect');
      connected = true;
    }
    titleBar.setConnected(connected);
  } catch (err) {
    console.error('[modbus] toggle failed', err);
    alert('Modbus toggle failed: ' + (err instanceof Error ? err.message : String(err)));
  }
}

async function toggleWrites(): Promise<void> {
  writesEnabled = !writesEnabled;
  await window.api.invoke('modbus:setWritesEnabled', { enabled: writesEnabled });
}

// ---- Autosave shadow files ----
//
// Every AUTOSAVE_INTERVAL_MS, if a workbook is open and dirty, push the model
// to the main process which writes a sidecar `<file>.plcsheets-shadow<ext>`.
// We deliberately *don't* clear the dirty flag — the user's actual save still
// has to happen via Ctrl+S; this is purely a crash-recovery hint.

const AUTOSAVE_INTERVAL_MS = 30_000;
let autosaving = false;

setInterval(async () => {
  if (autosaving || !activeView || !activeView.dirty || !activeView.model.filePath) return;
  autosaving = true;
  try {
    const r = await window.api.invoke('workbook:autosave', {
      filePath: activeView.model.filePath,
      workbook: activeView.model,
    });
    console.log('[autosave]', r.shadowPath, r.modifiedAt);
  } catch (err) {
    console.warn('[autosave] failed', err);
  } finally {
    autosaving = false;
  }
}, AUTOSAVE_INTERVAL_MS);
