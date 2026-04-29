/**
 * Single Modbus TCP server connection.
 *
 * Wraps `modbus-serial` and adds:
 *   - Async connect / disconnect with auto-reconnect on failure
 *   - A serialized request queue so calls to read/write never overlap on a
 *     single TCP connection (modbus-serial expects one outstanding request)
 *   - Configurable per-server addressing base (1-based Modicon vs 0-based)
 *
 * Every read/write returns a Promise; consumers (PollEngine, WriteQueue)
 * await them and translate transport errors into log events.
 */

// modbus-serial ships CommonJS; require it to keep TS-CJS interop simple.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ModbusRTUClass = require('modbus-serial') as new () => ModbusRTUClient;

interface ModbusRTUClient {
  connectTCP(ip: string, options: { port: number }): Promise<void>;
  close(callback?: () => void): void;
  setID(id: number): void;
  setTimeout(duration: number): void;
  isOpen: boolean;
  readCoils(address: number, length: number): Promise<{ data: boolean[] }>;
  readDiscreteInputs(address: number, length: number): Promise<{ data: boolean[] }>;
  readHoldingRegisters(address: number, length: number): Promise<{ data: number[] }>;
  readInputRegisters(address: number, length: number): Promise<{ data: number[] }>;
  writeCoil(address: number, state: boolean): Promise<unknown>;
  writeRegister(address: number, value: number): Promise<unknown>;
}

import type { AddressKind, ServerConfig } from '../../shared/types';
import { log } from './logBus';

export type ServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export class ModbusServer {
  readonly config: ServerConfig;
  private client: ModbusRTUClient;
  private status: ServerStatus = 'disconnected';
  private queue: Promise<unknown> = Promise.resolve();
  private wantOpen = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config: ServerConfig) {
    this.config = config;
    this.client = new ModbusRTUClass();
  }

  getStatus(): ServerStatus {
    return this.status;
  }

  async open(): Promise<void> {
    this.wantOpen = true;
    if (this.status === 'connected' || this.status === 'connecting') return;
    this.status = 'connecting';
    try {
      await this.client.connectTCP(this.config.ip, { port: this.config.port });
      this.client.setID(this.config.deviceId);
      this.client.setTimeout(this.config.timeoutMs);
      this.status = 'connected';
      log('info', `server:${this.config.name}`, `connected to ${this.config.ip}:${this.config.port}`);
    } catch (err) {
      this.status = 'error';
      log('warn', `server:${this.config.name}`, `connect failed: ${(err as Error).message}`);
      this.scheduleReconnect();
      throw err;
    }
  }

  close(): void {
    this.wantOpen = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.client.close(() => undefined);
    } catch {
      /* ignore */
    }
    this.status = 'disconnected';
  }

  /** Schedule a reconnect attempt after `reconnectMs`. */
  private scheduleReconnect(): void {
    if (!this.wantOpen || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.wantOpen) return;
      this.open().catch(() => {
        /* logged in open() */
      });
    }, this.config.reconnectMs);
  }

  /** Serialize all transactions through a single Promise queue. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => fn(), () => fn());
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Convert a user-facing offset (already 0-based per parseModbusAddress) into
   * the wire offset. Modbus TCP itself is 0-based on the wire. The `oneBased`
   * server flag is informational only — `parseModbusAddress` already strips
   * the +1 for Modicon-prefixed addresses.
   */
  private wireOffset(offset: number): number {
    return offset;
  }

  async read(kind: AddressKind, offset: number, length: number): Promise<number[] | boolean[]> {
    return this.enqueue(async () => {
      this.client.setID(this.config.deviceId);
      const addr = this.wireOffset(offset);
      switch (kind) {
        case 'holding': {
          const r = await this.client.readHoldingRegisters(addr, length);
          return r.data;
        }
        case 'input': {
          const r = await this.client.readInputRegisters(addr, length);
          return r.data;
        }
        case 'coil': {
          const r = await this.client.readCoils(addr, length);
          return r.data;
        }
        case 'discrete': {
          const r = await this.client.readDiscreteInputs(addr, length);
          return r.data;
        }
      }
    });
  }

  async writeRegister(offset: number, value: number): Promise<void> {
    await this.enqueue(async () => {
      this.client.setID(this.config.deviceId);
      await this.client.writeRegister(this.wireOffset(offset), value);
    });
  }

  async writeCoil(offset: number, state: boolean): Promise<void> {
    await this.enqueue(async () => {
      this.client.setID(this.config.deviceId);
      await this.client.writeCoil(this.wireOffset(offset), state);
    });
  }
}
