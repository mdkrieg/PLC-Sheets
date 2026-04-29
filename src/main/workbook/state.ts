/**
 * Open-workbook session bookkeeping.
 *
 * Multi-tab is part of the v1 plan; the data layer here supports many
 * concurrently-open workbooks keyed by their filesystem path. The renderer
 * may show only one at a time initially, with multi-tab UI added later.
 */

import type { WorkbookModel } from '../../shared/types';
import type { FormulaHost } from '../formula/host';

export interface WorkbookSession {
  /** Stable id for IPC; derived from filePath, or a generated id for new files */
  id: string;
  filePath: string | null;
  model: WorkbookModel;
  /** True when the in-memory model has unsaved edits */
  dirty: boolean;
  /** Most recent autosave shadow path, if any */
  autosaveShadow: string | null;
  /** Per-workbook formula engine; null for legacy .xls (read-only) */
  formula: FormulaHost | null;
}

const sessions = new Map<string, WorkbookSession>();

export function putSession(s: WorkbookSession): void {
  sessions.set(s.id, s);
}

export function getSession(id: string): WorkbookSession | undefined {
  return sessions.get(id);
}

export function removeSession(id: string): void {
  sessions.delete(id);
}

export function listSessions(): WorkbookSession[] {
  return Array.from(sessions.values());
}

export function idFromPath(filePath: string): string {
  return filePath;
}
