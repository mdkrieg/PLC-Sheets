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
import { HistorianDB } from '../historian/db';
import { HistorianWriter } from '../historian/writer';
import { startRetention } from '../historian/retention';
import { setActiveHistorianDB } from '../historian/handlers';
import { loadConfig } from '../config/store';
import { DEFAULT_HISTORIAN_CONFIG } from '../config/store';

/** Per-workbook historian state, keyed by filePath. */
const historianSessions = new Map<string, {
  db: HistorianDB;
  writer: HistorianWriter;
  stopRetention: () => void;
}>();

/** Active pulse timers keyed by `"${filePath}!${sheet}!${address}"` so a
 *  second button click while the timer is running cancels and restarts the pulse. */
const activePulseTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

  // Open the historian DB for this workbook (non-blocking; errors are logged).
  void (async () => {
    try {
      const histDir = filePath + '.history';
      const db = new HistorianDB();
      await db.open(histDir);

      const cfg = await loadConfig();
      const historianCfg = cfg.historian ?? { ...DEFAULT_HISTORIAN_CONFIG };

      const writer = new HistorianWriter();
      writer.start(db, historianCfg);

      const stopRetention = startRetention(db, historianCfg.retentionDays);

      historianSessions.set(filePath, { db, writer, stopRetention });
      setActiveHistorianDB(db);
      formula.setHistorianWriter(writer);
    } catch (err) {
      console.error('[historian] failed to open for', filePath, (err as Error).message);
    }
  })();

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
  s?.formula?.setHistorianWriter(null);
  s?.formula?.destroy();
  removeSession(id);
  closeWorkbook(filePath);

  // Shut down historian for this workbook
  const hist = historianSessions.get(filePath);
  if (hist) {
    hist.stopRetention();
    void hist.writer.flush().then(() => hist.db.close());
    historianSessions.delete(filePath);
    setActiveHistorianDB(null);
  }

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
 * Handle a UI_BUTTON_SET or UI_BUTTON_PULSE button click from the renderer.
 * Writes `value` to `targetAddress` immediately and, for PULSE, schedules a
 * delayed write of `offValue` after `pulseSeconds` seconds. The delayed write
 * pushes `cell:update` events to all renderer windows so they refresh without
 * waiting for the next poll tick.
 */
export function handleButtonClick(
  filePath: string,
  targetSheet: string,
  targetAddress: string,
  actionType: 'set' | 'pulse',
  value: string,
  offValue?: string,
  pulseSeconds?: number,
): { changes: { sheet: string; address: string; value: unknown; errored?: boolean }[] } {
  const s = getSession(idFromPath(filePath));
  if (!s?.formula) {
    console.warn('[buttonClick] no session for', filePath);
    return { changes: [] };
  }
  s.dirty = true;
  let changes: { sheet: string; address: string; value: unknown; errored?: boolean }[];
  try {
    changes = s.formula.applyEdit(targetSheet, targetAddress, value);
  } catch (err) {
    console.error('[buttonClick] applyEdit threw:', err);
    return { changes: [] };
  }

  if (actionType === 'pulse' && offValue !== undefined && offValue !== '' && (pulseSeconds ?? 1) > 0) {
    const key = `${filePath}!${targetSheet}!${targetAddress}`;
    const existing = activePulseTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      activePulseTimers.delete(key);
      const s2 = getSession(idFromPath(filePath));
      if (!s2?.formula) return;
      s2.dirty = true;
      let offChanges: { sheet: string; address: string; value: unknown; errored?: boolean }[];
      try {
        offChanges = s2.formula.applyEdit(targetSheet, targetAddress, offValue);
      } catch {
        return;
      }
      if (offChanges.length === 0) return;
      for (const win of BrowserWindow.getAllWindows()) {
        for (const ch of offChanges) {
          win.webContents.send('cell:update', {
            sheet: ch.sheet,
            address: ch.address,
            value: ch.value,
            status: ch.errored ? 'error' : 'ok',
          });
        }
      }
    }, (pulseSeconds ?? 1) * 1000);

    activePulseTimers.set(key, timer);
  }

  return { changes };
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
