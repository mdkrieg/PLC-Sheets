/**
 * Modbus address parsing.
 *
 * Accepts the common shapes used in PLC documentation:
 *   - Modicon 5-digit:  40001 (holding), 30001 (input), 10001 (discrete), 00001 (coil)
 *   - Modicon 6-digit:  400001, 300001, 100001, 000001
 *   - Bit selector:     40001.5  |  40001:5  |  40001 bit 5
 *   - Plain offset is also accepted when `kind` is supplied externally
 *     (e.g. when the user has chosen "address space = holding" already).
 *
 * Output offsets are ALWAYS zero-based, regardless of the user's `oneBased`
 * preference for a Server. Callers (Server) apply the +/- 1 shift before
 * sending on the wire.
 */

import type { AddressKind, ModbusAddress } from './types';

const KIND_BY_PREFIX: Record<string, AddressKind> = {
  '0': 'coil',
  '1': 'discrete',
  '3': 'input',
  '4': 'holding',
};

const ADDR_RE = /^([0134])(\d{4,5})(?:\s*(?:\.|:|\s+bit\s+)\s*(\d{1,2}))?$/i;

export function parseModbusAddress(input: string): ModbusAddress {
  const s = String(input).trim();
  const m = ADDR_RE.exec(s);
  if (!m) throw new Error(`invalid modbus address: ${input}`);
  const prefix = m[1]!;
  const digits = m[2]!;
  const bit = m[3] != null ? Number(m[3]) : undefined;
  const kind = KIND_BY_PREFIX[prefix]!;
  // Modicon convention: leading 4xxxx => 1-based offset; subtract 1.
  const userOffset = Number(digits);
  const offset = userOffset - 1;
  if (offset < 0) throw new Error(`address out of range: ${input}`);
  if (bit !== undefined && (bit < 0 || bit > 15)) {
    throw new Error(`bit selector out of range (0..15): ${input}`);
  }
  if (bit !== undefined && (kind === 'coil' || kind === 'discrete')) {
    throw new Error(`bit selectors are not valid for coil/discrete addresses: ${input}`);
  }
  return { kind, offset, bit };
}

export function formatModbusAddress(a: ModbusAddress): string {
  const prefix =
    a.kind === 'holding' ? '4' : a.kind === 'input' ? '3' : a.kind === 'discrete' ? '1' : '0';
  const num = String(a.offset + 1).padStart(4, '0');
  return a.bit !== undefined ? `${prefix}${num}.${a.bit}` : `${prefix}${num}`;
}

/** True if two addresses describe the same word/coil (ignores bit selector). */
export function sameWord(a: ModbusAddress, b: ModbusAddress): boolean {
  return a.kind === b.kind && a.offset === b.offset;
}
