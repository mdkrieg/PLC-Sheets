/**
 * Decode/encode raw 16-bit register words into user data types.
 *
 * Configurable byte/word swap follows the InterfaceConfig flags. Endianness
 * of multi-word values is "high word first" by default; `wordSwap` reverses.
 */

import type { ModbusDataType, InterfaceConfig } from '../../shared/types';

interface CodecOptions {
  byteSwap: boolean;
  wordSwap: boolean;
}

function opts(cfg: InterfaceConfig): CodecOptions {
  return { byteSwap: cfg.byteSwap, wordSwap: cfg.wordSwap };
}

function wordsToBuffer(words: number[], o: CodecOptions): Buffer {
  const ws = o.wordSwap ? [...words].reverse() : words;
  const buf = Buffer.alloc(ws.length * 2);
  for (let i = 0; i < ws.length; i++) {
    let w = ws[i]! & 0xffff;
    if (o.byteSwap) {
      w = ((w & 0xff) << 8) | ((w >> 8) & 0xff);
    }
    buf.writeUInt16BE(w, i * 2);
  }
  return buf;
}

function bufferToWords(buf: Buffer, o: CodecOptions): number[] {
  const words: number[] = [];
  for (let i = 0; i < buf.length; i += 2) {
    let w = buf.readUInt16BE(i);
    if (o.byteSwap) w = ((w & 0xff) << 8) | ((w >> 8) & 0xff);
    words.push(w);
  }
  return o.wordSwap ? words.reverse() : words;
}

/** Number of consecutive registers that this datatype occupies. */
export function wordsForType(dt: ModbusDataType, asciiLength = 0): number {
  switch (dt) {
    case 'int16':
    case 'uint16':
      return 1;
    case 'int32':
    case 'uint32':
    case 'float32':
      return 2;
    case 'ascii':
      return Math.max(1, Math.ceil(asciiLength / 2));
  }
}

export function decodeWords(words: number[], dt: ModbusDataType, cfg: InterfaceConfig): number | string {
  const buf = wordsToBuffer(words, opts(cfg));
  switch (dt) {
    case 'int16':
      return buf.readInt16BE(0);
    case 'uint16':
      return buf.readUInt16BE(0);
    case 'int32':
      return buf.readInt32BE(0);
    case 'uint32':
      return buf.readUInt32BE(0);
    case 'float32':
      return buf.readFloatBE(0);
    case 'ascii':
      return buf.toString('utf8').replace(/\u0000+$/g, '');
  }
}

export function encodeValue(value: number | string, dt: ModbusDataType, cfg: InterfaceConfig): number[] {
  const buf = Buffer.alloc(wordsForType(dt, typeof value === 'string' ? value.length : 0) * 2);
  switch (dt) {
    case 'int16':
      buf.writeInt16BE(Math.trunc(Number(value)) | 0, 0);
      break;
    case 'uint16':
      buf.writeUInt16BE((Math.trunc(Number(value)) | 0) & 0xffff, 0);
      break;
    case 'int32':
      buf.writeInt32BE(Math.trunc(Number(value)) | 0, 0);
      break;
    case 'uint32':
      buf.writeUInt32BE((Math.trunc(Number(value)) >>> 0), 0);
      break;
    case 'float32':
      buf.writeFloatBE(Number(value), 0);
      break;
    case 'ascii':
      Buffer.from(String(value), 'utf8').copy(buf);
      break;
  }
  return bufferToWords(buf, opts(cfg));
}

/**
 * Apply the InterfaceConfig bit-base / MSB convention to translate a
 * user-typed bit selector (e.g. `40001.5`) into a raw 0..15 LSB index.
 */
export function normalizeBitIndex(userBit: number, cfg: InterfaceConfig): number {
  let b = cfg.bitBase === 1 ? userBit - 1 : userBit;
  if (cfg.bitMsbFirst) b = 15 - b;
  if (b < 0 || b > 15) throw new Error(`bit index out of range after normalize: ${userBit}`);
  return b;
}
