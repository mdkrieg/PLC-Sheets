/**
 * Typed IPC contract between Electron main and renderer.
 *
 * All channels are namespaced; payloads are explicit so both sides share one
 * source of truth. The preload exposes a thin `window.api.invoke(channel, payload)`
 * wrapper; the main process registers handlers in `src/main/ipc/registry.ts`.
 */

import type { AppConfig, LogEntry, WorkbookModel } from './types';

export interface IpcRequestMap {
  'app:ping': { payload: void; result: { pong: true; version: string } };
  'app:about': {
    payload: void;
    result: {
      productName: string;
      version: string;
      electronVersion: string;
      nodeVersion: string;
      chromeVersion: string;
      platform: string;
      attributions: { name: string; license: string; url?: string }[];
    };
  };
  'app:openExternal': { payload: { url: string }; result: { ok: true } };

  'workbook:open': { payload: { filePath: string }; result: WorkbookModel };
  'workbook:save': { payload: { filePath: string; workbook: WorkbookModel }; result: { modifiedAt: string } };
  'workbook:openDialog': { payload: void; result: { filePath: string } | null };
  'workbook:saveAsDialog': { payload: { suggestedName?: string }; result: { filePath: string } | null };
  'workbook:close': { payload: { filePath: string }; result: { ok: true } };
  'workbook:editCell': {
    payload: { filePath: string; sheet: string; address: string; raw: string };
    result: { changes: { sheet: string; address: string; value: unknown; errored?: boolean }[] };
  };
  'workbook:autosave': {
    payload: { filePath: string; workbook: WorkbookModel };
    result: { shadowPath: string; modifiedAt: string };
  };

  'config:get': { payload: void; result: AppConfig };
  'config:set': { payload: { config: AppConfig }; result: { ok: true } };
  'config:export': { payload: { filePath: string }; result: { ok: true } };
  'config:import': { payload: { filePath: string }; result: AppConfig };

  'modbus:connect': { payload: void; result: { ok: true } };
  'modbus:disconnect': { payload: void; result: { ok: true } };
  'modbus:setWritesEnabled': { payload: { enabled: boolean }; result: { ok: true } };
  'modbus:manualFailover': { payload: { interfaceName: string }; result: { ok: true } };

  'log:list': { payload: void; result: LogEntry[] };
  'log:clear': { payload: void; result: { ok: true } };
}

export type IpcChannel = keyof IpcRequestMap;

export type IpcPayload<C extends IpcChannel> = IpcRequestMap[C]['payload'];
export type IpcResult<C extends IpcChannel> = IpcRequestMap[C]['result'];

/** Push (main -> renderer) events; subscribed via window.api.on(). */
export interface IpcEventMap {
  'log:append': LogEntry;
  /** A cell's value changed because of poll/recalc; renderer refreshes */
  'cell:update': { sheet: string; address: string; value: unknown; status?: 'ok' | 'stale' | 'error' };
  /** Modbus connection status changed for a server or redundant pair */
  'modbus:status': { source: string; connected: boolean; activeServer?: string };
  /**
   * Long-running workbook open progress. `stage` is a short label, `pct` is
   * 0..100 (or -1 for indeterminate), `done=true` signals the final tick so
   * the renderer can dismiss the overlay before the `workbook:open` invoke
   * resolves.
   */
  'workbook:openProgress': {
    filePath: string;
    stage: string;
    pct: number;
    done?: boolean;
  };
}

export type IpcEvent = keyof IpcEventMap;
