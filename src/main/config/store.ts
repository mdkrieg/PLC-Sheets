/**
 * Persistent app configuration store.
 *
 * For Phase 4 we use a simple JSON file in `app.getPath('userData')`. A full
 * zod schema + electron-store integration is queued for Phase 5; the shape
 * here is intentionally identical to `AppConfig` so that swap is a no-op.
 *
 * Validation on load is best-effort: missing keys fall back to defaults
 * (empty arrays). Invalid types result in the default config being returned
 * and the bad file being renamed to `.corrupt-<ts>` so the user can recover.
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { AppConfig, HistorianConfig } from '../../shared/types';
import { log } from '../modbus/logBus';

export const DEFAULT_HISTORIAN_CONFIG: HistorianConfig = {
  defaultDeadband: 0,
  defaultHeartbeatSec: 60,
  batchFlushMs: 1000,
  retentionDays: 30,
};

const DEFAULT_CONFIG: AppConfig = {
  servers: [],
  interfaces: [],
  historian: { ...DEFAULT_HISTORIAN_CONFIG },
};

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

export async function loadConfig(): Promise<AppConfig> {
  const p = configPath();
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as AppConfig;
    if (!Array.isArray(parsed.servers) || !Array.isArray(parsed.interfaces)) {
      throw new Error('config shape invalid');
    }
    // Strip any legacy `redundant` key (now folded into InterfaceConfig).
    delete (parsed as unknown as { redundant?: unknown }).redundant;
    // Backfill historian defaults for configs saved before this feature.
    if (!parsed.historian) parsed.historian = { ...DEFAULT_HISTORIAN_CONFIG };
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...DEFAULT_CONFIG };
    }
    log('error', 'config', `load failed: ${(err as Error).message}; using defaults`);
    try {
      await fs.rename(p, `${p}.corrupt-${Date.now()}`);
    } catch {
      /* ignore */
    }
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(cfg: AppConfig): Promise<void> {
  const p = configPath();
  const data = JSON.stringify(cfg, null, 2);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, data, 'utf8');
}

export async function exportConfigTo(cfg: AppConfig, filePath: string): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(cfg, null, 2), 'utf8');
}

export async function importConfigFrom(filePath: string): Promise<AppConfig> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as AppConfig;
  if (!Array.isArray(parsed.servers) || !Array.isArray(parsed.interfaces)) {
    throw new Error('imported config shape invalid');
  }
  delete (parsed as unknown as { redundant?: unknown }).redundant;
  return parsed;
}
