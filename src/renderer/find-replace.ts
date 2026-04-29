/**
 * Minimal find / replace dialog for the active sheet.
 *
 * Plain DOM (no w2ui form) to keep the surface small. Operates against a
 * provided WorkbookView, walking its active sheet's cells.
 */

import type { WorkbookView } from './workbook-view';

export class FindReplaceDialog {
  private host: HTMLElement;
  private visible = false;

  constructor(private view: () => WorkbookView | null) {
    this.host = document.createElement('div');
    this.host.style.cssText =
      'position:fixed;top:50px;right:20px;z-index:9999;background:var(--bg-toolbar);border:1px solid var(--border);' +
      'padding:8px;border-radius:4px;display:none;font-size:13px;min-width:280px;box-shadow:0 4px 12px rgba(0,0,0,0.4);';
    this.host.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <strong>Find / Replace</strong>
        <button class="w2ui-btn fr-close" style="padding:0 6px;">×</button>
      </div>
      <div style="display:grid;grid-template-columns:60px 1fr;gap:4px;align-items:center;">
        <label>Find</label><input class="fr-find" type="text" />
        <label>Replace</label><input class="fr-repl" type="text" />
      </div>
      <div style="margin-top:6px;display:flex;gap:4px;justify-content:flex-end;">
        <button class="w2ui-btn fr-next">Find Next</button>
        <button class="w2ui-btn fr-replace">Replace</button>
        <button class="w2ui-btn fr-replace-all">Replace All</button>
      </div>
      <div class="fr-status" style="margin-top:4px;font-size:12px;color:var(--fg-muted);min-height:14px;"></div>
    `;
    document.body.appendChild(this.host);
    this.host.querySelector<HTMLButtonElement>('.fr-close')!.addEventListener('click', () => this.hide());
    this.host.querySelector<HTMLButtonElement>('.fr-next')!.addEventListener('click', () => this.findNext());
    this.host.querySelector<HTMLButtonElement>('.fr-replace')!.addEventListener('click', () => this.replaceOne());
    this.host.querySelector<HTMLButtonElement>('.fr-replace-all')!.addEventListener('click', () => this.replaceAll());
  }

  toggle(): void {
    this.visible ? this.hide() : this.show();
  }
  show(): void {
    this.host.style.display = 'block';
    this.host.querySelector<HTMLInputElement>('.fr-find')?.focus();
    this.visible = true;
  }
  hide(): void {
    this.host.style.display = 'none';
    this.visible = false;
  }

  private getInputs(): { find: string; repl: string } {
    return {
      find: this.host.querySelector<HTMLInputElement>('.fr-find')!.value,
      repl: this.host.querySelector<HTMLInputElement>('.fr-repl')!.value,
    };
  }

  private setStatus(msg: string): void {
    this.host.querySelector<HTMLElement>('.fr-status')!.textContent = msg;
  }

  private findNext(): void {
    const view = this.view();
    if (!view) return;
    const { find } = this.getInputs();
    if (!find) return;
    const sheet = view.model.sheets[view.activeSheetIndex];
    if (!sheet) return;
    let count = 0;
    for (const cell of Object.values(sheet.cells)) {
      const haystack = (cell.formula ?? String(cell.value ?? '')).toLowerCase();
      if (haystack.includes(find.toLowerCase())) count++;
    }
    this.setStatus(`${count} match${count === 1 ? '' : 'es'} on active sheet`);
  }

  private replaceOne(): void {
    const view = this.view();
    if (!view) return;
    const { find, repl } = this.getInputs();
    if (!find) return;
    const sheet = view.model.sheets[view.activeSheetIndex];
    if (!sheet) return;
    for (const cell of Object.values(sheet.cells)) {
      if (cell.formula?.includes(find)) {
        cell.formula = cell.formula.replaceAll(find, repl);
        this.setStatus(`Replaced in ${cell.address}`);
        return;
      }
      if (typeof cell.value === 'string' && cell.value.includes(find)) {
        cell.value = cell.value.replaceAll(find, repl);
        this.setStatus(`Replaced in ${cell.address}`);
        return;
      }
    }
    this.setStatus('No match');
  }

  private replaceAll(): void {
    const view = this.view();
    if (!view) return;
    const { find, repl } = this.getInputs();
    if (!find) return;
    const sheet = view.model.sheets[view.activeSheetIndex];
    if (!sheet) return;
    let n = 0;
    for (const cell of Object.values(sheet.cells)) {
      if (cell.formula?.includes(find)) {
        cell.formula = cell.formula.replaceAll(find, repl);
        n++;
      } else if (typeof cell.value === 'string' && cell.value.includes(find)) {
        cell.value = cell.value.replaceAll(find, repl);
        n++;
      }
    }
    this.setStatus(`Replaced ${n}`);
  }
}
