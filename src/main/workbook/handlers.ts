/**
 * Workbook IPC handlers.
 *
 * Maintains a per-file `WorkbookSession` that owns the in-memory model and
 * its HyperFormula host. Edits flow through `handleEditCell` so HF can
 * recalc and return downstream change deltas to the renderer.
 */

import { dialog, BrowserWindow } from 'electron';
import path from 'node:path';
import { openWorkbook, saveWorkbook, closeWorkbook } from './io';
import { idFromPath, putSession, getSession, removeSession } from './state';
import { createFormulaHost } from '../formula/host';
import type { WorkbookModel } from '../../shared/types';

const FILTERS = [
  { name: 'Spreadsheet', extensions: ['xlsx', 'xlsm', 'xls', 'csv'] },
  { name: 'All files', extensions: ['*'] },
];

export async function handleOpenDialog(): Promise<{ filePath: string } | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: FILTERS });
  if (result.canceled || result.filePaths.length === 0) return null;
  return { filePath: result.filePaths[0]! };
}

export async function handleSaveAsDialog(suggestedName?: string): Promise<{ filePath: string } | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = await dialog.showSaveDialog(win!, {
    defaultPath: suggestedName ?? 'workbook.xlsx',
    filters: [
      { name: 'Excel Workbook', extensions: ['xlsx'] },
      { name: 'Excel Macro-Enabled Workbook', extensions: ['xlsm'] },
      { name: 'CSV', extensions: ['csv'] },
    ],
  });
  if (result.canceled || !result.filePath) return null;
  return { filePath: result.filePath };
}

export async function handleOpen(filePath: string): Promise<WorkbookModel> {
  const prior = getSession(idFromPath(filePath));
  prior?.formula?.destroy();

  // Long-running workbook opens (large .xlsx, thousands of formulas, named
  // ranges) can keep the main process busy for several seconds. We surface
  // staged progress so the renderer can display an overlay, and we yield
  // (await a setImmediate) between phases so the IPC events actually flush
  // to the renderer instead of all arriving at once when the work finishes.
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const sendProgress = (stage: string, pct: number, done = false): void => {
    try {
      win?.webContents.send('workbook:openProgress', { filePath, stage, pct, done });
    } catch {
      /* window closed mid-load */
    }
  };
  const yieldTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  sendProgress('Reading file…', 5);
  await yieldTick();

  const { model } = await openWorkbook(filePath);

  sendProgress('Building formula engine…', 60);
  await yieldTick();

  const formula = createFormulaHost(model);

  sendProgress('Finalizing…', 95);
  await yieldTick();

  putSession({
    id: idFromPath(filePath),
    filePath,
    model,
    dirty: false,
    autosaveShadow: null,
    formula,
  });

  sendProgress('Done', 100, true);
  return model;
}

export async function handleSave(filePath: string, model: WorkbookModel): Promise<{ modifiedAt: string }> {
  const sessionId = idFromPath(model.filePath ?? filePath);
  const existing = getSession(sessionId);
  existing?.formula?.syncCachedValues();

  const originalPath = existing?.filePath ?? null;
  const result = await saveWorkbook(filePath, model, originalPath);

  if (existing && existing.filePath !== filePath) {
    removeSession(sessionId);
  }
  putSession({
    id: idFromPath(filePath),
    filePath,
    model: { ...model, filePath, fileName: path.basename(filePath), modifiedAt: result.modifiedAt },
    dirty: false,
    autosaveShadow: null,
    formula: existing?.formula ?? createFormulaHost(model),
  });
  return result;
}

export function handleClose(filePath: string): { ok: true } {
  const id = idFromPath(filePath);
  const s = getSession(id);
  s?.formula?.destroy();
  removeSession(id);
  closeWorkbook(filePath);
  return { ok: true };
}

export function handleEditCell(
  filePath: string,
  sheet: string,
  address: string,
  raw: string,
): { changes: { sheet: string; address: string; value: unknown; errored?: boolean }[] } {
  const s = getSession(idFromPath(filePath));
  if (!s || !s.formula) {
    console.warn('[editCell] no session/formula host for', filePath);
    return { changes: [] };
  }
  s.dirty = true;
  try {
    const changes = s.formula.applyEdit(sheet, address, raw);
    console.log('[editCell]', sheet, address, JSON.stringify(raw), '->', changes.length, 'changes:', JSON.stringify(changes));
    return { changes };
  } catch (err) {
    console.error('[editCell] applyEdit threw:', err);
    return { changes: [] };
  }
}

/**
 * Write a sidecar autosave file next to the user's workbook so a crash mid-edit
 * doesn't lose work. The shadow path is `<file>.plcsheets-shadow<ext>` so it
 * preserves the source format (xlsx/xlsm/csv). The renderer drives this on a
 * timer; the main side just persists what it's handed.
 */
export async function handleAutosave(
  filePath: string,
  model: WorkbookModel,
): Promise<{ shadowPath: string; modifiedAt: string }> {
  // Sync HF cached values into the model first so the shadow reflects last
  // computed results (matches handleSave's behaviour).
  const sessionId = idFromPath(filePath);
  const s = getSession(sessionId);
  s?.formula?.syncCachedValues();

  const ext = path.extname(filePath) || '.xlsx';
  const base = filePath.slice(0, filePath.length - ext.length);
  const shadowPath = `${base}.plcsheets-shadow${ext}`;

  const result = await saveWorkbook(shadowPath, model, filePath);
  if (s) s.autosaveShadow = shadowPath;
  return { shadowPath, modifiedAt: result.modifiedAt };
}
