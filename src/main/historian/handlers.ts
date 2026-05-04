/**
 * IPC handlers for the historian feature.
 */

import type { HistorianDB } from './db';
import { queryTag } from './query';

let activeDB: HistorianDB | null = null;

export function setActiveHistorianDB(db: HistorianDB | null): void {
  activeDB = db;
}

export async function handleHistoryQuery(payload: {
  tag: string;
  startTs: number;
  endTs: number;
  maxPoints?: number;
}): Promise<{ tag: string; points: { ts: number; value: number | boolean | null }[] }> {
  if (!activeDB || !activeDB.isOpen()) {
    return { tag: payload.tag, points: [] };
  }
  const entry = activeDB.getTag(payload.tag);
  if (!entry) {
    return { tag: payload.tag, points: [] };
  }
  const points = await queryTag(activeDB, entry.id, payload.startTs, payload.endTs, payload.maxPoints);
  return { tag: payload.tag, points };
}

export function handleHistoryTagList(): { tags: { id: number; name: string }[] } {
  if (!activeDB || !activeDB.isOpen()) {
    return { tags: [] };
  }
  return { tags: activeDB.getAllTags() };
}
