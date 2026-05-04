/**
 * Configuration view: hand-rolled forms for Servers and the single
 * Interface, each rendered as a table-with-Add/Edit/Delete pattern.
 *
 * Redundancy used to be its own top-level tab; it has since been folded
 * into the Interface card (primary + optional secondary + failover policy).
 *
 * We deliberately avoid w2form here — those forms shine for trivial single
 * records but fight us when we need:
 *   - Nested object editors (failover policy, block strategy)
 *   - Validation across siblings (no duplicate names, FK to server names)
 *   - Custom rendering (read/write subgroups in InterfaceConfig)
 *
 * The view loads the current AppConfig from main on mount, supports in-place
 * editing of an in-memory copy, and writes the whole thing back via
 * `config:set` whenever the user hits "Save". Connect/Disconnect remain on
 * the title bar so the user can iterate quickly.
 */

import type {
  AppConfig,
  ServerConfig,
  HistorianConfig,
} from '@shared/types';

type Tab = 'servers' | 'diagnostics' | 'historian';

export interface SettingsViewCallbacks {
  onConfigChanged?: () => void;
}

export class SettingsView {
  private host: HTMLElement;
  private callbacks: SettingsViewCallbacks;
  private config: AppConfig = { servers: [], interfaces: [] };
  private activeTab: Tab = 'servers';
  private dirty = false;

  constructor(host: HTMLElement, callbacks: SettingsViewCallbacks = {}) {
    this.host = host;
    this.callbacks = callbacks;
  }

  async show(tab: Tab = 'servers'): Promise<void> {
    this.activeTab = tab;
    this.config = (await window.api.invoke('config:get')) as AppConfig;
    this.dirty = false;
    this.render();
  }

  private render(): void {
    this.host.innerHTML = `
      <div class="settings-view" style="display:flex;flex-direction:column;height:100%;">
        <div class="settings-tabs" style="display:flex;gap:0;border-bottom:1px solid var(--border);background:var(--bg-toolbar);">
          ${this.tabBtn('servers', 'Servers')}
          ${this.tabBtn('diagnostics', 'Diagnostics')}
          ${this.tabBtn('historian', 'Historian')}
          <div style="flex:1"></div>
          <button class="w2ui-btn" data-act="import" style="margin:4px 4px;">Import...</button>
          <button class="w2ui-btn" data-act="export" style="margin:4px 4px;">Export...</button>
          <button class="w2ui-btn ${this.dirty ? 'armed' : ''}" data-act="save" style="margin:4px 8px 4px 4px;">
            ${this.dirty ? 'Save *' : 'Saved'}
          </button>
        </div>
        <div class="settings-body" style="flex:1;overflow:auto;padding:12px 16px;"></div>
      </div>
    `;

    this.host.querySelectorAll<HTMLElement>('[data-tab]').forEach((el) => {
      el.addEventListener('click', () => {
        this.activeTab = el.dataset.tab as Tab;
        this.render();
      });
    });
    this.host.querySelector<HTMLButtonElement>('[data-act="save"]')?.addEventListener('click', () => this.save());
    this.host.querySelector<HTMLButtonElement>('[data-act="export"]')?.addEventListener('click', () => this.exportConfig());
    this.host.querySelector<HTMLButtonElement>('[data-act="import"]')?.addEventListener('click', () => this.importConfig());

    const body = this.host.querySelector<HTMLElement>('.settings-body')!;
    switch (this.activeTab) {
      case 'servers':
        this.renderServers(body);
        break;
      case 'diagnostics':
        this.renderDiagnostics(body);
        break;
      case 'historian':
        this.renderHistorian(body);
        break;
    }
  }

  private tabBtn(id: Tab, label: string): string {
    const active = id === this.activeTab;
    return `<div data-tab="${id}" class="settings-tab ${active ? 'active' : ''}"
      style="padding:8px 16px;cursor:pointer;border-bottom:2px solid ${active ? 'var(--accent)' : 'transparent'};
      ${active ? 'color:var(--fg);' : 'color:var(--fg-muted);'}">${label}</div>`;
  }

  private markDirty(): void {
    if (!this.dirty) {
      this.dirty = true;
      const btn = this.host.querySelector<HTMLButtonElement>('[data-act="save"]');
      if (btn) {
        btn.textContent = 'Save *';
        btn.classList.add('armed');
      }
    }
  }

  private async save(): Promise<void> {
    await window.api.invoke('config:set', { config: this.config });
    this.dirty = false;
    const btn = this.host.querySelector<HTMLButtonElement>('[data-act="save"]');
    if (btn) {
      btn.textContent = 'Saved';
      btn.classList.remove('armed');
    }
    this.callbacks.onConfigChanged?.();
  }

  private async exportConfig(): Promise<void> {
    // The main process owns the file dialog for export; we round-trip via
    // saveAsDialog to reuse the workbook helper, but with a json filter.
    const dlg = await window.api.invoke('workbook:saveAsDialog', { suggestedName: 'plc-sheets-config.json' });
    if (!dlg) return;
    await window.api.invoke('config:export', { filePath: dlg.filePath });
  }

  private async importConfig(): Promise<void> {
    const dlg = await window.api.invoke('workbook:openDialog');
    if (!dlg) return;
    try {
      const cfg = (await window.api.invoke('config:import', { filePath: dlg.filePath })) as AppConfig;
      this.config = cfg;
      this.dirty = false;
      this.render();
      this.callbacks.onConfigChanged?.();
    } catch (err) {
      alert('Import failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  // ---- Servers ----

  private renderServers(body: HTMLElement): void {
    body.innerHTML = `
      <div style="display:flex;align-items:center;margin-bottom:8px;">
        <h3 style="margin:0;flex:1;">Servers (Modbus TCP)</h3>
        <button class="w2ui-btn" data-act="add">+ Add server</button>
      </div>
      <table class="cfg-table" style="width:100%;border-collapse:collapse;">
        <thead>
          <tr>
            <th style="text-align:left;padding:6px;border-bottom:1px solid var(--border);">Name</th>
            <th style="text-align:left;padding:6px;border-bottom:1px solid var(--border);">IP</th>
            <th style="text-align:left;padding:6px;border-bottom:1px solid var(--border);">Port</th>
            <th style="text-align:left;padding:6px;border-bottom:1px solid var(--border);">Device ID</th>
            <th style="text-align:left;padding:6px;border-bottom:1px solid var(--border);">Timeout (ms)</th>
            <th style="text-align:left;padding:6px;border-bottom:1px solid var(--border);">Reconnect (ms)</th>
            <th style="text-align:left;padding:6px;border-bottom:1px solid var(--border);">1-based</th>
            <th style="border-bottom:1px solid var(--border);"></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    `;
    const tbody = body.querySelector('tbody')!;
    this.config.servers.forEach((s, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="padding:4px;">${textInput(s.name, 'name')}</td>
        <td style="padding:4px;">${textInput(s.ip, 'ip')}</td>
        <td style="padding:4px;">${numInput(s.port, 'port', 1, 65535)}</td>
        <td style="padding:4px;">${numInput(s.deviceId, 'deviceId', 0, 255)}</td>
        <td style="padding:4px;">${numInput(s.timeoutMs, 'timeoutMs', 100, 60000)}</td>
        <td style="padding:4px;">${numInput(s.reconnectMs, 'reconnectMs', 100, 60000)}</td>
        <td style="padding:4px;text-align:center;">
          <input type="checkbox" data-field="oneBased" ${s.oneBased ? 'checked' : ''} />
        </td>
        <td style="padding:4px;"><button class="w2ui-btn" data-act="del">Delete</button></td>
      `;
      tbody.appendChild(tr);
      tr.querySelectorAll<HTMLInputElement>('input[data-field]').forEach((inp) => {
        inp.addEventListener('change', () => {
          const f = inp.dataset.field as keyof ServerConfig;
          const v: unknown =
            inp.type === 'number' ? Number(inp.value) : inp.type === 'checkbox' ? inp.checked : inp.value;
          (this.config.servers[idx] as unknown as Record<string, unknown>)[f] = v;
          this.markDirty();
        });
      });
      tr.querySelector<HTMLButtonElement>('[data-act="del"]')?.addEventListener('click', () => {
        this.config.servers.splice(idx, 1);
        this.markDirty();
        this.render();
      });
    });

    body.querySelector<HTMLButtonElement>('[data-act="add"]')?.addEventListener('click', () => {
      const name = uniqueName('Server', this.config.servers.map((x) => x.name));
      this.config.servers.push({
        name,
        ip: '192.168.1.10',
        port: 502,
        deviceId: 1,
        oneBased: true,
        timeoutMs: 1000,
        reconnectMs: 5000,
      });
      this.markDirty();
      this.render();
    });
  }

  // ---- Interfaces moved to the sidebar (see sidebar.ts) ----

  // ---- Diagnostics ----

  private async renderDiagnostics(body: HTMLElement): Promise<void> {
    body.innerHTML = `
      <div style="display:flex;align-items:center;margin-bottom:8px;">
        <h3 style="margin:0;flex:1;">Diagnostics &amp; Log</h3>
        <button class="w2ui-btn" data-act="refresh">Refresh</button>
        <button class="w2ui-btn" data-act="clear">Clear</button>
      </div>
      <pre class="log-pre" style="background:var(--bg-alt);padding:8px;border:1px solid var(--border);
        border-radius:4px;height:60vh;overflow:auto;font-size:12px;white-space:pre-wrap;"></pre>
    `;
    const pre = body.querySelector<HTMLPreElement>('.log-pre')!;
    const refresh = async () => {
      const entries = await window.api.invoke('log:list');
      pre.textContent = entries
        .map((e) => `${e.ts}  [${e.level.toUpperCase()}]  ${e.source}  ${e.message}`)
        .join('\n');
      pre.scrollTop = pre.scrollHeight;
    };
    body.querySelector<HTMLButtonElement>('[data-act="refresh"]')?.addEventListener('click', refresh);
    body.querySelector<HTMLButtonElement>('[data-act="clear"]')?.addEventListener('click', async () => {
      await window.api.invoke('log:clear');
      refresh();
    });
    void refresh();
  }

  // ---- Historian ----

  private renderHistorian(body: HTMLElement): void {
    const DEFAULT_HISTORIAN: HistorianConfig = {
      defaultDeadband: 0,
      defaultHeartbeatSec: 60,
      batchFlushMs: 1000,
      retentionDays: 30,
    };
    if (!this.config.historian) {
      this.config.historian = { ...DEFAULT_HISTORIAN };
    }
    const h = this.config.historian;

    body.innerHTML = `
      <h3 style="margin:0 0 12px;">Historian Settings</h3>
      <table style="border-collapse:collapse;">
        <tr>
          <td style="padding:6px 12px 6px 0;"><label>Default Deadband</label></td>
          <td style="padding:6px 0;">
            <input type="number" data-hfield="defaultDeadband" value="${h.defaultDeadband}" min="0" step="0.01"
              style="width:120px;padding:3px 6px;background:var(--bg);color:var(--fg);border:1px solid var(--border);font-family:inherit;" />
            <span style="margin-left:6px;font-size:12px;color:var(--fg-muted);">engineering units</span>
          </td>
        </tr>
        <tr>
          <td style="padding:6px 12px 6px 0;"><label>Default Heartbeat</label></td>
          <td style="padding:6px 0;">
            <input type="number" data-hfield="defaultHeartbeatSec" value="${h.defaultHeartbeatSec}" min="1" step="1"
              style="width:120px;padding:3px 6px;background:var(--bg);color:var(--fg);border:1px solid var(--border);font-family:inherit;" />
            <span style="margin-left:6px;font-size:12px;color:var(--fg-muted);">seconds (max interval between writes)</span>
          </td>
        </tr>
        <tr>
          <td style="padding:6px 12px 6px 0;"><label>Batch Flush Interval</label></td>
          <td style="padding:6px 0;">
            <input type="number" data-hfield="batchFlushMs" value="${h.batchFlushMs}" min="100" step="100"
              style="width:120px;padding:3px 6px;background:var(--bg);color:var(--fg);border:1px solid var(--border);font-family:inherit;" />
            <span style="margin-left:6px;font-size:12px;color:var(--fg-muted);">ms (how often pending samples are written to disk)</span>
          </td>
        </tr>
        <tr>
          <td style="padding:6px 12px 6px 0;"><label>Retention</label></td>
          <td style="padding:6px 0;">
            <input type="number" data-hfield="retentionDays" value="${h.retentionDays}" min="1" step="1"
              style="width:120px;padding:3px 6px;background:var(--bg);color:var(--fg);border:1px solid var(--border);font-family:inherit;" />
            <span style="margin-left:6px;font-size:12px;color:var(--fg-muted);">days (older records deleted hourly)</span>
          </td>
        </tr>
      </table>
    `;

    body.querySelectorAll<HTMLInputElement>('input[data-hfield]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const field = inp.dataset.hfield as keyof HistorianConfig;
        (this.config.historian as unknown as Record<string, unknown>)[field] = Number(inp.value);
        this.markDirty();
      });
    });
  }
}

// ---------- helpers ----------

function textInput(value: string, field: string): string {
  return `<input type="text" data-field="${field}" value="${escapeAttr(value)}"
    style="width:100%;padding:3px 6px;background:var(--bg);color:var(--fg);border:1px solid var(--border);font-family:inherit;" />`;
}

function numInput(value: number, field: string, min?: number, max?: number, step?: number): string {
  const a = min !== undefined ? `min="${min}"` : '';
  const b = max !== undefined ? `max="${max}"` : '';
  const s = step !== undefined ? `step="${step}"` : '';
  return `<input type="number" data-field="${field}" value="${value}" ${a} ${b} ${s}
    style="width:100%;padding:3px 6px;background:var(--bg);color:var(--fg);border:1px solid var(--border);font-family:inherit;" />`;
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function uniqueName(prefix: string, existing: string[]): string {
  for (let i = 1; i < 1000; i++) {
    const candidate = `${prefix}${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
  return `${prefix}-${Date.now()}`;
}
