/**
 * Shared, framework-agnostic types for workbook + modbus + log domains.
 * Kept dependency-free so they can be imported by both main and renderer.
 */

export type SheetCellValue = string | number | boolean | null;

export interface CellModel {
  /** A1-style address inside the owning sheet, e.g. "B7" */
  address: string;
  value: SheetCellValue;
  /** Raw formula string without leading '='; undefined if not a formula */
  formula?: string;
  /** Last evaluator-produced value (used as Excel "cached value" on save) */
  cached?: SheetCellValue;
  /** True when formula could not be evaluated (e.g. unsupported / DDE) */
  errored?: boolean;
  /** Cell comment text (Excel "note") if any */
  comment?: string;
  /** Renderer-resolved style payload; opaque shape kept by exceljs adapter */
  style?: Record<string, unknown>;
}

export interface SheetModel {
  name: string;
  /** Sparse cell map keyed by A1 address */
  cells: Record<string, CellModel>;
  /** A1 ranges that are merged, e.g. "B2:D4" */
  mergedRanges: string[];
  /** Raw exceljs conditional-formatting rules, preserved on round-trip */
  conditionalFormats?: unknown[];
  rowCount: number;
  columnCount: number;
}

export interface WorkbookModel {
  /** Filesystem path; null for unsaved/new workbooks */
  filePath: string | null;
  fileName: string;
  /** mtime of the on-disk file at last open/save, ISO string */
  modifiedAt: string | null;
  sheets: SheetModel[];
  /** Whether the file is .xls legacy (saved as .xlsx going forward) */
  legacyXls: boolean;
  /**
   * Workbook-scoped named ranges (Excel "defined names"). Each entry maps
   * a name to a single A1 expression like "Sheet1!$A$1:$B$2". Names with
   * multiple ranges keep only the first; pure-formula names are passed
   * through verbatim so HyperFormula can attempt to parse them.
   */
  namedRanges?: NamedRange[];
}

export interface NamedRange {
  name: string;
  /** Raw expression without leading '=' (e.g. "Sheet1!$A$1:$B$2" or "10*Sheet1!$A$1") */
  expression: string;
}

export type AddressKind = 'holding' | 'input' | 'discrete' | 'coil';

export interface ModbusAddress {
  kind: AddressKind;
  /** Zero-based offset within the chosen address space (after addressing-base normalization) */
  offset: number;
  /** Optional bit selector for register types */
  bit?: number;
}

export type ModbusDataType = 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'ascii';

export type FailoverPolicy =
  | { kind: 'manual' }
  | { kind: 'periodic'; intervalSec: number }
  | { kind: 'heartbeat'; address: string; staleAfterSec: number; mode: 'register-incrementing' | 'coil-flipflop' }
  | { kind: 'mismatch'; afterSec: number };

export interface ServerConfig {
  name: string;
  ip: string;
  port: number;
  deviceId: number;
  /** True if user-facing addresses are 1-based (Modicon style w/ leading 4xxxx etc.) */
  oneBased: boolean;
  timeoutMs: number;
  reconnectMs: number;
}

export type BlockStrategy =
  | { kind: 'auto'; maxSize: number; minSize: number; maxBlocks: number }
  | { kind: 'uniform'; size: number; offset: number }
  | { kind: 'manual'; blocks: { kind: AddressKind; start: number; length: number }[] }
  | { kind: 'none' };

export interface InterfaceConfig {
  name: string;
  /** Primary server name (always required). */
  primary: string;
  /**
   * Optional secondary server name. When set, this interface operates as a
   * redundant pair (primary = "A", secondary = "B") and `failover` selects
   * how the active side is chosen. When unset, the interface talks to
   * `primary` directly.
   */
  secondary?: string;
  /** Failover policy applied when `secondary` is set. Ignored otherwise. */
  failover?: FailoverPolicy;
  /** Bit nomenclature: 0-15 vs 1-16 */
  bitBase: 0 | 1;
  /** True when bit 0/1 is MSB; false (default) when LSB */
  bitMsbFirst: boolean;
  byteSwap: boolean;
  wordSwap: boolean;
  heartbeat?: {
    address: string;
    everySec: number;
    mode: 'register-incrementing' | 'coil-flipflop';
  };
  read: {
    basePollSec: number;
    minRequestGapMs: number;
    blockStrategy: BlockStrategy;
    allowIndividualReads: boolean;
    slowPollMaxSec: number;
  };
  write: {
    mode: 'on-change' | 'always';
    /** For 'always' mode */
    everySec?: number;
    readbackEverySec: number;
    readbackRetries: number;
    /** For 'always' mode */
    blockStrategy?: BlockStrategy;
  };
}

export interface AppConfig {
  servers: ServerConfig[];
  interfaces: InterfaceConfig[];
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  source: string;
  message: string;
  /** Used to deduplicate repetitive events; cleared by user "Clear" action */
  dedupKey?: string;
}
