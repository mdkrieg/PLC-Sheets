/**
 * IPC handlers for Modbus + config + log channels.
 *
 * Connecting boots the manager with the persisted AppConfig. Whenever
 * any interface's poll cache updates we recompute volatile formulas across
 * every open workbook and push the resulting cell deltas to renderers via
 * `cell:update`.
 */

import { BrowserWindow, app, dialog } from 'electron';
import path from 'node:path';
import { modbusManager } from '../modbus/manager';
import { listSessions } from '../workbook/state';
import { loadConfig, saveConfig, exportConfigTo, importConfigFrom } from '../config/store';
import { listLog, clearLog } from '../modbus/logBus';
import type { AppConfig } from '../../shared/types';

let configCache: AppConfig | null = null;
let recomputeTimer: NodeJS.Timeout | null = null;

/**
 * Coalesce many cache-update events into a single recompute pass per tick.
 * Renderer is told only about cells whose displayed value actually changed.
 */
export function scheduleVolatileRecompute(): void {
  if (recomputeTimer) return;
  recomputeTimer = setTimeout(() => {
    recomputeTimer = null;
    runVolatileRecompute();
  }, 50);
}

function runVolatileRecompute(): void {
  for (const session of listSessions()) {
    if (!session.formula) continue;
    const changes = session.formula.recomputeVolatile();
    if (changes.length === 0) continue;
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('cell:update', {
        sheet: '*',
        address: session.filePath ?? '',
        value: null,
        status: 'ok',
      });
      // Per-cell payload (renderer keys on filePath via session lookup)
      for (const ch of changes) {
        win.webContents.send('cell:update', {
          sheet: ch.sheet,
          address: ch.address,
          value: ch.value,
          status: ch.errored ? 'error' : 'ok',
        });
      }
    }
  }
}

export async function handleConfigGet(): Promise<AppConfig> {
  if (!configCache) configCache = await loadConfig();
  // Keep the modbus manager aware of the current config even before the user
  // clicks Connect. This lets formula evaluation resolve the default
  // interface name without requiring an active connection.
  modbusManager.setConfig(configCache);
  return configCache;
}

export async function handleConfigSet(cfg: AppConfig): Promise<{ ok: true }> {
  configCache = cfg;
  modbusManager.setConfig(cfg);
  await saveConfig(cfg);
  return { ok: true };
}

export async function handleConfigExport(filePath: string): Promise<{ ok: true }> {
  const cfg = configCache ?? (await loadConfig());
  await exportConfigTo(cfg, filePath);
  return { ok: true };
}

export async function handleConfigImport(filePath: string): Promise<AppConfig> {
  const cfg = await importConfigFrom(filePath);
  configCache = cfg;
  await saveConfig(cfg);
  return cfg;
}

export async function handleModbusConnect(): Promise<{ ok: true }> {
  if (!configCache) configCache = await loadConfig();
  modbusManager.setConfig(configCache);
  await modbusManager.connect();
  return { ok: true };
}

export async function handleModbusDisconnect(): Promise<{ ok: true }> {
  await modbusManager.disconnect();
  return { ok: true };
}

export function handleModbusSetWritesEnabled(enabled: boolean): { ok: true } {
  modbusManager.setWritesEnabled(enabled);
  return { ok: true };
}

export function handleModbusManualFailover(interfaceName: string): { ok: true } {
  modbusManager.manualFailover(interfaceName);
  return { ok: true };
}

export function handleLogList() {
  return listLog();
}

export function handleLogClear(): { ok: true } {
  clearLog();
  return { ok: true };
}

export async function pickConfigFileForExport(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win) return null;
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), 'plc-sheets-config.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  return r.canceled ? null : (r.filePath ?? null);
}
