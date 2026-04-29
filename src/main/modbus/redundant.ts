/**
 * Redundant server pair (A/B failover).
 *
 * The PollEngine and WriteQueue see this as a single read/write target; this
 * class chooses which underlying ModbusServer to use and implements the
 * configured failover policy.
 *
 * Redundancy is now configured *inline* on the owning InterfaceConfig
 * (primary + secondary + failover). The pair is identified by the owning
 * interface's name.
 *
 * Supported policies (per outline):
 *   - manual:    user-triggered only
 *   - periodic:  swap every N seconds
 *   - heartbeat: monitor a heartbeat register/coil; swap when it stales
 *   - mismatch:  (placeholder — will compare polled data; not yet wired)
 *
 * Status: 'connected' if either side is up; 'degraded' if only one is up;
 * 'down' if neither.
 */

import type { FailoverPolicy, AddressKind } from '../../shared/types';
import { ModbusServer, type ServerStatus } from './server';
import { log } from './logBus';
import { parseModbusAddress } from '../../shared/address';

export type PairStatus = 'down' | 'degraded' | 'connected';

export class RedundantServer {
  readonly name: string;
  readonly failover: FailoverPolicy;
  readonly a: ModbusServer;
  readonly b: ModbusServer;
  private active: 'a' | 'b' = 'a';
  private periodicTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatLast: { value: number; ts: number } | null = null;

  constructor(name: string, failover: FailoverPolicy, a: ModbusServer, b: ModbusServer) {
    this.name = name;
    this.failover = failover;
    this.a = a;
    this.b = b;
  }

  getActive(): ModbusServer {
    return this.active === 'a' ? this.a : this.b;
  }

  getActiveName(): string {
    return this.active === 'a' ? this.a.config.name : this.b.config.name;
  }

  getStatus(): PairStatus {
    const sa = this.a.getStatus();
    const sb = this.b.getStatus();
    if (sa === 'connected' && sb === 'connected') return 'connected';
    if (sa === 'connected' || sb === 'connected') return 'degraded';
    return 'down';
  }

  serverStatuses(): { a: ServerStatus; b: ServerStatus } {
    return { a: this.a.getStatus(), b: this.b.getStatus() };
  }

  async open(): Promise<void> {
    // Open both in parallel; failure of one is tolerated.
    await Promise.allSettled([this.a.open(), this.b.open()]);
    this.armFailover(this.failover);
  }

  close(): void {
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.periodicTimer = null;
    this.heartbeatTimer = null;
    this.a.close();
    this.b.close();
  }

  manualSwap(): void {
    this.swap('manual');
  }

  private swap(reason: string): void {
    this.active = this.active === 'a' ? 'b' : 'a';
    log('info', `redundant:${this.name}`, `failover -> ${this.getActiveName()} (${reason})`);
  }

  private armFailover(p: FailoverPolicy): void {
    switch (p.kind) {
      case 'manual':
        return;
      case 'periodic':
        this.periodicTimer = setInterval(() => this.swap('periodic'), p.intervalSec * 1000);
        return;
      case 'heartbeat':
        this.heartbeatTimer = setInterval(() => this.checkHeartbeat(p), 1000);
        return;
      case 'mismatch':
        // Wired in PollEngine via mismatch hook (Phase 6 polish).
        return;
    }
  }

  private async checkHeartbeat(
    p: Extract<FailoverPolicy, { kind: 'heartbeat' }>,
  ): Promise<void> {
    try {
      const addr = parseModbusAddress(p.address);
      const data = await this.read(addr.kind, addr.offset, 1);
      const cur = typeof data[0] === 'boolean' ? (data[0] ? 1 : 0) : (data[0] as number);
      const now = Date.now();
      if (this.heartbeatLast === null) {
        this.heartbeatLast = { value: cur, ts: now };
        return;
      }
      const changed =
        p.mode === 'register-incrementing' ? cur !== this.heartbeatLast.value : cur !== this.heartbeatLast.value;
      if (changed) {
        this.heartbeatLast = { value: cur, ts: now };
      } else if (now - this.heartbeatLast.ts > p.staleAfterSec * 1000) {
        this.swap('heartbeat-stale');
        this.heartbeatLast = { value: cur, ts: now };
      }
    } catch (err) {
      log('warn', `redundant:${this.name}`, `heartbeat read failed: ${(err as Error).message}`,
        `hb-${this.name}`);
    }
  }

  /** Try active first; on failure try the standby and swap. */
  async read(kind: AddressKind, offset: number, length: number): Promise<number[] | boolean[]> {
    try {
      return await this.getActive().read(kind, offset, length);
    } catch (err) {
      const standby = this.active === 'a' ? this.b : this.a;
      if (standby.getStatus() === 'connected') {
        this.swap('active-read-failed');
        return standby.read(kind, offset, length);
      }
      throw err;
    }
  }

  async writeRegister(offset: number, value: number): Promise<void> {
    return this.getActive().writeRegister(offset, value);
  }

  async writeCoil(offset: number, state: boolean): Promise<void> {
    return this.getActive().writeCoil(offset, state);
  }
}
