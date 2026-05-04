/**
 * Shared, framework-agnostic types for workbook + modbus + log domains.
 * Kept dependency-free so they can be imported by both main and renderer.
 */

export type SheetCellValue = string | number | boolean | null;

/** Read-only cell formatting extracted from the source workbook.
 *  Sparse — every field is optional and omitted when matching Excel defaults
 *  to keep IPC payloads small. Themed/indexed colors and gradient/patterned
 *  fills are deferred (see plan); they are simply skipped on extraction. */
export interface CellStyle {
  /** Excel format code, e.g. "0.00%", "#,##0.00;[Red](#,##0.00)", "yyyy-mm-dd". */
  numFmt?: string;
  font?: FontStyle;
  fill?: FillStyle;
  alignment?: AlignmentStyle;
  border?: BorderStyle;
}

export interface FontStyle {
  name?: string;
  /** Point size as authored in Excel. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** "#RRGGBB" — alpha stripped, themed/indexed unresolved entries dropped. */
  color?: string;
}

export interface FillStyle {
  /** Solid fill color "#RRGGBB". Patterned/gradient fills not extracted. */
  color?: string;
}

export type HorizontalAlign = 'left' | 'center' | 'right' | 'justify' | 'fill' | 'centerContinuous' | 'distributed';
export type VerticalAlign = 'top' | 'middle' | 'bottom' | 'justify' | 'distributed';

export interface AlignmentStyle {
  horizontal?: HorizontalAlign;
  vertical?: VerticalAlign;
  wrapText?: boolean;
  /** Excel indent units (each ~3 chars / ~9px). */
  indent?: number;
}

export type BorderEdgeStyle =
  | 'thin' | 'medium' | 'thick'
  | 'dashed' | 'dotted'
  | 'double'
  | 'hair'
  | 'mediumDashed' | 'dashDot' | 'mediumDashDot'
  | 'dashDotDot' | 'mediumDashDotDot' | 'slantDashDot';

export interface BorderEdge {
  style: BorderEdgeStyle;
  color?: string;
}

export interface BorderStyle {
  top?: BorderEdge;
  right?: BorderEdge;
  bottom?: BorderEdge;
  left?: BorderEdge;
}

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
  /** Read-only formatting extracted from the source workbook. */
  style?: CellStyle;
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
  /** Per-column width in CSS pixels, keyed by 1-based column index. Sparse. */
  columnWidths?: Record<number, number>;
  /** Per-row height in CSS pixels, keyed by 1-based row index. Sparse. */
  rowHeights?: Record<number, number>;
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

export interface HistorianConfig {
  /** On-change deadband applied to all tags that don't override it. 0 = record every change. */
  defaultDeadband: number;
  /** Heartbeat write interval in seconds for all tags that don't override it. */
  defaultHeartbeatSec: number;
  /** How often (ms) the in-memory ring buffer is flushed to LevelDB as a batch write. */
  batchFlushMs: number;
  /** Number of days of history to retain. Older records are deleted hourly. */
  retentionDays: number;
}

export interface AppConfig {
  servers: ServerConfig[];
  interfaces: InterfaceConfig[];
  historian?: HistorianConfig;
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
