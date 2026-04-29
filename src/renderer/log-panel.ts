/**
 * Live log panel docked at the bottom of the app shell.
 *
 * Backed by:
 *   - `log:list` (initial backfill on mount)
 *   - `log:append` (push events as they're emitted by `logBus`)
 *   - `log:clear` (the "Clear" button)
 *
 * We deliberately keep the panel as a *bounded* ring buffer (LIMIT entries)
 * so a chatty PLC can't bloat the renderer's memory. Filtering by level
 * happens client-side and is purely cosmetic — the underlying buffer keeps
 * everything until cleared.
 */

import type { LogEntry, LogLevel } from '@shared/types';

const LIMIT = 1000;

export class LogPanel {
  private entries: LogEntry[] = [];
  private filter: LogLevel | 'all' = 'all';
  private listEl: HTMLElement | null = null;
  private autoScroll = true;

  constructor(private host: HTMLElement) {}

  async mount(): Promise<void> {
    this.host.innerHTML = `
      <div class="logpanel" style="display:flex;flex-direction:column;height:100%;font-family:monospace;font-size:12px;">
        <div class="logpanel-toolbar" style="display:flex;align-items:center;gap:8px;padding:4px 8px;border-bottom:1px solid var(--border);background:var(--bg-toolbar);">
          <span class="logpanel-title" style="font-weight:600;color:var(--fg);">Log</span>
          <label>Level
            <select data-act="filter" style="background:var(--bg);color:var(--fg);border:1px solid var(--border);">
              <option value="all">all</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
            </select>
          </label>
          <label style="display:flex;align-items:center;gap:4px;">
            <input type="checkbox" data-act="autoscroll" checked /> Auto-scroll
          </label>
          <span data-role="count" style="color:var(--fg-muted);"></span>
          <div style="flex:1"></div>
          <button class="w2ui-btn" data-act="refresh">Refresh</button>
          <button class="w2ui-btn" data-act="copy">Copy</button>
          <button class="w2ui-btn" data-act="clear">Clear</button>
        </div>
        <div class="logpanel-list" style="flex:1;overflow:auto;padding:4px 8px;line-height:1.45;"></div>
      </div>
    `;
    this.listEl = this.host.querySelector<HTMLElement>('.logpanel-list');
    this.host.querySelector<HTMLSelectElement>('[data-act="filter"]')?.addEventListener('change', (e) => {
      this.filter = (e.target as HTMLSelectElement).value as LogLevel | 'all';
      this.repaint();
    });
    this.host.querySelector<HTMLInputElement>('[data-act="autoscroll"]')?.addEventListener('change', (e) => {
      this.autoScroll = (e.target as HTMLInputElement).checked;
    });
    this.host.querySelector<HTMLButtonElement>('[data-act="refresh"]')?.addEventListener('click', () => this.refresh());
    this.host.querySelector<HTMLButtonElement>('[data-act="copy"]')?.addEventListener('click', () => this.copyVisible());
    this.host.querySelector<HTMLButtonElement>('[data-act="clear"]')?.addEventListener('click', async () => {
      await window.api.invoke('log:clear');
      this.entries = [];
      this.repaint();
    });

    await this.refresh();

    // Live appends.
    window.api.on('log:append', (entry) => this.append(entry));
  }

  private async refresh(): Promise<void> {
    this.entries = await window.api.invoke('log:list');
    if (this.entries.length > LIMIT) this.entries = this.entries.slice(-LIMIT);
    this.repaint();
  }

  private append(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > LIMIT) this.entries.splice(0, this.entries.length - LIMIT);

    // Incremental render: append a single row instead of full repaint.
    if (!this.listEl || !this.matchesFilter(entry)) {
      this.updateCount();
      return;
    }
    this.listEl.appendChild(this.rowFor(entry));
    this.updateCount();
    if (this.autoScroll) this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  private repaint(): void {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const e of this.entries) {
      if (!this.matchesFilter(e)) continue;
      frag.appendChild(this.rowFor(e));
    }
    this.listEl.appendChild(frag);
    this.updateCount();
    if (this.autoScroll) this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  private updateCount(): void {
    const el = this.host.querySelector<HTMLElement>('[data-role="count"]');
    if (el) el.textContent = `${this.entries.length} entries`;
  }

  private matchesFilter(e: LogEntry): boolean {
    if (this.filter === 'all') return true;
    return e.level === this.filter;
  }

  private async copyVisible(): Promise<void> {
    const lines = this.entries
      .filter((e) => this.matchesFilter(e))
      .map((e) => `${formatTime(e.ts)} ${e.level.toUpperCase().padEnd(5)} ${e.source}\t${e.message}`);
    const text = lines.join('\n');
    const btn = this.host.querySelector<HTMLButtonElement>('[data-act="copy"]');
    try {
      await navigator.clipboard.writeText(text);
      if (btn) {
        const original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => {
          if (btn) btn.textContent = original;
        }, 1200);
      }
    } catch (err) {
      console.error('[log] copy failed', err);
      if (btn) {
        const original = btn.textContent;
        btn.textContent = 'Copy failed';
        setTimeout(() => {
          if (btn) btn.textContent = original;
        }, 1500);
      }
    }
  }

  private rowFor(e: LogEntry): HTMLElement {
    const row = document.createElement('div');
    row.className = `log-row log-${e.level}`;
    const ts = formatTime(e.ts);
    row.innerHTML =
      `<span class="log-ts" style="color:var(--fg-muted);">${ts}</span> ` +
      `<span class="log-level log-level-${e.level}">${e.level.toUpperCase().padEnd(5)}</span> ` +
      `<span class="log-source" style="color:var(--accent);">${escapeHtml(e.source)}</span> ` +
      `<span class="log-msg">${escapeHtml(e.message)}</span>`;
    return row;
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  } catch {
    return iso;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
