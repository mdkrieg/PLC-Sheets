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
  BlockStrategy,
  FailoverPolicy,
  InterfaceConfig,
  ServerConfig,
} from '@shared/types';

type Tab = 'servers' | 'interfaces' | 'diagnostics';

export class SettingsView {
  private host: HTMLElement;
  private config: AppConfig = { servers: [], interfaces: [] };
  private activeTab: Tab = 'servers';
  private dirty = false;

  constructor(host: HTMLElement) {
    this.host = host;
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
          ${this.tabBtn('interfaces', 'Interface')}
          ${this.tabBtn('diagnostics', 'Diagnostics')}
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
      case 'interfaces':
        this.renderInterfaces(body);
        break;
      case 'diagnostics':
        this.renderDiagnostics(body);
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

  // ---- Interfaces ----

  private renderInterfaces(body: HTMLElement): void {
    const sources = this.config.servers.map((s) => s.name);
    // The app supports exactly one interface — it is the implicit target of
    // every MODBUS_* formula. The "+ Add" button disables once one exists.
    const limitReached = this.config.interfaces.length >= 1;
    body.innerHTML = `
      <div style="display:flex;align-items:center;margin-bottom:8px;">
        <h3 style="margin:0;flex:1;">Interface</h3>
        <button class="w2ui-btn" data-act="add" ${sources.length === 0 || limitReached ? 'disabled' : ''}>+ Add interface</button>
      </div>
      ${sources.length === 0 ? '<p style="color:var(--fg-muted);">Add a server first.</p>' : ''}
      ${limitReached ? '<p style="color:var(--fg-muted);font-size:12px;margin:0 0 8px;">Only one interface is supported. All MODBUS_* formulas use this interface implicitly.</p>' : ''}
      <div class="iface-list"></div>
    `;
    const list = body.querySelector<HTMLElement>('.iface-list')!;
    this.config.interfaces.forEach((it, idx) => {
      const card = document.createElement('div');
      card.style.cssText =
        'border:1px solid var(--border);border-radius:4px;padding:10px;margin-bottom:10px;background:var(--bg-alt);';
      const redundant = !!it.secondary;
      const failover = it.failover ?? { kind: 'manual' };
      const secondaryOptions = sources.filter((n) => n !== it.primary);
      card.innerHTML = `
        <div style="display:grid;grid-template-columns:160px 1fr 160px 1fr;gap:8px 12px;align-items:center;">
          <label>Name</label>${textInput(it.name, 'name')}
          <label>Primary server</label>${select(sources, it.primary, 'primary')}
          <label>Bit base</label>${select(['0','1'], String(it.bitBase), 'bitBase')}
          <label>Bit MSB first</label><input type="checkbox" data-field="bitMsbFirst" ${it.bitMsbFirst ? 'checked' : ''} />
          <label>Byte swap</label><input type="checkbox" data-field="byteSwap" ${it.byteSwap ? 'checked' : ''} />
          <label>Word swap</label><input type="checkbox" data-field="wordSwap" ${it.wordSwap ? 'checked' : ''} />
        </div>

        <h4 style="margin-top:14px;margin-bottom:6px;">Redundancy</h4>
        <div style="display:grid;grid-template-columns:160px 1fr 160px 1fr;gap:8px 12px;align-items:center;">
          <label>Enable redundancy</label>
          <div>
            <input type="checkbox" data-field="redundancyEnabled" ${redundant ? 'checked' : ''}
              ${secondaryOptions.length === 0 ? 'disabled' : ''} />
            ${secondaryOptions.length === 0 ? '<span style="color:var(--fg-muted);font-size:12px;margin-left:6px;">Add a second server to enable</span>' : ''}
          </div>
          <label>Secondary server</label>
          ${redundant
            ? select(secondaryOptions, it.secondary ?? secondaryOptions[0] ?? '', 'secondary')
            : '<em style="color:var(--fg-muted);">disabled</em>'}
          ${redundant ? `
            <label>Failover policy</label>${select(['manual','periodic','heartbeat','mismatch'], failover.kind, 'failoverKind')}
            <div></div><div></div>
            <div class="failover-extra" style="grid-column:1 / span 4;">${this.renderFailoverExtra(failover)}</div>
          ` : ''}
          ${redundant ? `
            <div style="grid-column:1 / span 4;text-align:right;">
              <button class="w2ui-btn" data-act="manual-failover">Manual failover now</button>
            </div>
          ` : ''}
        </div>

        <h4 style="margin-top:14px;margin-bottom:6px;">Read</h4>
        <div style="display:grid;grid-template-columns:160px 1fr 160px 1fr;gap:8px 12px;align-items:center;">
          <label>Base poll (s)</label>${numInput(it.read.basePollSec, 'read.basePollSec', 0.05, 3600, 0.05)}
          <label>Min request gap (ms)</label>${numInput(it.read.minRequestGapMs, 'read.minRequestGapMs', 0, 5000)}
          <label>Block strategy</label>${select(['auto','uniform','manual','none'], it.read.blockStrategy.kind, 'read.blockStrategy.kind')}
          <label>Allow individual reads</label><input type="checkbox" data-field="read.allowIndividualReads" ${it.read.allowIndividualReads ? 'checked' : ''} />
          <label>Slow-poll cap (s)</label>${numInput(it.read.slowPollMaxSec, 'read.slowPollMaxSec', 0, 3600)}
          <div class="block-extra" style="grid-column:1 / span 4;">${renderBlockExtra('read', it.read.blockStrategy)}</div>
        </div>
        <h4 style="margin-top:14px;margin-bottom:6px;">Write</h4>
        <div style="display:grid;grid-template-columns:160px 1fr 160px 1fr;gap:8px 12px;align-items:center;">
          <label>Mode</label>${select(['on-change','always'], it.write.mode, 'write.mode')}
          <label>Every (s)</label>${numInput(it.write.everySec ?? 0, 'write.everySec', 0, 3600)}
          <label>Readback every (s)</label>${numInput(it.write.readbackEverySec, 'write.readbackEverySec', 0, 3600)}
          <label>Readback retries</label>${numInput(it.write.readbackRetries, 'write.readbackRetries', 0, 100)}
        </div>
        <div style="text-align:right;margin-top:10px;">
          <button class="w2ui-btn" data-act="del">Delete</button>
        </div>
      `;
      list.appendChild(card);
      this.wireInterfaceCard(card, idx);
    });
    body.querySelector<HTMLButtonElement>('[data-act="add"]')?.addEventListener('click', () => {
      const name = uniqueName('Iface', this.config.interfaces.map((x) => x.name));
      this.config.interfaces.push(defaultInterface(name, sources[0]!));
      this.markDirty();
      this.render();
    });
  }

  private renderFailoverExtra(p: FailoverPolicy): string {
    if (p.kind === 'periodic') {
      return `<label style="margin-right:6px;">Interval (s)</label>${numInput(p.intervalSec, 'failoverIntervalSec', 1, 3600)}`;
    }
    if (p.kind === 'heartbeat') {
      return `
        <label style="margin-right:6px;">Address</label>${textInput(p.address, 'failoverAddress')}
        <label style="margin-left:12px;margin-right:6px;">Stale after (s)</label>${numInput(p.staleAfterSec, 'failoverStaleSec', 1, 3600)}
        <label style="margin-left:12px;margin-right:6px;">Mode</label>${select(['register-incrementing','coil-flipflop'], p.mode, 'failoverMode')}
      `;
    }
    if (p.kind === 'mismatch') {
      return `<label style="margin-right:6px;">After (s)</label>${numInput(p.afterSec, 'failoverAfterSec', 1, 3600)}`;
    }
    return `<em style="color:var(--fg-muted);">Manual: use the button below to swap A/B.</em>`;
  }

  private wireInterfaceCard(card: HTMLElement, idx: number): void {
    const it = this.config.interfaces[idx]!;
    const sources = this.config.servers.map((s) => s.name);
    card.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field]').forEach((el) => {
      el.addEventListener('change', () => {
        const f = el.dataset.field!;
        const isCheckbox = (el as HTMLInputElement).type === 'checkbox';
        const raw = isCheckbox ? (el as HTMLInputElement).checked : (el as HTMLInputElement).value;
        const v: unknown = (el as HTMLInputElement).type === 'number' ? Number(raw) : raw;
        // Special-cased fields first, then fall through to deep-path apply.
        if (f === 'redundancyEnabled') {
          if (raw) {
            const secondaryDefault = sources.find((n) => n !== it.primary) ?? '';
            it.secondary = secondaryDefault;
            it.failover = it.failover ?? { kind: 'manual' };
          } else {
            delete it.secondary;
            delete it.failover;
          }
          this.markDirty();
          this.render();
          return;
        }
        if (f === 'failoverKind') {
          it.failover = makeDefaultFailover(String(v) as FailoverPolicy['kind']);
          this.markDirty();
          this.render();
          return;
        }
        if (f === 'failoverIntervalSec' && it.failover?.kind === 'periodic') {
          it.failover.intervalSec = Number(v);
          this.markDirty();
          return;
        }
        if (f === 'failoverAddress' && it.failover?.kind === 'heartbeat') {
          it.failover.address = String(v);
          this.markDirty();
          return;
        }
        if (f === 'failoverStaleSec' && it.failover?.kind === 'heartbeat') {
          it.failover.staleAfterSec = Number(v);
          this.markDirty();
          return;
        }
        if (f === 'failoverMode' && it.failover?.kind === 'heartbeat') {
          it.failover.mode = String(v) as 'register-incrementing' | 'coil-flipflop';
          this.markDirty();
          return;
        }
        if (f === 'failoverAfterSec' && it.failover?.kind === 'mismatch') {
          it.failover.afterSec = Number(v);
          this.markDirty();
          return;
        }
        applyDeep(it as unknown as Record<string, unknown>, f, v);
        // Special: changing a block strategy kind should swap defaults.
        if (f === 'read.blockStrategy.kind') {
          it.read.blockStrategy = makeDefaultBlock(String(v) as BlockStrategy['kind']);
          this.markDirty();
          this.render();
          return;
        }
        if (f === 'bitBase') {
          it.bitBase = String(v) === '1' ? 1 : 0;
        }
        // Changing primary may invalidate secondary (cannot equal primary).
        if (f === 'primary' && it.secondary === it.primary) {
          it.secondary = sources.find((n) => n !== it.primary) ?? undefined;
          this.render();
        }
        this.markDirty();
      });
    });
    card.querySelector<HTMLButtonElement>('[data-act="manual-failover"]')?.addEventListener('click', () => {
      void window.api.invoke('modbus:manualFailover', { interfaceName: it.name });
    });
    card.querySelector<HTMLButtonElement>('[data-act="del"]')?.addEventListener('click', () => {
      this.config.interfaces.splice(idx, 1);
      this.markDirty();
      this.render();
    });
  }

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

function select(options: string[], value: string, field: string): string {
  const opts = options.map((o) => `<option value="${escapeAttr(o)}" ${o === value ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');
  return `<select data-field="${field}" style="width:100%;padding:3px 6px;background:var(--bg);color:var(--fg);border:1px solid var(--border);">${opts}</select>`;
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function escapeHtml(s: string): string {
  return escapeAttr(s);
}

function uniqueName(prefix: string, existing: string[]): string {
  for (let i = 1; i < 1000; i++) {
    const candidate = `${prefix}${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
  return `${prefix}-${Date.now()}`;
}

function makeDefaultFailover(kind: FailoverPolicy['kind']): FailoverPolicy {
  switch (kind) {
    case 'manual':
      return { kind: 'manual' };
    case 'periodic':
      return { kind: 'periodic', intervalSec: 60 };
    case 'heartbeat':
      return { kind: 'heartbeat', address: '40001', staleAfterSec: 5, mode: 'register-incrementing' };
    case 'mismatch':
      return { kind: 'mismatch', afterSec: 5 };
  }
}

function makeDefaultBlock(kind: BlockStrategy['kind']): BlockStrategy {
  switch (kind) {
    case 'auto':
      return { kind: 'auto', maxSize: 64, minSize: 1, maxBlocks: 32 };
    case 'uniform':
      return { kind: 'uniform', size: 16, offset: 0 };
    case 'manual':
      return { kind: 'manual', blocks: [] };
    case 'none':
      return { kind: 'none' };
  }
}

function defaultInterface(name: string, primary: string): InterfaceConfig {
  return {
    name,
    primary,
    bitBase: 0,
    bitMsbFirst: false,
    byteSwap: false,
    wordSwap: false,
    read: {
      basePollSec: 1,
      minRequestGapMs: 0,
      blockStrategy: { kind: 'auto', maxSize: 64, minSize: 1, maxBlocks: 32 },
      allowIndividualReads: true,
      slowPollMaxSec: 30,
    },
    write: {
      mode: 'on-change',
      everySec: 1,
      readbackEverySec: 0,
      readbackRetries: 0,
    },
  };
}

function renderBlockExtra(_section: 'read' | 'write', strategy: BlockStrategy): string {
  if (strategy.kind === 'auto') {
    return `<div style="display:grid;grid-template-columns:160px 1fr 160px 1fr;gap:8px 12px;align-items:center;">
      <label>Max size</label>${numInput(strategy.maxSize, 'read.blockStrategy.maxSize', 1, 125)}
      <label>Min size</label>${numInput(strategy.minSize, 'read.blockStrategy.minSize', 1, 125)}
      <label>Max blocks</label>${numInput(strategy.maxBlocks, 'read.blockStrategy.maxBlocks', 1, 1024)}
    </div>`;
  }
  if (strategy.kind === 'uniform') {
    return `<div style="display:grid;grid-template-columns:160px 1fr 160px 1fr;gap:8px 12px;align-items:center;">
      <label>Block size</label>${numInput(strategy.size, 'read.blockStrategy.size', 1, 125)}
      <label>Offset</label>${numInput(strategy.offset, 'read.blockStrategy.offset', 0, 65535)}
    </div>`;
  }
  if (strategy.kind === 'manual') {
    return `<em style="color:var(--fg-muted);">Manual blocks not yet editable here; will arrive in a later phase.</em>`;
  }
  return '';
}

/** Apply a value to a dotted path inside an object: "read.blockStrategy.maxSize" */
function applyDeep(target: Record<string, unknown>, dottedPath: string, value: unknown): void {
  const parts = dottedPath.split('.');
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}
