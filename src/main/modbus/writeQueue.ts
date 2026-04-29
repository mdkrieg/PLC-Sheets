/**
 * Pending-write queue for an interface.
 *
 * MODBUS_WRITE_REGISTER / MODBUS_WRITE_COIL push entries here; a worker
 * drains them serially (at most one outstanding per interface) and emits
 * a log entry on success/failure.
 *
 * Phase 4 keeps this minimal: no readback verification yet, and writes are
 * gated only by the global "writes enabled" flag in the manager.
 */

import type { ReadSource } from './readSource';
import type { AddressKind } from '../../shared/types';
import { log } from './logBus';

export interface WriteRequest {
  kind: AddressKind; // holding | coil
  offset: number;
  value: number | boolean;
}

export class WriteQueue {
  private q: WriteRequest[] = [];
  private busy = false;

  constructor(
    private readonly name: string,
    private readonly source: ReadSource,
  ) {}

  enqueue(req: WriteRequest): void {
    this.q.push(req);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.q.length > 0) {
        const req = this.q.shift()!;
        try {
          if (req.kind === 'holding') {
            await this.source.writeRegister(req.offset, Number(req.value));
          } else if (req.kind === 'coil') {
            await this.source.writeCoil(req.offset, Boolean(req.value));
          } else {
            throw new Error(`cannot write to ${req.kind}`);
          }
          log('info', `write:${this.name}`, `${req.kind}@${req.offset} = ${req.value}`);
        } catch (err) {
          log('error', `write:${this.name}`, `${req.kind}@${req.offset} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
