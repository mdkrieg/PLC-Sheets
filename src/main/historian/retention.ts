/**
 * Retention manager: hourly deletion of records older than the configured
 * retention window.
 */

import type { HistorianDB } from './db';

const HOUR_MS = 60 * 60 * 1000;
const BATCH_SIZE = 500; // delete keys in chunks to avoid large batches

export function startRetention(db: HistorianDB, retentionDays: number): () => void {
  const run = async (): Promise<void> => {
    if (!db.isOpen()) return;
    const cutoffTs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const tags = db.getAllTags();
    for (const tag of tags) {
      let chunk: Buffer[] = [];
      for await (const key of db.keyScanBefore(tag.id, cutoffTs)) {
        chunk.push(key);
        if (chunk.length >= BATCH_SIZE) {
          await db.deleteBatch(chunk);
          chunk = [];
        }
      }
      if (chunk.length > 0) {
        await db.deleteBatch(chunk);
      }
    }
  };

  const timer = setInterval(() => void run(), HOUR_MS);

  // Return a cleanup function
  return () => clearInterval(timer);
}
