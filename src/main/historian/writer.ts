/**
 * Historian writer — on-change (exception reporting) logic + batch flush.
 *
 * Each HISTORY_CAPTURE formula cell calls `record()` on every volatile
 * recompute. The writer suppresses redundant samples via deadband and
 * heartbeat, accumulates surviving samples in a ring buffer, and flushes
 * them to LevelDB as a single batch on a configurable interval.
 *
 * The writer also broadcasts `history:point` IPC push events so the trend
 * viewer's Live mode can append new samples in real time.
 */

import { BrowserWindow } from 'electron';
import type { HistorianDB } from './db';
import type { HistorianConfig } from '../../shared/types';

interface TagState {
  tagId: number;
  lastStoredValue: number | boolean | null;
  lastWriteTs: number;
  /** Resolved deadband for this tag (per-formula override or global default) */
  deadband: number;
  /** Resolved heartbeat interval in ms */
  heartbeatMs: number;
}

interface PendingOp {
  key: Buffer;
  value: Buffer;
  /** Tag name — forwarded to IPC event */
  tagName: string;
  ts: number;
  rawValue: number | boolean | null;
}

export class HistorianWriter {
  private db: HistorianDB | null = null;
  private config: HistorianConfig | null = null;
  private tagStates = new Map<number, TagState>();
  private pending: PendingOp[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  /** Exposed for the HISTORY_CAPTURE formula plugin to resolve tag IDs. */
  get activeDB(): HistorianDB | null {
    return this.db;
  }

  start(db: HistorianDB, config: HistorianConfig): void {
    this.db = db;
    this.config = config;
    const intervalMs = Math.max(100, config.batchFlushMs);
    this.flushTimer = setInterval(() => void this.flush(), intervalMs);
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Best-effort flush remaining samples synchronously is not possible
    // (LevelDB is async); caller should await flush() before close.
    this.tagStates.clear();
    this.pending = [];
    this.db = null;
    this.config = null;
  }

  /** Flush any pending samples immediately. Used before close. */
  async flush(): Promise<void> {
    if (!this.db || this.pending.length === 0) return;
    const ops = this.pending.splice(0);
    try {
      await this.db.writeBatch(ops.map((o) => ({ key: o.key, value: o.value })));
      // Broadcast each committed point to all renderer windows
      for (const op of ops) {
        this.broadcastPoint(op.tagName, op.ts, op.rawValue);
      }
    } catch (err) {
      console.error('[historian] flush error:', (err as Error).message);
      // Re-queue on write failure to avoid data loss on transient errors
      this.pending.unshift(...ops);
    }
  }

  /**
   * Called by HISTORY_CAPTURE on each volatile recompute.
   *
   * @param tagName  Resolved tag name (already validated by formula plugin)
   * @param tagId    Numeric tag ID from the registry
   * @param value    Resolved cell value
   * @param ts       Timestamp (recomputeStartTime from FormulaHost)
   * @param deadbandOverride  Per-formula deadband, or undefined to use global default
   * @param heartbeatSecOverride  Per-formula heartbeat, or undefined to use global default
   * @returns  'written' | 'skip-deadband' | 'skip-notopen'
   */
  record(
    tagName: string,
    tagId: number,
    value: number | boolean | null,
    ts: number,
    deadbandOverride: number | undefined,
    heartbeatSecOverride: number | undefined,
  ): 'written' | 'skip-deadband' | 'skip-notopen' {
    if (!this.db || !this.config) return 'skip-notopen';

    const deadband = deadbandOverride ?? this.config.defaultDeadband;
    const heartbeatMs = (heartbeatSecOverride ?? this.config.defaultHeartbeatSec) * 1000;

    let state = this.tagStates.get(tagId);
    if (!state) {
      state = {
        tagId,
        lastStoredValue: undefined as unknown as null, // force first write
        lastWriteTs: 0,
        deadband,
        heartbeatMs,
      };
      this.tagStates.set(tagId, state);
    }

    // Update per-tag settings in case the formula was edited
    state.deadband = deadband;
    state.heartbeatMs = heartbeatMs;

    const shouldWrite = this.exceedsDeadband(value, state.lastStoredValue, deadband)
      || (ts - state.lastWriteTs) >= heartbeatMs;

    if (!shouldWrite) return 'skip-deadband';

    state.lastStoredValue = value;
    state.lastWriteTs = ts;

    this.pending.push({
      key: this.db.encodeKey(tagId, ts),
      value: this.db.encodeValue(value),
      tagName,
      ts,
      rawValue: value,
    });

    return 'written';
  }

  private exceedsDeadband(
    newVal: number | boolean | null,
    oldVal: number | boolean | null,
    deadband: number,
  ): boolean {
    if (oldVal === undefined) return true; // first sample always writes
    if (newVal === null && oldVal === null) return false;
    if (newVal === null || oldVal === null) return true;
    if (typeof newVal === 'boolean' || typeof oldVal === 'boolean') {
      return newVal !== oldVal;
    }
    return Math.abs((newVal as number) - (oldVal as number)) > deadband;
  }

  private broadcastPoint(tagName: string, ts: number, value: number | boolean | null): void {
    const payload = { tag: tagName, ts, value };
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.webContents.send('history:point', payload);
      } catch {
        /* window may have been closed */
      }
    }
  }
}
