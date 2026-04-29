/**
 * Top-level Modbus orchestrator.
 *
 * Owns:
 *   - The current AppConfig
 *   - All ModbusServer + RedundantServer instances
 *   - One PollEngine + WriteQueue per InterfaceConfig
 *   - The shared cache exposed to HF's MODBUS_* function plugin
 *   - The "writes enabled" master switch
 *
 * The plugin reads from `getCachedValue()` synchronously; writes go through
 * `enqueueWrite()`. `subscribe()` registers a watch so the corresponding
 * poll block is built on the next recompute.
 *
 * On any cache update we forward a `cell:update` event for every formula
 * cell that depends on a touched address — that lets the renderer repaint
 * without a full recalc round-trip. (For Phase 4 we forward at the
 * interface level and let the renderer re-fetch via formula bar; per-cell
 * dispatch is added in Phase 6 once the dependency map is built.)
 */

import { BrowserWindow } from 'electron';
import type {
  AppConfig,
  AddressKind,
  InterfaceConfig,
  ModbusDataType,
  ServerConfig,
} from '../../shared/types';
import { ModbusServer } from './server';
import { RedundantServer } from './redundant';
import { PollEngine } from './pollEngine';
import { WriteQueue } from './writeQueue';
import type { ReadSource } from './readSource';
import { decodeWords, encodeValue, normalizeBitIndex, wordsForType } from './codec';
import { parseModbusAddress } from '../../shared/address';
import { log } from './logBus';

class ServerAdapter implements ReadSource {
  constructor(private readonly inner: ModbusServer) {}
  get name(): string {
    return this.inner.config.name;
  }
  read(kind: AddressKind, offset: number, length: number) {
    return this.inner.read(kind, offset, length);
  }
  writeRegister(offset: number, value: number) {
    return this.inner.writeRegister(offset, value);
  }
  writeCoil(offset: number, state: boolean) {
    return this.inner.writeCoil(offset, state);
  }
}

class RedundantAdapter implements ReadSource {
  constructor(private readonly inner: RedundantServer) {}
  get name(): string {
    return this.inner.name;
  }
  read(kind: AddressKind, offset: number, length: number) {
    return this.inner.read(kind, offset, length);
  }
  writeRegister(offset: number, value: number) {
    return this.inner.writeRegister(offset, value);
  }
  writeCoil(offset: number, state: boolean) {
    return this.inner.writeCoil(offset, state);
  }
}

interface RuntimeInterface {
  cfg: InterfaceConfig;
  source: ReadSource;
  /** Set when this interface is configured as a redundant pair. */
  pair: RedundantServer | null;
  poll: PollEngine;
  writes: WriteQueue;
}

export class ModbusManager {
  private servers = new Map<string, ModbusServer>();
  private interfaces = new Map<string, RuntimeInterface>();
  private writesEnabled = false;
  private connected = false;
  private config: AppConfig | null = null;
  private updateListener: (() => void) | null = null;

  setUpdateListener(fn: () => void): void {
    this.updateListener = fn;
  }

  setConfig(cfg: AppConfig): void {
    this.config = cfg;
  }

  getConfig(): AppConfig | null {
    return this.config;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Name of the single configured interface, or null if none. Per spec the
   * app supports exactly one interface at a time and all MODBUS_* formulas
   * resolve through it implicitly.
   */
  getDefaultInterfaceName(): string | null {
    if (this.interfaces.size > 0) {
      return this.interfaces.keys().next().value ?? null;
    }
    const cfg = this.config?.interfaces?.[0];
    return cfg ? cfg.name : null;
  }

  getWritesEnabled(): boolean {
    return this.writesEnabled;
  }

  setWritesEnabled(enabled: boolean): void {
    this.writesEnabled = enabled;
    log('info', 'manager', `writes ${enabled ? 'enabled' : 'disabled'}`);
    this.broadcastStatus();
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.config) {
      log('warn', 'manager', 'connect requested but no config loaded');
      return;
    }
    log(
      'info',
      'manager',
      `connect requested: ${this.config.servers.length} server(s), ${this.config.interfaces.length} interface(s)`,
    );
    // Build servers
    for (const sc of this.config.servers) {
      this.servers.set(sc.name, new ModbusServer(sc));
    }

    // Build interfaces. Redundancy now lives inline on the interface; if
    // `secondary` is set we wrap the two servers in a RedundantServer keyed
    // by the interface name itself.
    const pairs: RedundantServer[] = [];
    for (const ic of this.config.interfaces) {
      const primary = this.servers.get(ic.primary);
      if (!primary) {
        log('error', 'manager', `interface ${ic.name} references missing primary server ${ic.primary}`);
        continue;
      }
      let pair: RedundantServer | null = null;
      let source: ReadSource;
      if (ic.secondary) {
        const secondary = this.servers.get(ic.secondary);
        if (!secondary) {
          log('error', 'manager', `interface ${ic.name} references missing secondary server ${ic.secondary}`);
          continue;
        }
        pair = new RedundantServer(ic.name, ic.failover ?? { kind: 'manual' }, primary, secondary);
        pairs.push(pair);
        source = new RedundantAdapter(pair);
      } else {
        source = new ServerAdapter(primary);
      }
      const writes = new WriteQueue(ic.name, source);
      const poll = new PollEngine(ic, source, {
        onUpdate: () => this.broadcastUpdate(ic.name),
      });
      this.interfaces.set(ic.name, { cfg: ic, source, pair, poll, writes });
    }

    // Open all servers + pairs. Pairs already drive their own open() of the
    // two underlying ModbusServer instances; non-redundant interfaces just
    // need their primary server opened directly.
    const opens: Promise<unknown>[] = [];
    for (const p of pairs) opens.push(p.open());
    const pairedServers = new Set<ModbusServer>();
    for (const p of pairs) {
      pairedServers.add(p.a);
      pairedServers.add(p.b);
    }
    for (const s of this.servers.values()) {
      if (!pairedServers.has(s)) opens.push(s.open().catch(() => undefined));
    }
    await Promise.allSettled(opens);
    for (const it of this.interfaces.values()) it.poll.start();
    this.connected = true;
    this.broadcastStatus();
    log('info', 'manager', `connected: ${this.servers.size} servers, ${this.interfaces.size} interfaces`);
  }

  async disconnect(): Promise<void> {
    for (const it of this.interfaces.values()) {
      it.poll.stop();
      it.pair?.close();
    }
    for (const s of this.servers.values()) s.close();
    this.interfaces.clear();
    this.servers.clear();
    this.connected = false;
    this.broadcastStatus();
    log('info', 'manager', 'disconnected');
  }

  /**
   * Trigger a manual A/B swap on the named interface. No-op if the interface
   * is not configured for redundancy.
   */
  manualFailover(interfaceName: string): void {
    const it = this.interfaces.get(interfaceName);
    if (!it || !it.pair) {
      log('warn', 'manager', `manualFailover: unknown or non-redundant interface ${interfaceName}`);
      return;
    }
    it.pair.manualSwap();
    this.broadcastStatus();
  }

  /**
   * Read a typed value from an interface's cache.
   * Returns `'PENDING'` when the address is not yet cached, or `'#STALE'`
   * when the cache entry is marked stale.
   */
  readValue(
    interfaceName: string,
    addressText: string,
    dataType: ModbusDataType,
  ): number | string {
    const it = this.interfaces.get(interfaceName);
    if (!it) {
      // Configured-but-not-connected is a transient state, not a hard error.
      // Distinguish it from a truly unknown interface name.
      const known = this.config?.interfaces?.some((i) => i.name === interfaceName);
      return known ? '#DISCONNECTED' : '#NAME?';
    }
    let parsed;
    try {
      parsed = parseModbusAddress(addressText);
    } catch {
      return '#NAME?';
    }
    const need = wordsForType(dataType);
    // Subscribe everything we need.
    for (let i = 0; i < need; i++) it.poll.subscribe(parsed.kind, parsed.offset + i);

    // Bit access
    if (parsed.bit !== undefined) {
      const e = it.poll.getCacheEntry(parsed.kind, parsed.offset);
      if (!e) return 'PENDING';
      if (e.stale) return '#STALE';
      const word = Number(e.value);
      const bit = normalizeBitIndex(parsed.bit, it.cfg);
      return (word >> bit) & 1;
    }

    // Boolean kinds
    if (parsed.kind === 'coil' || parsed.kind === 'discrete') {
      const e = it.poll.getCacheEntry(parsed.kind, parsed.offset);
      if (!e) return 'PENDING';
      if (e.stale) return '#STALE';
      return e.value ? 1 : 0;
    }

    // Multi-word registers
    const words: number[] = [];
    for (let i = 0; i < need; i++) {
      const e = it.poll.getCacheEntry(parsed.kind, parsed.offset + i);
      if (!e) return 'PENDING';
      if (e.stale) return '#STALE';
      words.push(Number(e.value));
    }
    return decodeWords(words, dataType, it.cfg);
  }

  readCoil(interfaceName: string, addressText: string): number | string {
    const it = this.interfaces.get(interfaceName);
    if (!it) {
      const known = this.config?.interfaces?.some((i) => i.name === interfaceName);
      return known ? '#DISCONNECTED' : '#NAME?';
    }
    let parsed;
    try {
      parsed = parseModbusAddress(addressText);
    } catch {
      return '#NAME?';
    }
    if (parsed.kind !== 'coil' && parsed.kind !== 'discrete') return '#NAME?';
    it.poll.subscribe(parsed.kind, parsed.offset);
    const e = it.poll.getCacheEntry(parsed.kind, parsed.offset);
    if (!e) return 'PENDING';
    if (e.stale) return '#STALE';
    return e.value ? 1 : 0;
  }

  enqueueWriteRegister(
    interfaceName: string,
    addressText: string,
    value: number,
    dataType: ModbusDataType,
  ): string {
    if (!this.writesEnabled) return 'WRITES-DISABLED';
    const it = this.interfaces.get(interfaceName);
    if (!it) {
      const known = this.config?.interfaces?.some((i) => i.name === interfaceName);
      return known ? '#DISCONNECTED' : '#NAME?';
    }
    let parsed;
    try {
      parsed = parseModbusAddress(addressText);
    } catch {
      return '#NAME?';
    }
    if (parsed.kind !== 'holding') return '#NAME?';
    const words = encodeValue(value, dataType, it.cfg);
    for (let i = 0; i < words.length; i++) {
      it.writes.enqueue({ kind: 'holding', offset: parsed.offset + i, value: words[i]! });
    }
    return 'PENDING';
  }

  enqueueWriteCoil(interfaceName: string, addressText: string, value: boolean): string {
    if (!this.writesEnabled) return 'WRITES-DISABLED';
    const it = this.interfaces.get(interfaceName);
    if (!it) {
      const known = this.config?.interfaces?.some((i) => i.name === interfaceName);
      return known ? '#DISCONNECTED' : '#NAME?';
    }
    let parsed;
    try {
      parsed = parseModbusAddress(addressText);
    } catch {
      return '#NAME?';
    }
    if (parsed.kind !== 'coil') return '#NAME?';
    it.writes.enqueue({ kind: 'coil', offset: parsed.offset, value });
    return 'PENDING';
  }



  private broadcastStatus(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('modbus:status', {
        source: 'manager',
        connected: this.connected,
        activeServer: this.writesEnabled ? 'writes-enabled' : 'writes-disabled',
      });
    }
  }

  /** Notify renderer that an interface's cache changed; renderer triggers recompute. */
  private broadcastUpdate(_interfaceName: string): void {
    if (this.updateListener) this.updateListener();
  }
}

export const modbusManager = new ModbusManager();
