/**
 * Central event log + broadcaster.
 *
 * Holds an in-memory ring buffer of LogEntry items and forwards each new
 * entry to all renderer windows over the `log:append` event. Components
 * (Server, PollEngine, etc.) are expected to push events via `log()`.
 *
 * Deduplication: when an entry has a `dedupKey`, repeats with the same key
 * are silently dropped until `clear()` is called. This is what implements
 * the outline rule "missing-block warnings re-arm only after Clear".
 */

import { BrowserWindow } from 'electron';
import type { LogEntry, LogLevel } from '../../shared/types';

const CAPACITY = 5000;
const buffer: LogEntry[] = [];
const seenKeys = new Set<string>();

function broadcast(entry: LogEntry): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('log:append', entry);
  }
}

export function log(level: LogLevel, source: string, message: string, dedupKey?: string): void {
  if (dedupKey) {
    if (seenKeys.has(dedupKey)) return;
    seenKeys.add(dedupKey);
  }
  const entry: LogEntry = { ts: new Date().toISOString(), level, source, message, dedupKey };
  buffer.push(entry);
  if (buffer.length > CAPACITY) buffer.shift();
  // eslint-disable-next-line no-console
  console.log(`[${level}] ${source}: ${message}`);
  broadcast(entry);
}

export function listLog(): LogEntry[] {
  return buffer.slice();
}

export function clearLog(): void {
  buffer.length = 0;
  seenKeys.clear();
}
