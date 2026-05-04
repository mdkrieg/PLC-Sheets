/**
 * LevelDB wrapper for the data historian.
 *
 * Key format: fixed-width big-endian binary
 *   [ 4 bytes: tagId uint32 BE ][ 8 bytes: timestamp uint64 BE (Unix ms) ]
 *
 * This layout ensures lexicographic order == chronological order per tag,
 * making range scans trivially efficient.
 *
 * Tag registry is persisted as a JSON sidecar file next to the LevelDB
 * directory so it is human-readable and survives compaction intact.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { ClassicLevel } from 'classic-level';

export interface TagEntry {
  id: number;
  name: string;
}

export interface HistoryPoint {
  ts: number;
  value: number | boolean | null;
}

export class HistorianDB {
  private db: ClassicLevel<Buffer, Buffer> | null = null;
  private registry: Map<string, TagEntry> = new Map();
  private nextId = 1;
  private histDir = '';
  private registryPath = '';

  async open(histDir: string): Promise<void> {
    this.histDir = histDir;
    this.registryPath = histDir + '-registry.json';

    await this.loadRegistry();

    this.db = new ClassicLevel<Buffer, Buffer>(histDir, {
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
    });
    await this.db.open();
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  isOpen(): boolean {
    return this.db !== null;
  }

  // ---- Tag registry -------------------------------------------------------

  /** Returns the existing entry or creates a new one. Persists on new registration. */
  async resolveTag(name: string): Promise<TagEntry> {
    const existing = this.registry.get(name);
    if (existing) return existing;
    const entry: TagEntry = { id: this.nextId++, name };
    this.registry.set(name, entry);
    await this.saveRegistry();
    return entry;
  }

  getTag(name: string): TagEntry | undefined {
    return this.registry.get(name);
  }

  getAllTags(): TagEntry[] {
    return Array.from(this.registry.values());
  }

  // ---- Key encoding -------------------------------------------------------

  encodeKey(tagId: number, tsMs: number): Buffer {
    const buf = Buffer.allocUnsafe(12);
    buf.writeUInt32BE(tagId, 0);
    // JS BigInt needed for 64-bit write without loss
    buf.writeBigUInt64BE(BigInt(tsMs), 4);
    return buf;
  }

  decodeKey(buf: Buffer): { tagId: number; tsMs: number } {
    const tagId = buf.readUInt32BE(0);
    const tsMs = Number(buf.readBigUInt64BE(4));
    return { tagId, tsMs };
  }

  encodeValue(value: number | boolean | null): Buffer {
    // Format: 1-byte type tag + payload
    // 0x00 = null, 0x01 = boolean (1 byte), 0x02 = float64 (8 bytes)
    if (value === null || value === undefined) {
      return Buffer.from([0x00]);
    }
    if (typeof value === 'boolean') {
      return Buffer.from([0x01, value ? 0x01 : 0x00]);
    }
    const buf = Buffer.allocUnsafe(9);
    buf[0] = 0x02;
    buf.writeDoubleBE(value, 1);
    return buf;
  }

  decodeValue(buf: Buffer): number | boolean | null {
    if (buf.length === 0) return null;
    const type = buf[0];
    if (type === 0x00) return null;
    if (type === 0x01) return buf[1] !== 0;
    if (type === 0x02) return buf.readDoubleBE(1);
    return null;
  }

  // ---- Reads ---------------------------------------------------------------

  /**
   * Find the last recorded point strictly before `beforeTs`.
   * Used to anchor the left edge of a query window when on-change storage
   * means there may be no record inside the window itself.
   */
  async lookBack(tagId: number, beforeTs: number): Promise<HistoryPoint | null> {
    if (!this.db) return null;
    const iter = this.db.iterator<Buffer, Buffer>({
      lt: this.encodeKey(tagId, beforeTs),
      gte: this.encodeKey(tagId, 0),
      reverse: true,
      limit: 1,
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
    });
    try {
      for await (const [k, v] of iter) {
        const { tagId: tid, tsMs } = this.decodeKey(k);
        if (tid !== tagId) break;
        return { ts: tsMs, value: this.decodeValue(v) };
      }
    } finally {
      await iter.close();
    }
    return null;
  }

  /**
   * Async iterable range scan over [startTs, endTs] for a single tag.
   */
  async *rangeScan(tagId: number, startTs: number, endTs: number): AsyncIterable<HistoryPoint> {
    if (!this.db) return;
    const iter = this.db.iterator<Buffer, Buffer>({
      gte: this.encodeKey(tagId, startTs),
      lte: this.encodeKey(tagId, endTs),
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
    });
    try {
      for await (const [k, v] of iter) {
        const { tagId: tid, tsMs } = this.decodeKey(k);
        if (tid !== tagId) break;
        yield { ts: tsMs, value: this.decodeValue(v) };
      }
    } finally {
      await iter.close();
    }
  }

  /**
   * Async iterable key-only scan: used by retention to find old keys to delete.
   */
  async *keyScanBefore(tagId: number, beforeTs: number): AsyncIterable<Buffer> {
    if (!this.db) return;
    const iter = this.db.iterator<Buffer, Buffer>({
      gte: this.encodeKey(tagId, 0),
      lt: this.encodeKey(tagId, beforeTs),
      keys: true,
      values: false,
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
    });
    try {
      for await (const [k] of iter) {
        const { tagId: tid } = this.decodeKey(k);
        if (tid !== tagId) break;
        yield k;
      }
    } finally {
      await iter.close();
    }
  }

  // ---- Writes --------------------------------------------------------------

  /** Batch write. ops is an array of { key, value } pairs. */
  async writeBatch(ops: { key: Buffer; value: Buffer }[]): Promise<void> {
    if (!this.db || ops.length === 0) return;
    const batch = this.db.batch();
    for (const op of ops) {
      batch.put(op.key, op.value);
    }
    await batch.write();
  }

  /** Batch delete. keys is an array of raw key Buffers. */
  async deleteBatch(keys: Buffer[]): Promise<void> {
    if (!this.db || keys.length === 0) return;
    const batch = this.db.batch();
    for (const k of keys) {
      batch.del(k);
    }
    await batch.write();
  }

  // ---- Registry persistence -----------------------------------------------

  private async loadRegistry(): Promise<void> {
    try {
      const raw = await fs.readFile(this.registryPath, 'utf8');
      const entries = JSON.parse(raw) as TagEntry[];
      this.registry.clear();
      let maxId = 0;
      for (const e of entries) {
        this.registry.set(e.name, e);
        if (e.id > maxId) maxId = e.id;
      }
      this.nextId = maxId + 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Corrupt registry: start fresh (data is not lost, just tag names)
        console.error('[historian] registry load failed, starting fresh:', (err as Error).message);
      }
      this.registry.clear();
      this.nextId = 1;
    }
  }

  private async saveRegistry(): Promise<void> {
    const entries = Array.from(this.registry.values());
    await fs.writeFile(this.registryPath, JSON.stringify(entries, null, 2), 'utf8');
  }
}
