/**
 * Per-workbook HyperFormula host.
 *
 * Responsibilities
 * ----------------
 * - Build a HyperFormula instance from a WorkbookModel; each WorkbookModel
 *   sheet maps 1:1 to an HF sheet of the same name.
 * - Detect unsupported / disallowed formulas (DDE, external workbook refs,
 *   macro calls) BEFORE feeding HF so we never overwrite the original formula
 *   text. The cell is flagged `errored: true` and its evaluated value becomes
 *   `#NAME?`; the raw formula string remains intact in the WorkbookModel and
 *   is what gets re-saved.
 * - Provide `applyEdit()` for incremental edits returning a flat list of
 *   downstream cells that changed value, which the renderer uses to refresh
 *   the grid.
 * - Update each formula cell's `cached` value in the model so save-time
 *   "cached value" writeback shows the latest calculated value to Excel.
 *
 * Custom MODBUS_* functions are *registered* here as no-op stubs that return
 * sentinel values; Phase 4 swaps in the real PollEngine-backed implementations.
 */

import { HyperFormula, type ExportedChange } from 'hyperformula';
import type { CellModel, ModbusDataType, SheetCellValue, WorkbookModel } from '../../shared/types';
import { parseA1 } from '../../shared/a1';
import { modbusManager } from '../modbus/manager';
import { log as appLog } from '../modbus/logBus';
import type { HistorianWriter } from '../historian/writer';

// HF >= 2.x requires a license key; "gpl-v3" is the public free option.
const HF_LICENSE_KEY = 'gpl-v3';

/**
 * Patterns we refuse to evaluate. These are kept verbatim in the saved file
 * but show as `#NAME?` in the UI — matching Excel's behavior for formulas
 * that depend on unresolved features.
 */
const DISALLOWED_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  // External workbook reference: =[Book2.xlsx]Sheet1!A1
  { kind: 'external-ref', re: /\[[^\]]+\][^!]+!/ },
  // DDE: =DDE("excel","sheet","r1c1") or any function call with the name
  { kind: 'dde', re: /\bDDE\s*\(/i },
  // CALL/REGISTER (XLM macro entry points)
  { kind: 'macro-call', re: /\b(CALL|REGISTER|EVALUATE|EXEC)\s*\(/i },
];

/** Names of our pseudo-functions; we register stubs so HF doesn't reject them. */
const MODBUS_FN_NAMES = [
  'MODBUS_READ_REGISTER',
  'MODBUS_READ_COIL',
  'MODBUS_WRITE_REGISTER',
  'MODBUS_WRITE_COIL',
] as const;

/** UI pseudo-functions that render as interactive buttons in the grid. */
const UI_BUTTON_FN_NAMES = [
  'UI_BUTTON_SET',
  'UI_BUTTON_PULSE',
] as const;

/** Historian capture pseudo-function. */
const HISTORY_FN_NAME = 'HISTORY_CAPTURE' as const;

/** Valid tag name pattern: alphanumeric, hyphen, underscore, no spaces. */
const TAG_NAME_RE = /^[A-Za-z0-9_-]+$/;

let modbusPluginRegistered = false;
let uiButtonPluginRegistered = false;
let historianPluginRegistered = false;

// Module-level historian writer reference; set when a workbook with a
// historian opens. Shared across all FormulaHost instances (one per workbook)
// — the writer's `record()` is safe to call concurrently since it only
// pushes to a JS array (no async in the hot path).
let sharedHistorianWriter: HistorianWriter | null = null;

// Module-level tag-conflict registry: tagName -> first cell address that used it.
// Cleared when the historian writer is swapped (workbook close/re-open).
const tagOwnerMap = new Map<string, string>();

// Module-level recompute start time used by HISTORY_CAPTURE for timestamps.
let recomputeStartTime = 0;

/**
 * Modbus addresses arrive from HF as numbers (e.g. 40001) when the user
 * writes them unquoted, or as strings when quoted. parseModbusAddress wants
 * strings, so we coerce here while filtering null/undefined/empty.
 */
function stringifyArg(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(Math.trunc(v));
  return String(v).trim();
}

/**
 * Helper that resolves all of an HF plugin call's argument AST nodes to plain
 * JS values before invoking the user-supplied logic. HF passes a `state`
 * object and an array of AST nodes; we use the plugin's own
 * `runFunction` helper if present, otherwise read scalars by walking the
 * astArgs. This keeps the per-function bodies free of HF internals.
 */
function runWithArgs(
  plugin: { runFunction?: (...args: unknown[]) => unknown },
  ast: unknown,
  state: unknown,
  body: (args: unknown[]) => unknown,
): unknown {
  // HF >= 2.x: every plugin instance has runFunction; we provide a metadata
  // shim that simply forwards each argument as `ANY`. Five slots covers the
  // widest signature (MODBUS_WRITE_*: ref, addr, dtype, pollrate, readback).
  // The first slot is required; the remaining four are optional so HF
  // accepts calls with fewer args (e.g. =MODBUS_READ_REGISTER(40001)).
  const metadata = {
    parameters: [
      { argumentType: 'ANY' },
      { argumentType: 'ANY', optionalArg: true },
      { argumentType: 'ANY', optionalArg: true },
      { argumentType: 'ANY', optionalArg: true },
      { argumentType: 'ANY', optionalArg: true },
    ],
  };
  if (typeof plugin.runFunction === 'function') {
    return plugin.runFunction(
      (ast as { args?: unknown[] }).args ?? [],
      state,
      metadata,
      (...args: unknown[]) => body(args),
    );
  }
  // Fallback: invoke with empty args (shouldn't happen on HF 2.x).
  return body([]);
}

function ensureModbusPlugin(): void {
  if (modbusPluginRegistered) return;
  // Minimal HF function plugin that returns a sentinel string. Phase 4 will
  // replace this implementation with one backed by the live PollEngine.
  // See https://hyperformula.handsontable.com/guide/custom-functions.html
  // We `require` lazily and treat as `any` to avoid HF's deep generic types.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const hfMod = require('hyperformula') as { FunctionPlugin: any };
  const Base = hfMod.FunctionPlugin;

  class ModbusStubPlugin extends Base {
    modbusReadRegister(_ast: unknown, state: unknown): unknown {
      return runWithArgs(this as unknown as { runFunction?: (...a: unknown[]) => unknown }, _ast, state, (args) => {
        const iface = modbusManager.getDefaultInterfaceName();
        if (!iface) {
          appLog('warn', 'formula', `READ_REGISTER: no default interface (args=${JSON.stringify(args)})`, 'fn-no-iface');
          return '#NAME?';
        }
        const addr = stringifyArg(args[0]);
        if (!addr) {
          appLog('warn', 'formula', `READ_REGISTER: empty address (args=${JSON.stringify(args)})`, 'fn-no-addr');
          return '#NAME?';
        }
        const dt = (String(args[1] ?? 'int16').toLowerCase() as ModbusDataType);
        const result = modbusManager.readValue(iface, addr, dt);
        appLog('info', 'formula', `READ_REGISTER iface=${iface} addr=${addr} dt=${dt} -> ${JSON.stringify(result)}`, `fn-rr-${addr}`);
        return result;
      });
    }
    modbusReadCoil(_ast: unknown, state: unknown): unknown {
      return runWithArgs(this as unknown as { runFunction?: (...a: unknown[]) => unknown }, _ast, state, (args) => {
        const iface = modbusManager.getDefaultInterfaceName();
        if (!iface) return '#NAME?';
        const addr = stringifyArg(args[0]);
        if (!addr) return '#NAME?';
        // args[1] = optional bit number (-1 = derive from address text)
        // args[2] = poll rate (-1 = base)
        const bit = Number(args[1] ?? -1);
        const composedAddr = bit >= 0 && !/[.\:]|\sbit\s/i.test(addr) ? `${addr}.${bit}` : addr;
        return modbusManager.readCoil(iface, composedAddr);
      });
    }
    modbusWriteRegister(_ast: unknown, state: unknown): unknown {
      return runWithArgs(this as unknown as { runFunction?: (...a: unknown[]) => unknown }, _ast, state, (args) => {
        const iface = modbusManager.getDefaultInterfaceName();
        if (!iface) return '#NAME?';
        // Args (per outline): reference[cell], address, datatype?, poll_rate?, readback?
        const value = Number(args[0] ?? 0);
        const addr = stringifyArg(args[1]);
        if (!addr) return '#NAME?';
        const dt = (String(args[2] ?? 'int16').toLowerCase() as ModbusDataType);
        return modbusManager.enqueueWriteRegister(iface, addr, value, dt);
      });
    }
    modbusWriteCoil(_ast: unknown, state: unknown): unknown {
      return runWithArgs(this as unknown as { runFunction?: (...a: unknown[]) => unknown }, _ast, state, (args) => {
        const iface = modbusManager.getDefaultInterfaceName();
        if (!iface) return '#NAME?';
        // Args: reference[cell], address, bit?, poll_rate?, readback?
        const value = Boolean(args[0]);
        const addr = stringifyArg(args[1]);
        if (!addr) return '#NAME?';
        return modbusManager.enqueueWriteCoil(iface, addr, value);
      });
    }
  }

  // HF requires the parameters[] count to match how many positional args may
  // appear in the formula. Optional args declare `optionalArg: true` plus a
  // `defaultValue` so callers can omit them (e.g. =MODBUS_READ_REGISTER(40001)
  // resolves with int16 / base poll rate).
  (ModbusStubPlugin as any).implementedFunctions = {
    MODBUS_READ_REGISTER: {
      method: 'modbusReadRegister',
      parameters: [
        { argumentType: 'ANY' },
        { argumentType: 'ANY', optionalArg: true, defaultValue: 'int16' },
        { argumentType: 'ANY', optionalArg: true, defaultValue: -1 },
      ],
      isVolatile: true,
    },
    MODBUS_READ_COIL: {
      method: 'modbusReadCoil',
      parameters: [
        { argumentType: 'ANY' },
        { argumentType: 'ANY', optionalArg: true, defaultValue: -1 },
        { argumentType: 'ANY', optionalArg: true, defaultValue: -1 },
      ],
      isVolatile: true,
    },
    MODBUS_WRITE_REGISTER: {
      method: 'modbusWriteRegister',
      parameters: [
        { argumentType: 'ANY' },
        { argumentType: 'ANY' },
        { argumentType: 'ANY', optionalArg: true, defaultValue: 'int16' },
        { argumentType: 'ANY', optionalArg: true, defaultValue: -1 },
        { argumentType: 'ANY', optionalArg: true, defaultValue: '' },
      ],
      isVolatile: true,
    },
    MODBUS_WRITE_COIL: {
      method: 'modbusWriteCoil',
      parameters: [
        { argumentType: 'ANY' },
        { argumentType: 'ANY' },
        { argumentType: 'ANY', optionalArg: true, defaultValue: -1 },
        { argumentType: 'ANY', optionalArg: true, defaultValue: -1 },
        { argumentType: 'ANY', optionalArg: true, defaultValue: '' },
      ],
      isVolatile: true,
    },
  };

  const translations = MODBUS_FN_NAMES.reduce<Record<string, string>>((acc, n) => {
    acc[n] = n;
    return acc;
  }, {});

  HyperFormula.registerFunctionPlugin(ModbusStubPlugin as any, { enGB: translations, enUS: translations });
  modbusPluginRegistered = true;
}

/**
 * Register UI_BUTTON_SET and UI_BUTTON_PULSE as HF function stubs.
 * Both functions return their first argument (button_text) as the cell's
 * cached value so the renderer can use it as the button label.
 * They are NOT volatile — the label doesn't change unless the formula is edited.
 */
function ensureUiButtonPlugin(): void {
  if (uiButtonPluginRegistered) return;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const hfMod = require('hyperformula') as { FunctionPlugin: any };
  const Base = hfMod.FunctionPlugin;

  class UiButtonPlugin extends Base {
    uiButtonSet(_ast: unknown, state: unknown): unknown {
      // Returns button_text (arg[0]) so cell.cached = the label string.
      return runWithArgs(
        this as unknown as { runFunction?: (...a: unknown[]) => unknown },
        _ast, state,
        (args) => (args[0] !== undefined && args[0] !== null ? String(args[0]) : 'Button'),
      );
    }
    uiButtonPulse(_ast: unknown, state: unknown): unknown {
      return runWithArgs(
        this as unknown as { runFunction?: (...a: unknown[]) => unknown },
        _ast, state,
        (args) => (args[0] !== undefined && args[0] !== null ? String(args[0]) : 'Button'),
      );
    }
  }

  (UiButtonPlugin as any).implementedFunctions = {
    UI_BUTTON_SET: {
      method: 'uiButtonSet',
      // button_text, reference (cell addr), value
      parameters: [
        { argumentType: 'ANY' },
        { argumentType: 'ANY' },
        { argumentType: 'ANY' },
      ],
    },
    UI_BUTTON_PULSE: {
      method: 'uiButtonPulse',
      // button_text, reference, on_value, off_value, [pulse_seconds=1]
      parameters: [
        { argumentType: 'ANY' },
        { argumentType: 'ANY' },
        { argumentType: 'ANY' },
        { argumentType: 'ANY' },
        { argumentType: 'ANY', optionalArg: true, defaultValue: 1 },
      ],
    },
  };

  const translations = UI_BUTTON_FN_NAMES.reduce<Record<string, string>>((acc, n) => {
    acc[n] = n;
    return acc;
  }, {});

  HyperFormula.registerFunctionPlugin(UiButtonPlugin as any, { enGB: translations, enUS: translations });
  uiButtonPluginRegistered = true;
}

/**
 * Register HISTORY_CAPTURE as an HF function stub.
 * Returns a status string; is volatile so it re-evaluates on every poll tick.
 */
function ensureHistorianPlugin(): void {
  if (historianPluginRegistered) return;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const hfMod = require('hyperformula') as { FunctionPlugin: any };
  const Base = hfMod.FunctionPlugin;

  class HistorianPlugin extends Base {
    historianCapture(_ast: unknown, state: unknown): unknown {
      return runWithArgs(
        this as unknown as { runFunction?: (...a: unknown[]) => unknown },
        _ast, state,
        (args) => {
          const tag = args[0] !== undefined && args[0] !== null ? String(args[0]).trim() : '';
          if (!tag) return 'ERR: tag name required';
          if (!TAG_NAME_RE.test(tag)) return 'ERR: invalid tag name (use letters, numbers, - or _)';

          // We need a cell address for conflict detection. HF passes a `state`
          // object with sheet/row/col; extract it defensively.
          const st = state as { formulaAddress?: { sheet: number; row: number; col: number } } | null;
          const addr = st?.formulaAddress
            ? `${st.formulaAddress.sheet}:${st.formulaAddress.row}:${st.formulaAddress.col}`
            : tag;

          const existingOwner = tagOwnerMap.get(tag);
          if (existingOwner && existingOwner !== addr) {
            return 'ERR: tag conflict';
          }
          tagOwnerMap.set(tag, addr);

          if (!sharedHistorianWriter) return 'ERR: historian not open';

          const rawValue = args[1] ?? null;
          const value: number | boolean | null =
            typeof rawValue === 'number' || typeof rawValue === 'boolean' ? rawValue
            : rawValue === null ? null
            : null; // string values from non-numeric cells record as null

          const deadbandArg = args[2];
          const heartbeatArg = args[3];
          const deadband = deadbandArg !== null && deadbandArg !== undefined && !Number.isNaN(Number(deadbandArg))
            ? Number(deadbandArg)
            : undefined;
          const heartbeatSec = heartbeatArg !== null && heartbeatArg !== undefined && !Number.isNaN(Number(heartbeatArg))
            ? Number(heartbeatArg)
            : undefined;

          // Lazily resolve tagId (creates on first use)
          void (async () => {
            if (!sharedHistorianWriter) return;
            const db = sharedHistorianWriter.activeDB;
            if (!db) return;
            const entry = await db.resolveTag(tag);
            sharedHistorianWriter.record(tag, entry.id, value, recomputeStartTime, deadband, heartbeatSec);
          })();

          // Synchronous return for HF: show OK with last-write time.
          // On the very first evaluation this shows the recomputeStartTime.
          const ts = recomputeStartTime || Date.now();
          return `OK  ${new Date(ts).toISOString().replace('T', ' ').slice(0, 19)}`;
        },
      );
    }
  }

  (HistorianPlugin as any).implementedFunctions = {
    HISTORY_CAPTURE: {
      method: 'historianCapture',
      parameters: [
        { argumentType: 'ANY' },                                          // tag (required)
        { argumentType: 'ANY' },                                          // value (required)
        { argumentType: 'ANY', optionalArg: true, defaultValue: null },   // deadband
        { argumentType: 'ANY', optionalArg: true, defaultValue: null },   // heartbeat_seconds
      ],
      isVolatile: true,
    },
  };

  HyperFormula.registerFunctionPlugin(HistorianPlugin as any, {
    enGB: { HISTORY_CAPTURE: HISTORY_FN_NAME },
    enUS: { HISTORY_CAPTURE: HISTORY_FN_NAME },
  });
  historianPluginRegistered = true;
}

export interface FormulaHost {
  /** Push an edit (raw cell input) and return cells whose displayed value changed. */
  applyEdit(sheetName: string, address: string, raw: string): Array<{ sheet: string; address: string; value: SheetCellValue; errored?: boolean }>;
  /** Tear down the underlying HF instance. */
  destroy(): void;
  /** Recompute every cell's cached value into the WorkbookModel (used on save). */
  syncCachedValues(): void;
  /** Force HF to re-evaluate volatile functions (MODBUS_*) and return changed cells. */
  recomputeVolatile(): Array<{ sheet: string; address: string; value: SheetCellValue; errored?: boolean }>;
  /** Attach or detach the historian writer used by HISTORY_CAPTURE cells. */
  setHistorianWriter(writer: HistorianWriter | null): void;
}

export function createFormulaHost(model: WorkbookModel): FormulaHost {
  ensureModbusPlugin();
  ensureUiButtonPlugin();
  ensureHistorianPlugin();

  // Build sheets-data shaped as HF expects: { sheetName: [[row0col0, row0col1...], ...] }.
  const sheetsData: Record<string, unknown[][]> = {};
  for (const s of model.sheets) {
    sheetsData[s.name] = sheetCellsToGrid(s.cells, s.rowCount, s.columnCount);
  }

  const hf = HyperFormula.buildFromSheets(sheetsData as never, {
    licenseKey: HF_LICENSE_KEY,
    smartRounding: true,
  });

  // Excel treats bare TRUE / FALSE (no parentheses) as boolean literals;
  // HyperFormula parses them as identifiers and reports "Named expression
  // TRUE/FALSE not recognized" -> #NAME? for every formula like
  // =IF(A1, TRUE, FALSE). Register them as workbook-scoped named
  // expressions that evaluate to TRUE()/FALSE() so the references resolve.
  const hfAny = hf as unknown as {
    addNamedExpression: (name: string, expression: string) => unknown;
  };
  for (const [name, expr] of [['TRUE', '=TRUE()'], ['FALSE', '=FALSE()']] as const) {
    try {
      hfAny.addNamedExpression(name, expr);
    } catch {
      /* already registered (e.g. as a workbook defined name) */
    }
  }

  // Register workbook-scoped named ranges (Excel "defined names") AFTER build.
  // Building with `namedExpressions` argument throws synchronously when any
  // single name fails to resolve (e.g. references a deleted sheet, an array,
  // or has a syntax HF doesn't accept), aborting the entire workbook open.
  // Adding them one at a time lets us skip the offenders and still resolve
  // the rest, so formulas like `=PumpSetpoint` evaluate instead of #NAME?.
  if (model.namedRanges && model.namedRanges.length) {
    for (const nr of model.namedRanges) {
      const expr = nr.expression?.trim();
      if (!nr.name || !expr) continue;
      const exprFormula = expr.startsWith('=') ? expr : '=' + expr;
      try {
        hfAny.addNamedExpression(nr.name, exprFormula);
      } catch (err) {
        appLog(
          'warn',
          'formula',
          `named range "${nr.name}" = ${exprFormula} could not be registered: ${(err as Error)?.message ?? err}`,
          `nr-skip-${nr.name}`,
        );
      }
    }
  }

  // Mark cells with disallowed formulas as errored. They were inserted into HF
  // as their raw text (so HF will treat them as strings, not formulas) — but
  // because they begin with `=`, HF will still try to parse them. We pre-strip
  // the `=` for those by replacing the cell content with the original raw
  // string and tagging the model.
  for (const s of model.sheets) {
    for (const cell of Object.values(s.cells)) {
      if (cell.formula && isDisallowed(cell.formula)) {
        cell.errored = true;
      }
    }
  }

  // Initial pass: pull every formula cell's evaluated value into `cached`
  // so the grid shows current results immediately.
  syncFromHf(hf, model);

  return {
    applyEdit(sheetName, address, raw) {
      const sheetId = hf.getSheetId(sheetName);
      if (sheetId === undefined) return [];
      const { row, column } = parseA1(address);
      const hfAddr = { sheet: sheetId, row: row - 1, col: column - 1 };

      // Determine new content
      let cellModel: CellModel | null = null;
      let hfValue: unknown;
      if (raw === '' || raw === undefined || raw === null) {
        hfValue = null;
      } else if (raw.startsWith('=')) {
        const formula = raw.slice(1);
        if (isDisallowed(formula)) {
          // Don't push to HF; just store in model as errored
          cellModel = { address, value: null, formula, errored: true, cached: null };
          hfValue = null; // avoid HF parsing it
        } else {
          hfValue = raw;
          cellModel = { address, value: null, formula };
        }
      } else {
        const num = Number(raw);
        const v: SheetCellValue = !Number.isNaN(num) && raw.trim() !== '' ? num : raw;
        hfValue = v;
        cellModel = { address, value: v };
      }

      // Apply to HF (returns cascade of changes)
      console.log('[hf] setCellContents', sheetName, address, '<-', JSON.stringify(hfValue), 'typeof', typeof hfValue);
      const changes: ExportedChange[] = hf.setCellContents(hfAddr, [[hfValue as never]]);
      console.log('[hf] raw changes:', changes.map((c) => {
        if ('address' in c && c.address) {
          return { addr: c.address, newValue: c.newValue, t: typeof c.newValue };
        }
        return { other: c };
      }));

      // Update workbook model for the edited cell
      const sheetModel = model.sheets.find((s) => s.name === sheetName);
      if (sheetModel) {
        if (cellModel === null) delete sheetModel.cells[address];
        else sheetModel.cells[address] = cellModel;
      }

      // Translate HF changes back into our address space + update cached values
      const out: ReturnType<FormulaHost['applyEdit']> = [];
      const seen = new Set<string>();
      for (const ch of changes) {
        if (!('address' in ch) || !ch.address) continue;
        const sheetName2 = hf.getSheetName(ch.address.sheet);
        if (!sheetName2) continue;
        const colLetter = colNumberToLetter(ch.address.col + 1);
        const a1 = `${colLetter}${ch.address.row + 1}`;
        const value = unwrapHfValue(ch.newValue);
        // Runtime '#'-prefixed strings (#NAME?, #DISCONNECTED, etc.) are
        // surfaced as the cached value and may change on the next poll. We
        // do NOT set `errored` for them; that flag is reserved for
        // parse-time problems (DDE/external/macro/HF throw).
        const key = `${sheetName2}!${a1}`;
        seen.add(key);

        // For the directly edited cell that's a plain literal, prefer the
        // value we just stored in the model over HF's echo (HF sometimes
        // emits null for unchanged cells or odd-shaped values).
        const isEdited = sheetName2 === sheetName && a1 === address;
        let outValue: SheetCellValue = value;
        if (isEdited && cellModel && !cellModel.formula) {
          outValue = cellModel.value ?? null;
        }
        out.push({ sheet: sheetName2, address: a1, value: outValue, errored: false });

        // Update cached on the model
        const sm = model.sheets.find((s) => s.name === sheetName2);
        if (sm) {
          const existing = sm.cells[a1];
          if (existing) {
            if (existing.formula) {
              existing.cached = value;
            } else if (!isEdited) {
              // Don't clobber the literal we just set for the edited cell.
              existing.value = value;
            }
            // Clear any stale errored flag — the formula evaluated this round.
            existing.errored = undefined;
          }
        }
      }

      // If HF didn't emit a change for the directly edited cell, surface its
      // current model state so the grid still repaints.
      if (cellModel && !seen.has(`${sheetName}!${address}`)) {
        const value = cellModel.formula
          ? (cellModel.cached ?? null)
          : (cellModel.value ?? null);
        out.push({ sheet: sheetName, address, value, errored: cellModel.errored });
      } else if (!cellModel && !seen.has(`${sheetName}!${address}`)) {
        out.push({ sheet: sheetName, address, value: null });
      }
      return out;
    },

    destroy() {
      hf.destroy();
    },

    syncCachedValues() {
      syncFromHf(hf, model);
    },

    recomputeVolatile() {
      // Stamp the recompute time BEFORE rebuilding so HISTORY_CAPTURE cells
      // all use a consistent timestamp for this poll cycle.
      recomputeStartTime = Date.now();
      // HF marks MODBUS_* functions as isVolatile, so rebuildAndRecalculate
      // will re-execute them. We diff cached values before/after to surface
      // only the cells whose displayed result changed.
      const before = new Map<string, SheetCellValue>();
      for (const s of model.sheets) {
        for (const cell of Object.values(s.cells)) {
          if (cell.formula) before.set(`${s.name}!${cell.address}`, cell.cached ?? null);
        }
      }
      try {
        (hf as unknown as { rebuildAndRecalculate?: () => void }).rebuildAndRecalculate?.();
      } catch {
        /* ignore */
      }
      syncFromHf(hf, model);
      const out: ReturnType<FormulaHost['recomputeVolatile']> = [];
      for (const s of model.sheets) {
        for (const cell of Object.values(s.cells)) {
          if (!cell.formula) continue;
          const key = `${s.name}!${cell.address}`;
          const prev = before.get(key) ?? null;
          const cur = cell.cached ?? null;
          if (prev !== cur || cell.errored) {
            out.push({ sheet: s.name, address: cell.address, value: cur, errored: cell.errored });
          }
        }
      }
      return out;
    },

    setHistorianWriter(writer: HistorianWriter | null): void {
      sharedHistorianWriter = writer;
      // Clear tag-conflict map when historian is re-attached (workbook reload)
      tagOwnerMap.clear();
    },
  };
}

function syncFromHf(hf: HyperFormula, model: WorkbookModel): void {
  for (const s of model.sheets) {
    const sheetId = hf.getSheetId(s.name);
    if (sheetId === undefined) continue;
    for (const cell of Object.values(s.cells)) {
      if (!cell.formula) continue;
      // Skip permanently-errored cells (DDE/external/macro). For everything
      // else we re-evaluate every time so transient '#' sentinels recover.
      if (cell.errored && isDisallowed(cell.formula)) continue;
      const { row, column } = parseA1(cell.address);
      try {
        const v = hf.getCellValue({ sheet: sheetId, row: row - 1, col: column - 1 });
        const value = unwrapHfValue(v);
        cell.cached = value;
        cell.errored = undefined;
      } catch {
        cell.errored = true;
        cell.cached = null;
      }
    }
  }
}

function sheetCellsToGrid(
  cells: Record<string, CellModel>,
  rowCount: number,
  colCount: number,
): unknown[][] {
  const grid: unknown[][] = [];
  for (let r = 0; r < rowCount; r++) {
    grid.push(new Array(colCount).fill(null));
  }
  for (const cell of Object.values(cells)) {
    const { row, column } = parseA1(cell.address);
    if (row > rowCount || column > colCount) continue;
    if (cell.formula) {
      // Disallowed formulas are NOT pushed to HF — they live in the model only.
      if (isDisallowed(cell.formula)) continue;
      grid[row - 1]![column - 1] = '=' + cell.formula;
    } else {
      grid[row - 1]![column - 1] = cell.value;
    }
  }
  return grid;
}

function isDisallowed(formula: string): boolean {
  return DISALLOWED_PATTERNS.some((p) => p.re.test(formula));
}

function unwrapHfValue(v: unknown): SheetCellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  // CellError -> "#NAME?" etc. HF 2.x emits DetailedCellError objects with
  // {value, address, type, message}. Surface the message to the in-app log
  // so users aren't left staring at #NA? without context.
  if (typeof v === 'object' && v !== null && 'type' in v) {
    const obj = v as { type: unknown; value?: unknown; message?: unknown; address?: unknown };
    const t = String(obj.type);
    const sentinel = `#${t.toUpperCase()}?`;
    const msg = obj.message ? String(obj.message) : '';
    const addr = obj.address ? String(obj.address) : '';
    if (msg) {
      appLog(
        'error',
        'formula',
        `${addr || 'cell'} ${sentinel}: ${msg}`,
        `hf-err-${addr}-${sentinel}-${msg}`,
      );
    }
    return sentinel;
  }
  return String(v);
}

function colNumberToLetter(n: number): string {
  let s = '';
  let x = n;
  while (x > 0) {
    const rem = (x - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}
