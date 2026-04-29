/**
 * Centralized registry for IPC handlers.
 *
 * Each phase appends its handlers here, keeping `main/index.ts` thin.
 * Handlers are registered against the channel names defined in
 * `src/shared/ipc.ts` so the type contract is enforced at the call site.
 */

import { ipcMain, app } from 'electron';
import type { IpcChannel, IpcPayload, IpcResult } from '../../shared/ipc';
import { handleOpen, handleOpenDialog, handleSave, handleSaveAsDialog, handleClose, handleEditCell, handleAutosave } from '../workbook/handlers';
import { handleAppAbout, handleOpenExternal } from '../app/handlers';
import {
  handleConfigGet,
  handleConfigSet,
  handleConfigExport,
  handleConfigImport,
  handleModbusConnect,
  handleModbusDisconnect,
  handleModbusSetWritesEnabled,
  handleModbusManualFailover,
  handleLogList,
  handleLogClear,
  scheduleVolatileRecompute,
} from '../modbus/handlers';
import { modbusManager } from '../modbus/manager';

type Handler<C extends IpcChannel> = (payload: IpcPayload<C>) => Promise<IpcResult<C>> | IpcResult<C>;

function handle<C extends IpcChannel>(channel: C, fn: Handler<C>): void {
  ipcMain.handle(channel, async (_event, payload) => fn(payload as IpcPayload<C>));
}

export function registerIpcHandlers(): void {
  // Phase 1: bridge sanity check.
  handle('app:ping', () => ({ pong: true, version: app.getVersion() }));

  // Phase 7: About dialog metadata + safe external link opener.
  handle('app:about', () => handleAppAbout());
  handle('app:openExternal', (p) => handleOpenExternal(p.url));

  // Phase 2: workbook I/O.
  handle('workbook:openDialog', () => handleOpenDialog());
  handle('workbook:saveAsDialog', (p) => handleSaveAsDialog(p.suggestedName));
  handle('workbook:open', (p) => handleOpen(p.filePath));
  handle('workbook:save', (p) => handleSave(p.filePath, p.workbook));
  handle('workbook:close', (p) => handleClose(p.filePath));

  // Phase 3: incremental cell-edit recalc through HyperFormula.
  handle('workbook:editCell', (p) => handleEditCell(p.filePath, p.sheet, p.address, p.raw));

  // Phase 6: autosave shadow file.
  handle('workbook:autosave', (p) => handleAutosave(p.filePath, p.workbook));

  // Phase 4: configuration persistence.
  handle('config:get', () => handleConfigGet());
  handle('config:set', (p) => handleConfigSet(p.config));
  handle('config:export', (p) => handleConfigExport(p.filePath));
  handle('config:import', (p) => handleConfigImport(p.filePath));

  // Phase 4: Modbus connect / writes / failover.
  handle('modbus:connect', () => handleModbusConnect());
  handle('modbus:disconnect', () => handleModbusDisconnect());
  handle('modbus:setWritesEnabled', (p) => handleModbusSetWritesEnabled(p.enabled));
  handle('modbus:manualFailover', (p) => handleModbusManualFailover(p.interfaceName));

  // Phase 4: log inspection.
  handle('log:list', () => handleLogList());
  handle('log:clear', () => handleLogClear());

  // Drive volatile-formula recompute whenever any poll cache updates.
  modbusManager.setUpdateListener(() => scheduleVolatileRecompute());
}

