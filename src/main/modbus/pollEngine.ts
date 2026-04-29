/**
 * Per-interface poll engine.
 *
 * Owns the *value cache* for a logical "interface" (one read source + read
 * settings). MODBUS_READ_REGISTER / MODBUS_READ_COIL ultimately resolve to
 * lookups against this cache.
 *
 * Workflow
 * --------
 * 1. Subscribers register `(kind, offset)` pairs they care about. (For a
 *    32-bit datatype the manager registers two consecutive offsets.)
 * 2. The engine recomputes "blocks" (contiguous runs of registered
 *    addresses) according to the configured BlockStrategy and starts a poll
 *    loop. Each tick: one block is read; the result is sliced into the
 *    word/coil cache; subscribers are notified via `onUpdate`.
 * 3. Datatype decoding (int16, float32, ascii, ...) happens in the manager
 *    when reading the cache, so the engine itself only stores raw words/bits.
 *
 * Block strategies implemented in this first cut:
 *   - none:    every subscribed address is its own 1-length block
 *   - auto:    contiguous runs grouped into blocks bounded by maxSize
 * `uniform` and `manual` are accepted but degrade to `auto` until Phase 6.
 */

import type {
  AddressKind,
  BlockStrategy,
  InterfaceConfig,
} from '../../shared/types';
import type { ReadSource } from './readSource';
import { log } from './logBus';

interface Block {
  kind: AddressKind;
  start: number; // 0-based offset
  length: number;
}

type CacheKey = string; // `${kind}:${offset}`
const cacheKey = (kind: AddressKind, offset: number): CacheKey => `${kind}:${offset}`;

export type WordCache = Map<CacheKey, { value: number | boolean; at: number; stale?: boolean }>;

export interface PollEngineEvents {
  /** Called when one or more cached values have updated. */
  onUpdate(): void;
}

export class PollEngine {
  private cache: WordCache = new Map();
  private subs = new Map<CacheKey, { kind: AddressKind; offset: number }>();
  private blocks: Block[] = [];
  private timer: NodeJS.Timeout | null = null;
  private cycleIdx = 0;
  private running = false;

  constructor(
    private readonly cfg: InterfaceConfig,
    private readonly source: ReadSource,
    private readonly events: PollEngineEvents,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.recomputeBlocks();
    const intervalMs = Math.max(50, Math.round(this.cfg.read.basePollSec * 1000));
    this.timer = setInterval(() => void this.tick(), Math.max(this.cfg.read.minRequestGapMs, intervalMs));
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Add an address to the watch list. Idempotent. */
  subscribe(kind: AddressKind, offset: number): void {
    const k = cacheKey(kind, offset);
    if (!this.subs.has(k)) {
      this.subs.set(k, { kind, offset });
      this.recomputeBlocks();
    }
  }

  getCached(kind: AddressKind, offset: number): number | boolean | undefined {
    return this.cache.get(cacheKey(kind, offset))?.value;
  }

  getCacheEntry(kind: AddressKind, offset: number) {
    return this.cache.get(cacheKey(kind, offset));
  }

  private recomputeBlocks(): void {
    const strategy = this.cfg.read.blockStrategy;
    const subsByKind = new Map<AddressKind, number[]>();
    for (const s of this.subs.values()) {
      const arr = subsByKind.get(s.kind) ?? [];
      arr.push(s.offset);
      subsByKind.set(s.kind, arr);
    }
    const blocks: Block[] = [];
    for (const [kind, offsetsRaw] of subsByKind) {
      const offsets = [...new Set(offsetsRaw)].sort((a, b) => a - b);
      blocks.push(...buildBlocks(kind, offsets, strategy));
    }
    this.blocks = blocks;
  }

  private async tick(): Promise<void> {
    if (this.blocks.length === 0) return;
    const block = this.blocks[this.cycleIdx % this.blocks.length]!;
    this.cycleIdx++;
    try {
      const data = await this.source.read(block.kind, block.start, block.length);
      const now = Date.now();
      for (let i = 0; i < data.length; i++) {
        const k = cacheKey(block.kind, block.start + i);
        const existing = this.cache.get(k);
        const v = data[i] as number | boolean;
        if (!existing || existing.value !== v) {
          this.cache.set(k, { value: v, at: now });
        } else {
          existing.at = now;
          existing.stale = false;
        }
      }
      this.events.onUpdate();
    } catch (err) {
      log(
        'warn',
        `poll:${this.cfg.name}`,
        `block ${block.kind}@${block.start}+${block.length} read failed: ${(err as Error).message}`,
        `pollfail-${this.cfg.name}-${block.kind}-${block.start}-${block.length}`,
      );
      // Mark cached values for this block stale.
      for (let i = 0; i < block.length; i++) {
        const k = cacheKey(block.kind, block.start + i);
        const e = this.cache.get(k);
        if (e) e.stale = true;
      }
      this.events.onUpdate();
    }
  }
}

function buildBlocks(kind: AddressKind, offsets: number[], strategy: BlockStrategy): Block[] {
  if (offsets.length === 0) return [];
  if (strategy.kind === 'none') {
    return offsets.map((o) => ({ kind, start: o, length: 1 }));
  }
  if (strategy.kind === 'manual') {
    return strategy.blocks.filter((b) => b.kind === kind).map((b) => ({ kind, start: b.start, length: b.length }));
  }
  // auto + uniform fall through to contiguous-grouping
  const maxSize =
    strategy.kind === 'auto' ? Math.max(1, strategy.maxSize) : strategy.kind === 'uniform' ? Math.max(1, strategy.size) : 64;
  const out: Block[] = [];
  let runStart = offsets[0]!;
  let runEnd = runStart;
  for (let i = 1; i < offsets.length; i++) {
    const o = offsets[i]!;
    if (o === runEnd + 1 && o - runStart + 1 <= maxSize) {
      runEnd = o;
    } else {
      out.push({ kind, start: runStart, length: runEnd - runStart + 1 });
      runStart = o;
      runEnd = o;
    }
  }
  out.push({ kind, start: runStart, length: runEnd - runStart + 1 });
  return out;
}
