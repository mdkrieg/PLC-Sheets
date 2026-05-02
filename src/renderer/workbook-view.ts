/**
 * Renderer-side workbook view.
 *
 * Owns:
 *  - the in-memory WorkbookModel (mirrored from main; main remains the source
 *    of truth on disk),
 *  - a w2grid rendering the active sheet,
 *  - sheet tabs at the bottom of the grid,
 *  - a formula bar above the grid,
 *  - an UndoStack for cell edits.
 *
 * All cell edits go through `UndoStack.push` so undo/redo work uniformly.
 */

import { w2grid, w2tabs } from 'w2ui/w2ui-2.0.es6.min.js';
import * as XLSX from 'xlsx';
import type {
  AlignmentStyle,
  BorderEdge,
  BorderStyle,
  CellModel,
  CellStyle,
  FontStyle,
  SheetCellValue,
  SheetModel,
  WorkbookModel,
} from '@shared/types';
import { columnIndexToLetter, formatA1, parseA1 } from '@shared/a1';
import { UndoStack, type Command } from './undo';
import { attachFormulaAutocomplete } from './formula-autocomplete';
import { translateFormulaRefs } from './formula-refs';

const CELL_FIELD_PREFIX = 'c';

export class WorkbookView {
  model: WorkbookModel;
  activeSheetIndex = 0;
  undo = new UndoStack();
  dirty = false;

  private grid: any = null;
  private tabs: any = null;
  private formulaInput: HTMLInputElement | null = null;
  private addressBox: HTMLSpanElement | null = null;
  private currentAddress: string | null = null;
  private detachAutocomplete: (() => void) | null = null;
  /** While true, commitEdit() skips firing per-cell recalc IPCs. The caller
   *  is responsible for issuing one batched recalc when it finishes. */
  private recalcPaused = false;
  /** Map of `${sheet}!${address}` -> ms-since-epoch of last value update. */
  private lastUpdatedAt = new Map<string, number>();
  /** Set of A1 addresses (for the active sheet) that are inside a merged range
   *  but are NOT the top-left origin. They render empty so the origin's text
   *  can visually overflow into them. Rebuilt on every renderGrid(). */
  private mergedCovered = new Set<string>();
  /** Set of A1 addresses (for the active sheet) that ARE the top-left of a
   *  merge — used so we can flag them for overflow-friendly rendering. */
  private mergedOrigins = new Set<string>();
  /** <style> element holding per-row-height + per-merge-origin rules for the
   *  active grid; rebuilt on every renderGrid() and removed on destroy(). */
  private dynStyleEl: HTMLStyleElement | null = null;
  /** Excel-style reference picker state. Active while Alt is held during
   *  formula editing. Arrow keys move pickFocus; Shift+arrow holds the
   *  anchor so a range is built up. The picked address (single cell or
   *  A1:B2 range) is inserted into the formula input at `pickInsertion`,
   *  replacing the prior insertion on each move so the live formula text
   *  always reflects the pick. */
  private altPickActive = false;
  private altPickAnchor: { row: number; col: number } | null = null;
  private altPickFocus: { row: number; col: number } | null = null;
  /** [start, end) of the current pick text inside formulaInput.value. */
  private altPickInsertion: { start: number; end: number } | null = null;
  /** Bound listeners we need to detach in destroy(). */
  private docKeyDownHandler: ((e: KeyboardEvent) => void) | null = null;
  private docKeyUpHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(
    model: WorkbookModel,
    private hostMain: HTMLElement,
    private onDirtyChange: (dirty: boolean) => void,
  ) {
    this.model = model;
  }

  destroy(): void {
    this.detachAutocomplete?.();
    this.detachAutocomplete = null;
    if (this.docKeyDownHandler) document.removeEventListener('keydown', this.docKeyDownHandler, true);
    if (this.docKeyUpHandler) document.removeEventListener('keyup', this.docKeyUpHandler, true);
    this.docKeyDownHandler = null;
    this.docKeyUpHandler = null;
    this.dynStyleEl?.remove();
    this.dynStyleEl = null;
    this.grid?.destroy?.();
    this.tabs?.destroy?.();
    this.hostMain.innerHTML = '';
  }

  render(): void {
    this.hostMain.innerHTML = `
      <div class="formula-bar" style="display:flex;align-items:center;gap:6px;padding:4px 6px;background:var(--bg-toolbar);border-bottom:1px solid var(--border);">
        <span class="addr-box" style="min-width:70px;font-family:monospace;font-weight:600;"></span>
        <input class="formula-input" type="text" style="flex:1;padding:3px 6px;background:var(--bg);color:var(--fg);border:1px solid var(--border);font-family:monospace;" />
      </div>
      <div class="grid-host" style="position:relative;height:calc(100% - 60px);"></div>
      <div class="tabs-host" style="height:30px;border-top:1px solid var(--border);"></div>
    `;
    this.formulaInput = this.hostMain.querySelector<HTMLInputElement>('.formula-input');
    this.addressBox = this.hostMain.querySelector<HTMLSpanElement>('.addr-box');
    this.formulaInput?.addEventListener('keydown', (e) => this.onFormulaBarKey(e));
    this.formulaInput?.addEventListener('blur', () => {
      // Bail out of pick mode when focus leaves the formula bar.
      if (this.altPickActive) this.cancelAltPick();
    });
    if (this.formulaInput) {
      this.detachAutocomplete?.();
      this.detachAutocomplete = attachFormulaAutocomplete(this.formulaInput);
    }

    // Document-level Alt release + Ctrl+D handling. Captured at the document
    // level so we catch the release even if focus has moved.
    this.docKeyDownHandler = (e) => this.onDocKeyDown(e);
    this.docKeyUpHandler = (e) => this.onDocKeyUp(e);
    document.addEventListener('keydown', this.docKeyDownHandler, true);
    document.addEventListener('keyup', this.docKeyUpHandler, true);

    this.renderTabs();
    this.renderGrid();
  }

  private renderTabs(): void {
    const tabsHost = this.hostMain.querySelector<HTMLElement>('.tabs-host');
    if (!tabsHost) return;
    this.tabs = new w2tabs({
      name: 'sheet-tabs',
      active: this.model.sheets[this.activeSheetIndex]?.name,
      tabs: this.model.sheets.map((s) => ({ id: s.name, text: s.name })),
      onClick: (e: { target: string }) => {
        const idx = this.model.sheets.findIndex((s) => s.name === e.target);
        if (idx >= 0 && idx !== this.activeSheetIndex) {
          this.activeSheetIndex = idx;
          this.renderGrid();
        }
      },
    });
    this.tabs.render(tabsHost);
  }

  private renderGrid(): void {
    const sheet = this.model.sheets[this.activeSheetIndex];
    if (!sheet) return;

    const gridHost = this.hostMain.querySelector<HTMLElement>('.grid-host');
    if (!gridHost) return;

    if (this.grid) {
      try {
        this.grid.destroy();
      } catch {
        /* ignore */
      }
      this.grid = null;
    }

    const colCount = Math.max(sheet.columnCount, 26);
    const rowCount = Math.max(sheet.rowCount, 50);

    // Rebuild merged-coverage caches for this sheet so formatCellDisplay
    // can suppress text in covered cells and let the origin overflow.
    this.mergedCovered = new Set<string>();
    this.mergedOrigins = new Set<string>();
    for (const range of sheet.mergedRanges) {
      const m = /^([A-Z]+\d+):([A-Z]+\d+)$/.exec(range);
      if (!m) continue;
      const a = parseA1(m[1]!);
      const b = parseA1(m[2]!);
      const r1 = Math.min(a.row, b.row), r2 = Math.max(a.row, b.row);
      const c1 = Math.min(a.column, b.column), c2 = Math.max(a.column, b.column);
      this.mergedOrigins.add(formatA1(c1, r1));
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          if (r === r1 && c === c1) continue;
          this.mergedCovered.add(formatA1(c, r));
        }
      }
    }

    const gridName = 'grid-' + Math.random().toString(36).slice(2, 8);

    const columns = [];
    for (let c = 1; c <= colCount; c++) {
      const letter = columnIndexToLetter(c);
      const field = CELL_FIELD_PREFIX + letter;
      const widthPx = sheet.columnWidths?.[c];
      columns.push({
        field,
        text: `<div style="text-align:center">${letter}</div>`,
        size: typeof widthPx === 'number' ? `${widthPx}px` : '90px',
        resizable: true,
        editable: { type: 'text' },
        // Raw edit value is stored in record[field] (formula source like
        // "=A1+B1" or a literal). The visible cell HTML is computed here so
        // sentinel strings (#NAME?, PENDING, ...) can't leak back into the
        // inline editor when the user double-clicks to edit.
        render: (record: { recid: number }) => {
          const sm = this.model.sheets[this.activeSheetIndex];
          if (!sm) return '';
          const address = formatA1(c, record.recid);
          // Cells covered by a merge (but not the origin) render empty so
          // the origin's content can overflow visually.
          if (this.mergedCovered.has(address)) return '';
          const cellModel = sm.cells[address];
          if (!cellModel) return '';
          const last = this.lastUpdatedAt.get(`${sm.name}!${address}`);
          return formatCellDisplay(cellModel, last, this.mergedOrigins.has(address));
        },
      });
    }

    const records: Record<string, unknown>[] = [];
    for (let r = 1; r <= rowCount; r++) {
      const rec: Record<string, unknown> = { recid: r };
      records.push(rec);
    }

    // Populate from the sheet's sparse cells.
    for (const cell of Object.values(sheet.cells)) {
      const { row, column } = parseA1(cell.address);
      if (row > rowCount || column > colCount) continue;
      const rec = records[row - 1]!;
      rec[CELL_FIELD_PREFIX + columnIndexToLetter(column)] = cellEditValue(cell);
    }

    this.grid = new w2grid({
      name: gridName,
      box: gridHost,
      selectType: 'cell',
      show: { lineNumbers: true, columnHeaders: true },
      columns,
      records,
      onSelect: () => this.syncFormulaBarFromSelection(),
      onClick: (event: { detail?: { recid?: number; column?: number } }) => {
        // Excel-style click-to-insert: when the formula bar is in formula
        // edit mode (focused, value starts with '='), clicking another cell
        // inserts that cell's reference at the caret rather than just
        // moving the grid selection. We still let the grid's normal
        // selection handling run; we just append text to the input.
        if (!this.isFormulaEditing()) return;
        const recid = event.detail?.recid;
        const column = event.detail?.column;
        if (recid == null || column == null) return;
        const address = formatA1(column + 1, recid);
        this.insertReferenceAtCaret(address);
        // Re-focus the input so the user can keep typing.
        setTimeout(() => this.formulaInput?.focus(), 0);
      },
      // The default w2grid 'delete' handler clears record fields directly,
      // which bypasses our model + recalc pipeline. We hook the event,
      // intercept it once it's been confirmed, and route every selected
      // cell through commitEdit('') so undo/HF/poll-engine all see it.
      // We serialize the recalc IPCs so HF doesn't see overlapping edits
      // (which has been observed to surface transient #DIV/0! flickers
      // mid-batch).
      onDelete: async (event: { detail?: { force?: boolean } }) => {
        if (!event.detail?.force) return; // pre-confirm fires too; wait for force=true
        const sel = this.grid?.getSelection?.() as Array<{ recid: number; column: number }> | undefined;
        if (!sel || sel.length === 0) return;
        this.recalcPaused = true;
        try {
          for (const s of sel) {
            const address = formatA1(s.column + 1, s.recid);
            this.commitEdit(address, '');
          }
          // Repaint immediately so the user sees the clear before async recalc.
          this.repaintActiveSheet();
          this.grid?.refresh?.();
        } finally {
          this.recalcPaused = false;
          // Fire a single recalc pass for the whole batch using the last
          // edited cell as the trigger. recalcViaMain re-evaluates volatile
          // cells across the whole workbook anyway.
          const last = sel[sel.length - 1]!;
          const lastAddress = formatA1(last.column + 1, last.recid);
          const sheet = this.model.sheets[this.activeSheetIndex];
          if (sheet) await this.recalcViaMain(sheet.name, lastAddress, '');
        }
      },
      onChange: (event: {
        detail: {
          recid: number;
          column: number;
          // w2ui v2 shape; older v1 used value_new/value_original.
          value?: { new: unknown; previous?: unknown; original?: unknown };
          value_new?: unknown;
        };
      }) => {
        const { recid, column } = event.detail;
        const rawVal = event.detail.value?.new ?? event.detail.value_new ?? '';
        const raw = rawVal == null ? '' : String(rawVal);
        const address = formatA1(column + 1, recid);
        this.commitEdit(address, raw);
        // commitEdit applies model change synchronously and fires async recalc;
        // recalc results paint the grid via applyServerChanges.
      },
    });
    this.grid.render();
    this.applyDynamicSheetStyles(gridName, sheet);
  }

  private syncFormulaBarFromSelection(): void {
    if (!this.grid) return;
    setTimeout(() => {
      const sel = this.grid.getSelection?.();
      if (!sel || !sel.length) return;
      const { recid, column } = sel[0] as { recid: number; column: number };
      const address = formatA1(column + 1, recid);
      this.currentAddress = address;
      const sheet = this.model.sheets[this.activeSheetIndex]!;
      const cell = sheet.cells[address];
      if (this.addressBox) this.addressBox.textContent = address;
      if (this.formulaInput) this.formulaInput.value = cell?.formula ? '=' + cell.formula : (cell?.value != null ? String(cell.value) : '');
    }, 0);
  }

  private onFormulaBarKey(e: KeyboardEvent): void {
    // Alt+arrow → enter / move the cell-reference picker.
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      e.stopPropagation();
      this.handleAltArrow(e.key, e.shiftKey);
      return;
    }
    if (e.key === 'Escape' && this.altPickActive) {
      e.preventDefault();
      this.cancelAltPick();
      return;
    }
    if (e.key !== 'Enter' || !this.currentAddress || !this.formulaInput) return;
    if (this.altPickActive) this.commitAltPick();
    this.commitEdit(this.currentAddress, this.formulaInput.value);
    this.renderGrid();
  }

  /** True when the formula bar is focused and editing a formula (`=...`). */
  private isFormulaEditing(): boolean {
    if (!this.formulaInput) return false;
    if (document.activeElement !== this.formulaInput) return false;
    return this.formulaInput.value.startsWith('=');
  }

  /** Insert text at the formula input's caret (replacing any selection). */
  private insertReferenceAtCaret(text: string): void {
    const input = this.formulaInput;
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    input.value = before + text + after;
    const caret = before.length + text.length;
    input.setSelectionRange(caret, caret);
    // Notify any listeners (autocomplete) that the value changed.
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** Compose the text representation of the picker selection (single cell or A1:B2). */
  private pickRangeText(): string {
    const a = this.altPickAnchor;
    const f = this.altPickFocus;
    if (!a || !f) return '';
    if (a.row === f.row && a.col === f.col) return formatA1(a.col, a.row);
    const r1 = Math.min(a.row, f.row);
    const r2 = Math.max(a.row, f.row);
    const c1 = Math.min(a.col, f.col);
    const c2 = Math.max(a.col, f.col);
    return `${formatA1(c1, r1)}:${formatA1(c2, r2)}`;
  }

  /** Apply / refresh the picker's text in the formula input. */
  private writePickInsertion(): void {
    const input = this.formulaInput;
    if (!input) return;
    const text = this.pickRangeText();
    if (!this.altPickInsertion) {
      // First write — insert at the current caret, replacing any selection.
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      const before = input.value.slice(0, start);
      const after = input.value.slice(end);
      input.value = before + text + after;
      this.altPickInsertion = { start: before.length, end: before.length + text.length };
    } else {
      // Replace previous insertion with the new range text.
      const { start, end } = this.altPickInsertion;
      const before = input.value.slice(0, start);
      const after = input.value.slice(end);
      input.value = before + text + after;
      this.altPickInsertion = { start, end: start + text.length };
    }
    // Place caret at the end of the insertion so further typing continues
    // naturally once Alt is released.
    const caretEnd = this.altPickInsertion.end;
    input.setSelectionRange(caretEnd, caretEnd);
    this.highlightPickRange();
  }

  /** Highlight the current picker range on the grid using w2grid's addRange. */
  private highlightPickRange(): void {
    if (!this.grid) return;
    const a = this.altPickAnchor;
    const f = this.altPickFocus;
    if (!a || !f) return;
    try {
      this.grid.removeRange?.('plc-pick');
      this.grid.addRange?.({
        name: 'plc-pick',
        range: [
          { recid: Math.min(a.row, f.row), column: Math.min(a.col, f.col) - 1 },
          { recid: Math.max(a.row, f.row), column: Math.max(a.col, f.col) - 1 },
        ],
        style: 'background:rgba(0,120,212,0.18);outline:1px dashed var(--accent);',
      });
    } catch {
      /* w2grid may not be initialized yet; ignore */
    }
  }

  /** Handle Alt+Arrow inside the formula bar: build / move the picker. */
  private handleAltArrow(key: string, shift: boolean): void {
    if (!this.formulaInput) return;
    if (!this.formulaInput.value.startsWith('=')) return; // only in formula edit mode
    const sheet = this.model.sheets[this.activeSheetIndex];
    if (!sheet) return;
    const colCount = Math.max(sheet.columnCount, 26);
    const rowCount = Math.max(sheet.rowCount, 50);
    const dRow = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0;
    const dCol = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;

    if (!this.altPickActive) {
      // Pick mode just started. Anchor on the cell that holds the current
      // formula (so Alt+Right initially picks the cell to the right of it).
      const anchor = this.currentAddress ? parseA1(this.currentAddress) : { row: 1, column: 1 };
      let row = anchor.row + dRow;
      let col = anchor.column + dCol;
      row = Math.max(1, Math.min(rowCount, row));
      col = Math.max(1, Math.min(colCount, col));
      this.altPickActive = true;
      this.altPickAnchor = { row, col };
      this.altPickFocus = { row, col };
      this.altPickInsertion = null;
      this.writePickInsertion();
      return;
    }

    // Already picking — move the focus (and anchor too unless Shift is held).
    const f = this.altPickFocus!;
    const newRow = Math.max(1, Math.min(rowCount, f.row + dRow));
    const newCol = Math.max(1, Math.min(colCount, f.col + dCol));
    this.altPickFocus = { row: newRow, col: newCol };
    if (!shift) this.altPickAnchor = { row: newRow, col: newCol };
    this.writePickInsertion();
  }

  /** User released Alt — finalize the inserted reference. */
  private commitAltPick(): void {
    this.altPickActive = false;
    this.altPickAnchor = null;
    this.altPickFocus = null;
    this.altPickInsertion = null;
    if (this.grid) {
      try {
        this.grid.removeRange?.('plc-pick');
      } catch {
        /* ignore */
      }
    }
  }

  /** User pressed Escape during a pick — undo the inserted text. */
  private cancelAltPick(): void {
    if (this.altPickInsertion && this.formulaInput) {
      const { start, end } = this.altPickInsertion;
      const v = this.formulaInput.value;
      this.formulaInput.value = v.slice(0, start) + v.slice(end);
      this.formulaInput.setSelectionRange(start, start);
    }
    this.commitAltPick();
  }

  /** Document-level keydown: handle Ctrl+D fill-down and Alt-key edge cases. */
  private onDocKeyDown(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D') && !e.shiftKey && !e.altKey) {
      // Suppress only when the formula bar (or another genuine text input
      // outside the grid) currently has focus. w2grid keeps a hidden textarea
      // that always holds focus when the grid is the active context, so we
      // can't naively skip on "any editable target".
      if (this.formulaInput && document.activeElement === this.formulaInput) {
        console.log('[fillDown] suppressed: formula input focused');
        return;
      }
      const target = e.target as HTMLElement | null;
      const inGrid = !!target?.closest?.('.w2ui-grid');
      if (!inGrid && target && target.matches?.('input, textarea, [contenteditable="true"]')) {
        console.log('[fillDown] suppressed: target is editable outside grid', target.tagName);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      console.log('[fillDown] Ctrl+D captured, invoking fillDown()');
      this.fillDown();
    }
  }

  private onDocKeyUp(e: KeyboardEvent): void {
    if (e.key === 'Alt' && this.altPickActive) this.commitAltPick();
  }

  /** Excel-style Ctrl+D: copy the topmost cell of each column in the current
   *  selection down to the rest of the selection, translating relative refs. */
  private fillDown(): void {
    if (!this.grid) { console.log('[fillDown] no grid'); return; }
    const sel = this.grid.getSelection?.() as Array<{ recid: number; column: number }> | undefined;
    console.log('[fillDown] selection:', sel);
    if (!sel || sel.length < 2) { console.log('[fillDown] need >=2 cells, got', sel?.length ?? 0); return; }
    const sheet = this.model.sheets[this.activeSheetIndex];
    if (!sheet) return;

    // Bounding box across the selection.
    let minRow = Infinity, maxRow = -Infinity, minCol = Infinity, maxCol = -Infinity;
    for (const s of sel) {
      if (s.recid < minRow) minRow = s.recid;
      if (s.recid > maxRow) maxRow = s.recid;
      const c = s.column + 1;
      if (c < minCol) minCol = c;
      if (c > maxCol) maxCol = c;
    }
    if (minRow >= maxRow) return;

    // Snapshot before-state for undo.
    const before: Record<string, CellModel | undefined> = {};
    const after: Record<string, CellModel | null> = {};
    for (let col = minCol; col <= maxCol; col++) {
      const sourceAddr = formatA1(col, minRow);
      const source = sheet.cells[sourceAddr];
      for (let row = minRow + 1; row <= maxRow; row++) {
        const targetAddr = formatA1(col, row);
        before[targetAddr] = sheet.cells[targetAddr] ? { ...sheet.cells[targetAddr]! } : undefined;
        if (!source) {
          after[targetAddr] = null;
          continue;
        }
        if (source.formula) {
          const dRow = row - minRow;
          const translated = translateFormulaRefs(source.formula, dRow, 0);
          after[targetAddr] = { address: targetAddr, value: null, formula: translated };
        } else {
          after[targetAddr] = { address: targetAddr, value: source.value };
        }
      }
    }
    if (Object.keys(after).length === 0) return;

    const sheetName = sheet.name;
    const cmd: Command = {
      label: `fill-down ${minRow}:${maxRow} cols ${minCol}-${maxCol}`,
      redo: () => {
        for (const [addr, cell] of Object.entries(after)) {
          if (cell === null) delete sheet.cells[addr];
          else sheet.cells[addr] = cell;
        }
        this.markDirty();
        this.repaintActiveSheet();
        // Submit each filled cell to the main-process HF session so its
        // formula is registered and evaluated. Pause repaint-after-recalc
        // for all but the final cell to avoid flicker.
        this.recalcPaused = true;
        const entries = Object.entries(after);
        (async () => {
          try {
            for (let i = 0; i < entries.length - 1; i++) {
              const [addr, cell] = entries[i];
              const raw = cell ? cellEditValue(cell) : '';
              // Send directly, bypassing the recalcPaused guard.
              await this.submitEditToMain(sheetName, addr, raw);
            }
          } finally {
            this.recalcPaused = false;
          }
          if (entries.length > 0) {
            const [addr, cell] = entries[entries.length - 1];
            const raw = cell ? cellEditValue(cell) : '';
            await this.recalcViaMain(sheetName, addr, raw);
          }
        })();
      },
      undo: () => {
        for (const addr of Object.keys(after)) {
          const prev = before[addr];
          if (prev) sheet.cells[addr] = prev;
          else delete sheet.cells[addr];
        }
        this.markDirty();
        this.repaintActiveSheet();
        this.recalcPaused = true;
        const addrs = Object.keys(after);
        (async () => {
          try {
            for (let i = 0; i < addrs.length - 1; i++) {
              const addr = addrs[i];
              const prev = before[addr];
              const raw = prev ? cellEditValue(prev) : '';
              await this.submitEditToMain(sheetName, addr, raw);
            }
          } finally {
            this.recalcPaused = false;
          }
          if (addrs.length > 0) {
            const addr = addrs[addrs.length - 1];
            const prev = before[addr];
            const raw = prev ? cellEditValue(prev) : '';
            await this.recalcViaMain(sheetName, addr, raw);
          }
        })();
      },
    };
    this.undo.push(cmd);
  }

  private commitEdit(address: string, raw: string): void {
    const sheet = this.model.sheets[this.activeSheetIndex];
    if (!sheet) return;
    const sheetName = sheet.name;
    const before = sheet.cells[address] ? { ...sheet.cells[address]! } : undefined;
    const after = parseUserInput(address, raw);

    const cmd: Command = {
      label: `edit ${address}`,
      redo: () => {
        if (after === null) {
          delete sheet.cells[address];
        } else {
          sheet.cells[address] = after;
        }
        this.markDirty();
        this.recalcViaMain(sheetName, address, raw);
      },
      undo: () => {
        const undoRaw = before
          ? before.formula
            ? '=' + before.formula
            : before.value === null || before.value === undefined
              ? ''
              : String(before.value)
          : '';
        if (before) sheet.cells[address] = before;
        else delete sheet.cells[address];
        this.markDirty();
        this.recalcViaMain(sheetName, address, undoRaw);
      },
    };
    this.undo.push(cmd);
  }

  /** Send the edit to the main process for HF recalc, then apply downstream changes. */
  private async recalcViaMain(sheet: string, address: string, raw: string): Promise<void> {
    if (this.recalcPaused) return;
    return this.submitEditToMain(sheet, address, raw);
  }

  /** Like recalcViaMain but unconditional — used by batch operations that
   *  manage the recalcPaused flag themselves. */
  private async submitEditToMain(sheet: string, address: string, raw: string): Promise<void> {
    const filePath = this.model.filePath;
    if (!filePath) return; // unsaved/new — no main-side session yet
    try {
      console.log('[recalc] ->', sheet, address, JSON.stringify(raw));
      const { changes } = await window.api.invoke('workbook:editCell', { filePath, sheet, address, raw });
      console.log('[recalc] <-', changes);
      this.applyServerChanges(changes);
    } catch (err) {
      console.error('[recalc] failed', err);
    }
  }

  private applyServerChanges(
    changes: { sheet: string; address: string; value: unknown; errored?: boolean }[],
  ): void {
    if (!changes.length) return;
    const now = Date.now();
    let touchedActive = false;
    for (const ch of changes) {
      const sheetModel = this.model.sheets.find((s) => s.name === ch.sheet);
      if (!sheetModel) continue;
      const existing = sheetModel.cells[ch.address];
      if (existing) {
        if (existing.formula) existing.cached = ch.value as SheetCellValue;
        else existing.value = ch.value as SheetCellValue;
        existing.errored = ch.errored ? true : undefined;
      } else if (ch.value !== null && ch.value !== undefined) {
        sheetModel.cells[ch.address] = {
          address: ch.address,
          value: ch.value as SheetCellValue,
          errored: ch.errored,
        };
      }
      this.lastUpdatedAt.set(`${ch.sheet}!${ch.address}`, now);
      if (sheetModel === this.model.sheets[this.activeSheetIndex]) touchedActive = true;
    }
    if (touchedActive) this.repaintActiveSheet();
  }

  /** Public wrapper used by the main-process push channel `cell:update`. */
  applyPushedChange(sheetName: string, address: string, value: unknown, errored: boolean): void {
    this.applyServerChanges([{ sheet: sheetName, address, value, errored }]);
  }

  /** Rewrite cell text in the live grid records without re-mounting the grid. */
  private repaintActiveSheet(): void {
    const sheet = this.model.sheets[this.activeSheetIndex];
    if (!sheet || !this.grid) return;
    for (const cell of Object.values(sheet.cells)) {
      const { row, column } = parseA1(cell.address);
      const rec = this.grid.records?.[row - 1];
      if (!rec) continue;
      rec[CELL_FIELD_PREFIX + columnIndexToLetter(column)] = cellEditValue(cell);
    }
    this.grid.refresh?.();
  }

  /** Inject a per-grid <style> block carrying row-height rules and the
   *  overflow tweaks that let merged-origin cells visually span their range.
   *  w2ui v2 doesn't expose stable per-row height APIs, so a stylesheet
   *  scoped by grid name is the most reliable approach across versions. */
  private applyDynamicSheetStyles(gridName: string, sheet: SheetModel): void {
    if (!this.dynStyleEl) {
      this.dynStyleEl = document.createElement('style');
      this.dynStyleEl.dataset.plcsheetsDyn = '1';
      document.head.appendChild(this.dynStyleEl);
    }
    const id = `#grid_${gridName}`;
    const lines: string[] = [];

    // Per-row heights.
    if (sheet.rowHeights) {
      for (const [rowStr, h] of Object.entries(sheet.rowHeights)) {
        const r = Number(rowStr);
        if (!Number.isFinite(r) || !Number.isFinite(h)) continue;
        // w2ui v2 records are <tr recid="N">; the height needs to apply to
        // the inner <td>s. !important wins over w2ui's row class default.
        lines.push(
          `${id} .w2ui-grid-records tr[recid="${r}"] td { height: ${h}px !important; }`,
        );
      }
    }

    // Allow merged-origin cells to overflow into the (empty) covered cells
    // to their right/below. This is a visual approximation; selection still
    // treats every cell independently.
    if (this.mergedOrigins.size > 0) {
      lines.push(
        `${id} .w2ui-grid-records td.plc-merge-origin .w2ui-grid-data-content { overflow: visible !important; white-space: nowrap !important; }`,
      );
    }
    this.dynStyleEl.textContent = lines.join('\n');
  }

  private markDirty(): void {
    if (!this.dirty) {
      this.dirty = true;
      this.onDirtyChange(true);
    }
  }

  setSaved(): void {
    this.dirty = false;
    this.onDirtyChange(false);
  }

  performUndo(): void {
    if (this.undo.undo()) this.renderGrid();
  }
  performRedo(): void {
    if (this.undo.redo()) this.renderGrid();
  }
}

/** What the inline editor / formula bar should show for a cell. */
function cellEditValue(cell: CellModel): string {
  if (cell.formula) return '=' + cell.formula;
  if (cell.value === null || cell.value === undefined) return '';
  return String(cell.value);
}

/** Convert a cell to the visible HTML in the grid, honoring read-only
 *  formatting (numFmt, font, fill, alignment, borders) extracted from the
 *  source workbook. State sentinels (#NAME?, PENDING, #STALE, ...) take
 *  precedence over numFmt but still render inside the formatting wrapper so
 *  fonts/alignment/borders remain consistent. */
function formatCellDisplay(cell: CellModel, lastUpdated: number | undefined, isMergedOrigin: boolean): string {
  // Resolve display text + state class first.
  let displayText: string;
  let stateClass: string | null = null;
  let stateTitle: string | null = null;

  if (cell.errored) {
    displayText = '#NAME?';
    stateClass = 'cell-error';
    stateTitle = 'Formula could not be evaluated';
  } else {
    const rawDisplay = cell.cached !== undefined && cell.cached !== null
      ? cell.cached
      : cell.value;

    if (rawDisplay === 'PENDING') {
      displayText = 'PENDING';
      stateClass = 'cell-pending';
      stateTitle = 'Waiting for first poll';
    } else if (rawDisplay === '#STALE') {
      displayText = '#STALE';
      stateClass = 'cell-stale';
      stateTitle = 'Cache marked stale (read failure)';
    } else if (rawDisplay === 'WRITES-DISABLED') {
      displayText = 'WRITES-DISABLED';
      stateClass = 'cell-disabled';
      stateTitle = 'Writes-Enabled toggle is off';
    } else if (typeof rawDisplay === 'string' && (rawDisplay === '#NAME?' || rawDisplay.startsWith('#'))) {
      displayText = rawDisplay;
      stateClass = 'cell-error';
      stateTitle = 'Evaluator error';
    } else if (rawDisplay === null || rawDisplay === undefined) {
      displayText = '';
    } else {
      // Apply the workbook's number format if present and the value is numeric
      // (or a Date-as-ISO string). When formatting fails, fall back to raw.
      displayText = applyNumFmt(rawDisplay, cell.style?.numFmt);
      // Live MODBUS_* readings get a subtle "fresh" tint via cell-live class.
      if (cell.formula && /\bMODBUS_/i.test(cell.formula)) stateClass = 'cell-live';
    }
  }

  // Build the formatting style string from cell.style.
  const styleAttr = buildCellStyleAttr(cell.style, isMergedOrigin);
  const title = describeCell(cell, lastUpdated, stateTitle);
  const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
  const stateAttr = stateClass ? ` data-state="${stateClass}"` : '';
  // We use a single wrapper that carries BOTH the formatting style (inline)
  // AND the state class (via data-state mapped through CSS). The wrapper's
  // class includes 'cell-fmt' as a hook for state-class overrides, plus the
  // state class itself when present so existing CSS rules continue to win.
  const cls = stateClass ? `cell-fmt ${stateClass}` : 'cell-fmt';
  const originCls = isMergedOrigin ? ' plc-merge-origin' : '';
  const styleAttrFull = styleAttr ? ` style="${styleAttr}"` : '';
  return `<span class="${cls}${originCls}"${styleAttrFull}${titleAttr}${stateAttr}>${escapeHtml(displayText)}</span>`;
}

/** Format a value through SheetJS' SSF using an Excel format code. Falls
 *  back to a plain string conversion on any failure. */
function applyNumFmt(value: SheetCellValue, numFmt: string | undefined): string {
  if (value === null || value === undefined) return '';
  if (!numFmt) return typeof value === 'string' ? value : String(value);
  // SSF only formats numbers + date numerics; pass strings/booleans through.
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  try {
    const ssf = (XLSX as unknown as { SSF?: { format: (fmt: string, v: number) => string } }).SSF;
    if (!ssf) return String(value);
    return ssf.format(numFmt, value as number);
  } catch {
    return String(value);
  }
}

/** Build an inline `style="..."` attribute body from a CellStyle. Returns
 *  '' (no attribute) when there is nothing to apply. */
function buildCellStyleAttr(style: CellStyle | undefined, isMergedOrigin: boolean): string {
  const decls: string[] = [];
  if (style) {
    appendFontDecls(decls, style.font);
    appendFillDecls(decls, style.fill);
    appendAlignmentDecls(decls, style.alignment);
    appendBorderDecls(decls, style.border);
  }
  if (isMergedOrigin) {
    // Origin already overflows via the per-grid stylesheet; ensure the inline
    // wrapper itself doesn't clip.
    decls.push('overflow:visible');
  }
  // When a border is present, suppress the wrapper's default padding so the
  // border sits flush at the td edge (matching Excel layout). Text indentation
  // for non-border cells is handled by the CSS padding on .cell-fmt.
  if (style?.border) {
    decls.push('padding:3px 4px');
  }
  return decls.length > 0 ? cssEscape(decls.join(';')) : '';
}

function appendFontDecls(out: string[], font: FontStyle | undefined): void {
  if (!font) return;
  if (font.name) out.push(`font-family:${cssQuoteFontFamily(font.name)}`);
  if (typeof font.size === 'number') out.push(`font-size:${font.size}pt`);
  if (font.bold) out.push('font-weight:700');
  if (font.italic) out.push('font-style:italic');
  const decoParts: string[] = [];
  if (font.underline) decoParts.push('underline');
  if (font.strike) decoParts.push('line-through');
  if (decoParts.length > 0) out.push(`text-decoration:${decoParts.join(' ')}`);
  if (font.color) out.push(`color:${font.color}`);
}

function appendFillDecls(out: string[], fill: { color?: string } | undefined): void {
  if (fill?.color) out.push(`background-color:${fill.color}`);
}

function appendAlignmentDecls(out: string[], a: AlignmentStyle | undefined): void {
  if (!a) return;
  if (a.horizontal) {
    const map: Record<string, string> = {
      left: 'left', center: 'center', right: 'right',
      justify: 'justify', fill: 'left',
      centerContinuous: 'center', distributed: 'justify',
    };
    const v = map[a.horizontal];
    if (v) out.push(`text-align:${v}`);
  }
  if (a.vertical) {
    // Wrapper is display:block; vertical alignment is achieved through flex.
    const map: Record<string, string> = {
      top: 'flex-start', middle: 'center', bottom: 'flex-end',
      justify: 'center', distributed: 'center',
    };
    const v = map[a.vertical];
    if (v) {
      out.push('display:flex', `align-items:${v}`);
      // text-align already drives horizontal; mirror it via justify-content
      // when horizontal is set so content lands correctly inside the flex box.
      if (a.horizontal) {
        const jmap: Record<string, string> = {
          left: 'flex-start', center: 'center', right: 'flex-end',
          justify: 'space-between', fill: 'flex-start',
          centerContinuous: 'center', distributed: 'space-between',
        };
        const jv = jmap[a.horizontal];
        if (jv) out.push(`justify-content:${jv}`);
      }
    }
  }
  if (a.wrapText) out.push('white-space:pre-wrap', 'word-break:break-word');
  if (typeof a.indent === 'number' && a.indent > 0) {
    // Excel indent ≈ 3 chars per level ≈ 9px.
    out.push(`padding-left:${a.indent * 9}px`);
  }
}

function appendBorderDecls(out: string[], b: BorderStyle | undefined): void {
  if (!b) return;
  const sides: Array<['top' | 'right' | 'bottom' | 'left', string]> = [
    ['top', 'border-top'], ['right', 'border-right'],
    ['bottom', 'border-bottom'], ['left', 'border-left'],
  ];
  for (const [key, prop] of sides) {
    const edge = b[key];
    if (!edge) continue;
    out.push(`${prop}:${cssBorderShorthand(edge)}`);
  }
}

function cssBorderShorthand(edge: BorderEdge): string {
  // Map Excel border styles to CSS approximations.
  let width = '1px';
  let style: 'solid' | 'dashed' | 'dotted' | 'double' = 'solid';
  switch (edge.style) {
    case 'hair': width = '1px'; style = 'solid'; break;
    case 'thin': width = '1px'; style = 'solid'; break;
    case 'medium': width = '2px'; style = 'solid'; break;
    case 'thick': width = '3px'; style = 'solid'; break;
    case 'double': width = '3px'; style = 'double'; break;
    case 'dashed': width = '1px'; style = 'dashed'; break;
    case 'dotted': width = '1px'; style = 'dotted'; break;
    case 'mediumDashed': width = '2px'; style = 'dashed'; break;
    case 'dashDot':
    case 'dashDotDot':
    case 'slantDashDot':
      width = '1px'; style = 'dashed'; break;
    case 'mediumDashDot':
    case 'mediumDashDotDot':
      width = '2px'; style = 'dashed'; break;
  }
  const color = edge.color ?? '#000000';
  return `${width} ${style} ${color}`;
}

function cssQuoteFontFamily(name: string): string {
  // Quote when the family contains spaces or non-identifier chars.
  return /^[A-Za-z_][\w-]*$/.test(name) ? name : `'${name.replace(/'/g, "\\'")}'`;
}

/** Defang inline-style attribute payload — strip embedded quotes/newlines that
 *  would break out of the attribute. Only the closing-quote and any control
 *  chars are at risk; ';' and ':' are valid CSS. */
function cssEscape(s: string): string {
  return s.replace(/["\r\n]/g, '');
}

function describeCell(cell: CellModel, lastUpdated: number | undefined, prefix: string | null): string {
  const lines: string[] = [];
  if (prefix) lines.push(prefix);
  if (cell.formula) lines.push(`= ${cell.formula}`);
  if (lastUpdated) {
    const age = Math.max(0, Math.round((Date.now() - lastUpdated) / 1000));
    lines.push(`Last update: ${new Date(lastUpdated).toLocaleTimeString()} (${age}s ago)`);
  }
  if (cell.comment) lines.push(`Note: ${cell.comment}`);
  return lines.join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/** Parse what the user typed into the formula bar / cell into a CellModel. */
function parseUserInput(address: string, raw: string): CellModel | null {
  if (raw === '' || raw === undefined || raw === null) return null;
  if (raw.startsWith('=')) {
    return { address, value: null, formula: raw.slice(1) };
  }
  const num = Number(raw);
  const value: SheetCellValue = !Number.isNaN(num) && raw.trim() !== '' ? num : raw;
  return { address, value };
}
