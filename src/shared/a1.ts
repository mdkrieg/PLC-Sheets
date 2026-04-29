/**
 * A1-notation helpers shared by main and renderer.
 * Column letters are 1-based when expressed numerically (A=1, Z=26, AA=27).
 */

export function columnIndexToLetter(index1Based: number): string {
  if (index1Based < 1) throw new Error(`column index must be >= 1, got ${index1Based}`);
  let n = index1Based;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function letterToColumnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0) - 64;
    if (code < 1 || code > 26) throw new Error(`invalid column letter: ${letters}`);
    n = n * 26 + code;
  }
  return n;
}

export interface ParsedA1 {
  column: number; // 1-based
  row: number; // 1-based
}

export function parseA1(address: string): ParsedA1 {
  const m = /^\$?([A-Za-z]+)\$?([0-9]+)$/.exec(address.trim());
  if (!m) throw new Error(`invalid A1 address: ${address}`);
  return { column: letterToColumnIndex(m[1]!), row: Number(m[2]!) };
}

export function formatA1(column1Based: number, row1Based: number): string {
  return `${columnIndexToLetter(column1Based)}${row1Based}`;
}
