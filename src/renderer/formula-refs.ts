/**
 * Helpers for working with A1-style cell references inside formula text.
 *
 * Used by the click-to-insert / Alt+arrow pick / Ctrl+D fill-down features
 * to keep relative references consistent when copying or shifting cells.
 */

import { columnIndexToLetter, letterToColumnIndex } from '@shared/a1';

/**
 * Match a single A1 reference (optionally with `$` lockers) that is NOT
 * part of a larger identifier. Examples that match: `A1`, `$B$2`, `AA10`.
 * Examples that don't: `READ1` inside `MODBUS_READ1` (preceded by `_`),
 * `int16` (lowercase), `1A` (digit before letters).
 *
 * Capture groups:
 *   1: optional `$` before column
 *   2: column letters
 *   3: optional `$` before row
 *   4: row digits
 */
const A1_REF_RE = /(?<![A-Za-z0-9_$])(\$?)([A-Z]+)(\$?)([0-9]+)(?![A-Za-z0-9_])/g;

/**
 * Translate every relative A1 reference inside `formula` by (`dRow`, `dCol`).
 * `$`-locked components stay put. Cells that would land at row/col < 1 are
 * left untouched (Excel emits `#REF!` in that case; we avoid mangling source
 * text on undo).
 */
export function translateFormulaRefs(formula: string, dRow: number, dCol: number): string {
  return formula.replace(A1_REF_RE, (_match, colLock: string, colLetters: string, rowLock: string, rowDigits: string) => {
    let col = letterToColumnIndex(colLetters);
    let row = Number(rowDigits);
    if (!colLock) col += dCol;
    if (!rowLock) row += dRow;
    if (col < 1 || row < 1) return _match;
    return `${colLock}${columnIndexToLetter(col)}${rowLock}${row}`;
  });
}
