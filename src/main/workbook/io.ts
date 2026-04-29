/**
 * Workbook open/save through exceljs, with a SheetJS fallback for legacy `.xls`.
 *
 * Design notes
 * ------------
 * - We translate exceljs Workbook -> WorkbookModel (a flat, IPC-safe shape)
 *   and back, **preserving** anything we don't understand by keeping the
 *   exceljs Workbook instance cached under the same workbook id (see state.ts).
 *   On save we re-emit from the cached instance after applying tracked edits,
 *   which keeps macros (.xlsm), VBA, ext-data, conditional formats, etc. intact.
 * - Legacy .xls cannot be written by exceljs. We open it via SheetJS for read,
 *   surface `legacyXls: true` on the model, and force Save-As to .xlsx.
 */

import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { CellModel, SheetCellValue, SheetModel, WorkbookModel } from '../../shared/types';
import { columnIndexToLetter, formatA1 } from '../../shared/a1';

/** Cache of the live exceljs.Workbook for each opened file so that round-tripping preserves unknown parts. */
const workbookCache = new Map<string, ExcelJS.Workbook>();

export async function openWorkbook(filePath: string): Promise<{ model: WorkbookModel; raw: ExcelJS.Workbook | null }> {
  const ext = path.extname(filePath).toLowerCase();
  const stat = await fs.stat(filePath);
  const fileName = path.basename(filePath);

  if (ext === '.xls') {
    // SheetJS fallback for legacy .xls. Read-only; user must Save-As .xlsx.
    const buf = await fs.readFile(filePath);
    const wb = XLSX.read(buf, { type: 'buffer', cellFormula: true, cellStyles: true });
    return {
      model: sheetjsToModel(wb, filePath, fileName, stat.mtime.toISOString()),
      raw: null,
    };
  }

  if (ext === '.csv') {
    const wb = new ExcelJS.Workbook();
    await wb.csv.readFile(filePath);
    workbookCache.set(filePath, wb);
    return {
      model: exceljsToModel(wb, filePath, fileName, stat.mtime.toISOString(), { csv: true }),
      raw: wb,
    };
  }

  // .xlsx / .xlsm
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  workbookCache.set(filePath, wb);
  return {
    model: exceljsToModel(wb, filePath, fileName, stat.mtime.toISOString(), {}),
    raw: wb,
  };
}

export async function saveWorkbook(filePath: string, model: WorkbookModel, originalPath: string | null): Promise<{ modifiedAt: string }> {
  const ext = path.extname(filePath).toLowerCase();

  // Reuse cached exceljs.Workbook (from open) so unknown parts round-trip.
  // If user opened legacy .xls, there's no cached exceljs instance — build a fresh one.
  let wb = originalPath ? workbookCache.get(originalPath) : undefined;
  if (!wb || ext === '.csv') {
    wb = new ExcelJS.Workbook();
  }

  applyModelToExcelJs(wb, model);

  if (ext === '.csv') {
    await wb.csv.writeFile(filePath);
  } else {
    await wb.xlsx.writeFile(filePath);
  }

  // Re-cache against the new path so subsequent saves continue round-tripping.
  workbookCache.set(filePath, wb);

  const stat = await fs.stat(filePath);
  return { modifiedAt: stat.mtime.toISOString() };
}

export function closeWorkbook(filePath: string): void {
  workbookCache.delete(filePath);
}

// --- conversion helpers -----------------------------------------------------

function exceljsToModel(
  wb: ExcelJS.Workbook,
  filePath: string,
  fileName: string,
  modifiedAt: string,
  opts: { csv?: boolean },
): WorkbookModel {
  const sheets: SheetModel[] = [];
  wb.eachSheet((ws) => {
    const cells: Record<string, CellModel> = {};
    let maxCol = 0;
    let maxRow = 0;
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        if (colNumber > maxCol) maxCol = colNumber;
        if (rowNumber > maxRow) maxRow = rowNumber;
        const address = formatA1(colNumber, rowNumber);
        const cm: CellModel = { address, value: extractCellValue(cell) };
        if (cell.formula) cm.formula = String(cell.formula);
        if (cell.result !== undefined && cell.result !== null) cm.cached = cell.result as SheetCellValue;
        const note = (cell as unknown as { note?: { texts?: { text: string }[] } | string }).note;
        if (note) cm.comment = typeof note === 'string' ? note : (note.texts?.map((t) => t.text).join('') ?? '');
        cells[address] = cm;
      });
    });

    const mergedRanges: string[] = [];
    const mergeMap = (ws as unknown as { _merges?: Record<string, { range?: string }> })._merges;
    if (mergeMap) {
      for (const k of Object.keys(mergeMap)) {
        const r = mergeMap[k]?.range;
        if (r) mergedRanges.push(r);
      }
    }

    sheets.push({
      name: ws.name,
      cells,
      mergedRanges,
      conditionalFormats: (ws as unknown as { conditionalFormattings?: unknown[] }).conditionalFormattings ?? [],
      rowCount: Math.max(maxRow, ws.rowCount, 50),
      columnCount: Math.max(maxCol, ws.columnCount, 26),
    });
  });

  if (opts.csv && sheets.length === 1) sheets[0]!.name = 'contents';

  // Workbook-scoped defined names (named ranges). These round-trip via the
  // cached exceljs.Workbook automatically; we expose them on the model so
  // the HyperFormula host can register them as named expressions, otherwise
  // every formula that references one logs "Named expression ... not
  // recognized." and evaluates to #NAME?.
  const namedRanges: { name: string; expression: string }[] = [];
  const dn = (wb as unknown as { definedNames?: { model?: { name: string; ranges: string[] }[] } }).definedNames;
  const dnModel = dn?.model;
  if (Array.isArray(dnModel)) {
    for (const entry of dnModel) {
      if (!entry || !entry.name || !Array.isArray(entry.ranges) || entry.ranges.length === 0) continue;
      // HF supports a single expression per name; if multiple ranges are
      // declared we keep the first and ignore the rest.
      const expr = String(entry.ranges[0]).replace(/^=+/, '');
      namedRanges.push({ name: entry.name, expression: expr });
    }
  }

  return { filePath, fileName, modifiedAt, sheets, legacyXls: false, namedRanges };
}

function extractCellValue(cell: ExcelJS.Cell): SheetCellValue {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  // Rich text
  if (typeof v === 'object' && 'richText' in v && Array.isArray((v as { richText: { text: string }[] }).richText)) {
    return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('');
  }
  // Formula objects expose .result; .formula is captured separately.
  if (typeof v === 'object' && 'result' in v) {
    const r = (v as { result?: unknown }).result;
    if (r === null || r === undefined) return null;
    if (typeof r === 'string' || typeof r === 'number' || typeof r === 'boolean') return r;
  }
  // Date
  if (v instanceof Date) return v.toISOString();
  // Hyperlink: { text, hyperlink }
  if (typeof v === 'object' && 'text' in v) return String((v as { text: unknown }).text);
  // Error
  if (typeof v === 'object' && 'error' in v) return `#${String((v as { error: unknown }).error)}`;
  return String(v);
}

function applyModelToExcelJs(wb: ExcelJS.Workbook, model: WorkbookModel): void {
  // Remove worksheets the model no longer contains so deleted sheets don't
  // round-trip back from the cached exceljs Workbook.
  const modelSheetNames = new Set(model.sheets.map((s) => s.name));
  const toRemove: string[] = [];
  wb.eachSheet((ws) => {
    if (!modelSheetNames.has(ws.name)) toRemove.push(ws.name);
  });
  for (const name of toRemove) {
    const ws = wb.getWorksheet(name);
    if (ws) wb.removeWorksheet(ws.id);
  }

  for (const sheetModel of model.sheets) {
    let ws = wb.getWorksheet(sheetModel.name);
    if (!ws) ws = wb.addWorksheet(sheetModel.name);

    // Clear any cells in the cached worksheet that are no longer in the model.
    // Without this, deleted cells persist on save because we reuse the cached
    // exceljs.Workbook (to preserve unknown parts) and only write cells that
    // exist in the model.
    const modelAddresses = new Set(Object.keys(sheetModel.cells));
    const stale: ExcelJS.Cell[] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (!modelAddresses.has(cell.address)) stale.push(cell);
      });
    });
    for (const cell of stale) {
      cell.value = null;
      if ((cell as unknown as { note?: unknown }).note !== undefined) {
        (cell as unknown as { note: unknown }).note = undefined;
      }
    }

    for (const cm of Object.values(sheetModel.cells)) {
      const cell = ws.getCell(cm.address);
      if (cm.formula) {
        // Preserve formula AND write the cached/last-known value as the result so Excel
        // shows a value (not #NAME?) for our MODBUS_* pseudo-functions.
        cell.value = { formula: cm.formula, result: cm.cached ?? cm.value ?? null } as ExcelJS.CellFormulaValue;
      } else {
        cell.value = cm.value as ExcelJS.CellValue;
      }
      if (cm.comment !== undefined) {
        (cell as unknown as { note?: string }).note = cm.comment;
      }
    }
  }
}

function sheetjsToModel(wb: XLSX.WorkBook, filePath: string, fileName: string, modifiedAt: string): WorkbookModel {
  const sheets: SheetModel[] = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name]!;
    const ref = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { s: { c: 0, r: 0 }, e: { c: 25, r: 49 } };
    const cells: Record<string, CellModel> = {};
    for (const key of Object.keys(ws)) {
      if (key.startsWith('!')) continue;
      const c = ws[key] as XLSX.CellObject;
      const address = key;
      const cm: CellModel = { address, value: (c.v ?? null) as SheetCellValue };
      if (c.f) cm.formula = c.f;
      cells[address] = cm;
    }
    return {
      name,
      cells,
      mergedRanges: (ws['!merges'] ?? []).map((m) => `${formatA1(m.s.c + 1, m.s.r + 1)}:${formatA1(m.e.c + 1, m.e.r + 1)}`),
      rowCount: Math.max(ref.e.r + 1, 50),
      columnCount: Math.max(ref.e.c + 1, 26),
    };
  });
  return { filePath, fileName, modifiedAt, sheets, legacyXls: true };
}

// Re-export so the renderer can compute column letters for any width.
export { columnIndexToLetter };
