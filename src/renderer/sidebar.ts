/**
 * Custom collapsible sidebar.
 *
 * Sections (each rendered as a <details>):
 *   - File: New / Open / Save / Save As
 *   - Workbook: list of sheets (when one is open)
 *   - Configuration: Servers / Diagnostics buttons (each opens SettingsView tab)
 *   - Modbus: form-based interface configuration (the form formerly under
 *     Settings > Interface). Multiple Modbus interfaces can coexist.
 *   - OPC DA / OPC UA / Ethernet/IP: skeleton placeholders for future
 *     comm types; any combination may be active simultaneously.
 *
 * Config changes are persisted on edit via `config:set` (debounced lightly).
 */

import type {
  AppConfig,
  BlockStrategy,
  FailoverPolicy,
  InterfaceConfig,
  WorkbookModel,
} from '@shared/types';

export interface SidebarCallbacks {
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onSheetSelect: (sheetName: string) => void;
  onShowSettings: (tab: 'servers' | 'diagnostics') => void;
}

interface SectionOpenState {
  file: boolean;
  workbook: boolean;
  config: boolean;
  historian: boolean;
  modbus: boolean;
  opcda: boolean;
  opcua: boolean;
  eip: boolean;
}

export class Sidebar {
  private host: HTMLElement;
  private callbacks: SidebarCallbacks;
  private workbook: WorkbookModel | null = null;
  private activeSheet: string | null = null;
  private config: AppConfig = { servers: [], interfaces: [] };
  private open: SectionOpenState = {
    file: true,
    workbook: true,
    config: false,
    historian: false,
    modbus: true,
    opcda: false,
    opcua: false,
    eip: false,
  };
  private saveTimer: number | null = null;

  constructor(host: HTMLElement, callbacks: SidebarCallbacks) {
    this.host = host;
    this.callbacks = callbacks;
  }

  async init(): Promise<void> {
    this.config = (await window.api.invoke('config:get')) as AppConfig;
    this.render();
  }

  setWorkbook(model: WorkbookModel | null, activeSheet: string | null): void {
    this.workbook = model;
    this.activeSheet = activeSheet;
    this.render();
  }

  setActiveSheet(name: string): void {
    this.activeSheet = name;
    // Cheap: just re-paint sheet links without rebuilding the world.
    this.host.querySelectorAll<HTMLElement>('.sheet-link').forEach((el) => {
      el.classList.toggle('active', el.dataset.sheet === name);
    });
  }

  /** Reload config from main and re-render (e.g. after Servers tab changes). */
  async refreshConfig(): Promise<void> {
    this.config = (await window.api.invoke('config:get')) as AppConfig;
    this.render();
  }

  private render(): void {
    const captureOpen = () => {
      this.host.querySelectorAll<HTMLDetailsElement>('details[data-section]').forEach((d) => {
        const k = d.dataset.section as keyof SectionOpenState;
        if (k in this.open) this.open[k] = d.open;
      });
    };
    captureOpen();

    this.host.innerHTML = `
      <div class="sidebar-host">
        ${this.fileSection()}
        ${this.workbookSection()}
        ${this.configSection()}
        ${this.historianSection()}
        ${this.modbusSection()}
        ${this.skeletonSection('opcda', 'OPC DA')}
        ${this.skeletonSection('opcua', 'OPC UA')}
        ${this.skeletonSection('eip', 'Ethernet/IP')}
      </div>
    `;

    this.wireFile();
    this.wireWorkbook();
    this.wireConfig();
    this.wireHistorian();
    this.wireModbus();
  }

  // ----------------------------------------------------------------- File ---

  private fileSection(): string {
    return `
      <details class="sidebar-section" data-section="file" ${this.open.file ? 'open' : ''}>
        <summary>File</summary>
        <div class="section-body">
          <div class="sidebar-btn-row">
            <button class="w2ui-btn" data-act="new">New</button>
            <button class="w2ui-btn" data-act="open">Open</button>
            <button class="w2ui-btn" data-act="save">Save</button>
            <button class="w2ui-btn" data-act="save-as">Save As</button>
          </div>
        </div>
      </details>
    `;
  }

  private wireFile(): void {
    const root = this.host.querySelector('details[data-section="file"]');
    if (!root) return;
    root.querySelector<HTMLButtonElement>('[data-act="new"]')?.addEventListener('click', () => this.callbacks.onNew());
    root.querySelector<HTMLButtonElement>('[data-act="open"]')?.addEventListener('click', () => this.callbacks.onOpen());
    root.querySelector<HTMLButtonElement>('[data-act="save"]')?.addEventListener('click', () => this.callbacks.onSave());
    root.querySelector<HTMLButtonElement>('[data-act="save-as"]')?.addEventListener('click', () => this.callbacks.onSaveAs());
  }

  // ------------------------------------------------------------- Workbook ---

  private workbookSection(): string {
    if (!this.workbook) {
      return `
        <details class="sidebar-section" data-section="workbook" ${this.open.workbook ? 'open' : ''}>
          <summary>Workbook</summary>
          <div class="section-body" style="color:var(--fg-muted);font-style:italic;">No workbook open</div>
        </details>
      `;
    }
    const items = this.workbook.sheets
      .map(
        (s) =>
          `<div class="sheet-link ${s.name === this.activeSheet ? 'active' : ''}" data-sheet="${escapeAttr(s.name)}">${escapeHtml(s.name)}</div>`,
      )
      .join('');
    return `
      <details class="sidebar-section" data-section="workbook" ${this.open.workbook ? 'open' : ''}>
        <summary>Workbook <span style="color:var(--fg-muted);font-weight:400;font-size:11px;margin-left:6px;">${escapeHtml(this.workbook.fileName)}</span></summary>
        <div class="section-body" style="padding:4px 6px;">${items}</div>
      </details>
    `;
  }

  private wireWorkbook(): void {
    const root = this.host.querySelector('details[data-section="workbook"]');
    if (!root) return;
    root.querySelectorAll<HTMLElement>('.sheet-link').forEach((el) => {
      el.addEventListener('click', () => this.callbacks.onSheetSelect(el.dataset.sheet!));
    });
  }

  // -------------------------------------------------------- Configuration ---

  private configSection(): string {
    return `
      <details class="sidebar-section" data-section="config" ${this.open.config ? 'open' : ''}>
        <summary>Configuration</summary>
        <div class="section-body">
          <div class="sidebar-btn-row">
            <button class="w2ui-btn" data-act="servers">Servers</button>
            <button class="w2ui-btn" data-act="diagnostics">Diagnostics</button>
          </div>
        </div>
      </details>
    `;
  }

  private wireConfig(): void {
    const root = this.host.querySelector('details[data-section="config"]');
    if (!root) return;
    root.querySelector<HTMLButtonElement>('[data-act="servers"]')?.addEventListener('click', () => this.callbacks.onShowSettings('servers'));
    root.querySelector<HTMLButtonElement>('[data-act="diagnostics"]')?.addEventListener('click', () => this.callbacks.onShowSettings('diagnostics'));
  }

  // ----------------------------------------------------------- Historian ---

  private historianSection(): string {
    return `
      <details class="sidebar-section" data-section="historian" ${this.open.historian ? 'open' : ''}>
        <summary>Historian</summary>
        <div class="section-body">
          <div class="sidebar-btn-row">
            <button class="w2ui-btn" data-act="trend-viewer">Trend Viewer</button>
            <button class="w2ui-btn" data-act="historian-settings">Settings</button>
          </div>
        </div>
      </details>
    `;
  }

  private wireHistorian(): void {
    const root = this.host.querySelector('details[data-section="historian"]');
    if (!root) return;
    root.querySelector<HTMLButtonElement>('[data-act="trend-viewer"]')?.addEventListener('click', () => {
      void window.api.invoke('history:openViewer');
    });
    root.querySelector<HTMLButtonElement>('[data-act="historian-settings"]')?.addEventListener('click', () => {
      this.callbacks.onShowSettings('historian' as Parameters<typeof this.callbacks.onShowSettings>[0]);
    });
  }

  // ------------------------------------------------------------- Skeleton ---
  private skeletonSection(key: 'opcda' | 'opcua' | 'eip', label: string): string {
    return `
      <details class="sidebar-section" data-section="${key}" ${this.open[key] ? 'open' : ''}>
        <summary>${label}</summary>
        <div class="section-body" style="color:var(--fg-muted);font-style:italic;font-size:12px;">
          ${label} interface support is not yet implemented.
        </div>
      </details>
    `;
  }

  // --------------------------------------------------------------- Modbus ---

  private modbusSection(): string {
    const sources = this.config.servers.map((s) => s.name);
    const cards = this.config.interfaces
      .map((it, idx) => this.renderModbusCard(it, idx, sources))
      .join('');
    const noServers = sources.length === 0
      ? '<p style="color:var(--fg-muted);font-size:12px;margin:0 0 6px;">Add a server first (Configuration &rarr; Servers).</p>'
      : '';
    return `
      <details class="sidebar-section" data-section="modbus" ${this.open.modbus ? 'open' : ''}>
        <summary>Modbus</summary>
        <div class="section-body">
          ${noServers}
          <div class="iface-list">${cards || '<p style="color:var(--fg-muted);font-size:12px;margin:0 0 6px;">No Modbus interfaces configured.</p>'}</div>
          <button class="w2ui-btn" data-act="add" ${sources.length === 0 ? 'disabled' : ''} style="margin-top:6px;">+ Add Modbus interface</button>
        </div>
      </details>
    `;
  }

  private renderModbusCard(it: InterfaceConfig, idx: number, sources: string[]): string {
    const redundant = !!it.secondary;
    const failover = it.failover ?? { kind: 'manual' };
    const secondaryOptions = sources.filter((n) => n !== it.primary);
    return `
      <div class="iface-card" data-idx="${idx}">
        ${row('Name', textInput(it.name, 'name'))}
        ${row('Primary server', sel(sources, it.primary, 'primary'))}
        ${row('Bit base', sel(['0', '1'], String(it.bitBase), 'bitBase'))}
        ${rowChk('Bit MSB first', 'bitMsbFirst', it.bitMsbFirst)}
        ${rowChk('Byte swap', 'byteSwap', it.byteSwap)}
        ${rowChk('Word swap', 'wordSwap', it.wordSwap)}

        <div class="iface-subhead">Redundancy</div>
        ${rowChk('Enable redundancy', 'redundancyEnabled', redundant, secondaryOptions.length === 0)}
        ${secondaryOptions.length === 0 ? '<div class="iface-hint">Add a second server to enable</div>' : ''}
        ${redundant ? row('Secondary server', sel(secondaryOptions, it.secondary ?? secondaryOptions[0] ?? '', 'secondary')) : ''}
        ${redundant ? row('Failover policy', sel(['manual', 'periodic', 'heartbeat', 'mismatch'], failover.kind, 'failoverKind')) : ''}
        ${redundant ? `<div class="failover-extra">${this.renderFailoverExtra(failover)}</div>` : ''}
        ${redundant ? '<div style="text-align:right;margin-top:6px;"><button class="w2ui-btn" data-act="manual-failover">Manual failover now</button></div>' : ''}

        <div class="iface-subhead">Read</div>
        ${row('Base poll (s)', numInput(it.read.basePollSec, 'read.basePollSec', 0.05, 3600, 0.05))}
        ${row('Min request gap (ms)', numInput(it.read.minRequestGapMs, 'read.minRequestGapMs', 0, 5000))}
        ${row('Block strategy', sel(['auto', 'uniform', 'manual', 'none'], it.read.blockStrategy.kind, 'read.blockStrategy.kind'))}
        ${rowChk('Allow individual reads', 'read.allowIndividualReads', it.read.allowIndividualReads)}
        ${row('Slow-poll cap (s)', numInput(it.read.slowPollMaxSec, 'read.slowPollMaxSec', 0, 3600))}
        ${renderBlockExtra(it.read.blockStrategy)}

        <div class="iface-subhead">Write</div>
        ${row('Mode', sel(['on-change', 'always'], it.write.mode, 'write.mode'))}
        ${row('Every (s)', numInput(it.write.everySec ?? 0, 'write.everySec', 0, 3600))}
        ${row('Readback every (s)', numInput(it.write.readbackEverySec, 'write.readbackEverySec', 0, 3600))}
        ${row('Readback retries', numInput(it.write.readbackRetries, 'write.readbackRetries', 0, 100))}

        <div style="text-align:right;margin-top:8px;">
          <button class="w2ui-btn" data-act="del">Delete</button>
        </div>
      </div>
    `;
  }

  private renderFailoverExtra(p: FailoverPolicy): string {
    if (p.kind === 'periodic') return row('Interval (s)', numInput(p.intervalSec, 'failoverIntervalSec', 1, 3600));
    if (p.kind === 'heartbeat') {
      return (
        row('Address', textInput(p.address, 'failoverAddress')) +
        row('Stale after (s)', numInput(p.staleAfterSec, 'failoverStaleSec', 1, 3600)) +
        row('Mode', sel(['register-incrementing', 'coil-flipflop'], p.mode, 'failoverMode'))
      );
    }
    if (p.kind === 'mismatch') return row('After (s)', numInput(p.afterSec, 'failoverAfterSec', 1, 3600));
    return '<div class="iface-hint">Manual: use the button below to swap A/B.</div>';
  }

  private wireModbus(): void {
    const root = this.host.querySelector('details[data-section="modbus"]');
    if (!root) return;
    const sources = this.config.servers.map((s) => s.name);

    root.querySelector<HTMLButtonElement>('[data-act="add"]')?.addEventListener('click', () => {
      const name = uniqueName('Iface', this.config.interfaces.map((x) => x.name));
      this.config.interfaces.push(defaultInterface(name, sources[0]!));
      this.persist(true);
    });

    root.querySelectorAll<HTMLElement>('.iface-card').forEach((card) => {
      const idx = Number(card.dataset.idx);
      const it = this.config.interfaces[idx];
      if (!it) return;

      card.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field]').forEach((el) => {
        el.addEventListener('change', () => {
          const f = el.dataset.field!;
          const isCheckbox = (el as HTMLInputElement).type === 'checkbox';
          const raw = isCheckbox ? (el as HTMLInputElement).checked : (el as HTMLInputElement).value;
          const v: unknown = (el as HTMLInputElement).type === 'number' ? Number(raw) : raw;

          if (f === 'redundancyEnabled') {
            if (raw) {
              const def = sources.find((n) => n !== it.primary) ?? '';
              it.secondary = def;
              it.failover = it.failover ?? { kind: 'manual' };
            } else {
              delete it.secondary;
              delete it.failover;
            }
            this.persist(true);
            return;
          }
          if (f === 'failoverKind') {
            it.failover = makeDefaultFailover(String(v) as FailoverPolicy['kind']);
            this.persist(true);
            return;
          }
          if (f === 'failoverIntervalSec' && it.failover?.kind === 'periodic') { it.failover.intervalSec = Number(v); this.persist(); return; }
          if (f === 'failoverAddress' && it.failover?.kind === 'heartbeat') { it.failover.address = String(v); this.persist(); return; }
          if (f === 'failoverStaleSec' && it.failover?.kind === 'heartbeat') { it.failover.staleAfterSec = Number(v); this.persist(); return; }
          if (f === 'failoverMode' && it.failover?.kind === 'heartbeat') { it.failover.mode = String(v) as 'register-incrementing' | 'coil-flipflop'; this.persist(); return; }
          if (f === 'failoverAfterSec' && it.failover?.kind === 'mismatch') { it.failover.afterSec = Number(v); this.persist(); return; }

          applyDeep(it as unknown as Record<string, unknown>, f, v);
          if (f === 'read.blockStrategy.kind') {
            it.read.blockStrategy = makeDefaultBlock(String(v) as BlockStrategy['kind']);
            this.persist(true);
            return;
          }
          if (f === 'bitBase') it.bitBase = String(v) === '1' ? 1 : 0;
          if (f === 'primary' && it.secondary === it.primary) {
            it.secondary = sources.find((n) => n !== it.primary) ?? undefined;
            this.persist(true);
            return;
          }
          this.persist();
        });
      });

      card.querySelector<HTMLButtonElement>('[data-act="manual-failover"]')?.addEventListener('click', () => {
        void window.api.invoke('modbus:manualFailover', { interfaceName: it.name });
      });
      card.querySelector<HTMLButtonElement>('[data-act="del"]')?.addEventListener('click', () => {
        this.config.interfaces.splice(idx, 1);
        this.persist(true);
      });
    });
  }

  /** Persist current config to main; optionally re-render to reflect structural changes. */
  private persist(rerender = false): void {
    if (this.saveTimer != null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      void window.api.invoke('config:set', { config: this.config });
      this.saveTimer = null;
    }, 250);
    if (rerender) this.render();
  }
}

// ---------------------------------------------------------------- helpers ---

function row(label: string, control: string): string {
  return `<div class="iface-row"><label>${escapeHtml(label)}</label>${control}</div>`;
}
function rowChk(label: string, field: string, checked: boolean, disabled = false): string {
  return `<div class="iface-row iface-row-chk"><label>${escapeHtml(label)}</label>
    <input type="checkbox" data-field="${field}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} /></div>`;
}
function textInput(value: string, field: string): string {
  return `<input type="text" data-field="${field}" value="${escapeAttr(value)}" class="iface-input" />`;
}
function numInput(value: number, field: string, min?: number, max?: number, step?: number): string {
  const a = min !== undefined ? `min="${min}"` : '';
  const b = max !== undefined ? `max="${max}"` : '';
  const s = step !== undefined ? `step="${step}"` : '';
  return `<input type="number" data-field="${field}" value="${value}" ${a} ${b} ${s} class="iface-input" />`;
}
function sel(options: string[], value: string, field: string): string {
  const opts = options.map((o) => `<option value="${escapeAttr(o)}" ${o === value ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');
  return `<select data-field="${field}" class="iface-input">${opts}</select>`;
}
function renderBlockExtra(strategy: BlockStrategy): string {
  if (strategy.kind === 'auto') {
    return row('Max size', numInput(strategy.maxSize, 'read.blockStrategy.maxSize', 1, 125)) +
      row('Min size', numInput(strategy.minSize, 'read.blockStrategy.minSize', 1, 125)) +
      row('Max blocks', numInput(strategy.maxBlocks, 'read.blockStrategy.maxBlocks', 1, 1024));
  }
  if (strategy.kind === 'uniform') {
    return row('Block size', numInput(strategy.size, 'read.blockStrategy.size', 1, 125)) +
      row('Offset', numInput(strategy.offset, 'read.blockStrategy.offset', 0, 65535));
  }
  if (strategy.kind === 'manual') {
    return '<div class="iface-hint">Manual blocks not yet editable; will arrive in a later phase.</div>';
  }
  return '';
}
function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function escapeHtml(s: string): string {
  return escapeAttr(s);
}
function uniqueName(prefix: string, existing: string[]): string {
  for (let i = 1; i < 1000; i++) {
    const c = `${prefix}${i}`;
    if (!existing.includes(c)) return c;
  }
  return `${prefix}-${Date.now()}`;
}
function makeDefaultFailover(kind: FailoverPolicy['kind']): FailoverPolicy {
  switch (kind) {
    case 'manual': return { kind: 'manual' };
    case 'periodic': return { kind: 'periodic', intervalSec: 60 };
    case 'heartbeat': return { kind: 'heartbeat', address: '40001', staleAfterSec: 5, mode: 'register-incrementing' };
    case 'mismatch': return { kind: 'mismatch', afterSec: 5 };
  }
}
function makeDefaultBlock(kind: BlockStrategy['kind']): BlockStrategy {
  switch (kind) {
    case 'auto': return { kind: 'auto', maxSize: 64, minSize: 1, maxBlocks: 32 };
    case 'uniform': return { kind: 'uniform', size: 16, offset: 0 };
    case 'manual': return { kind: 'manual', blocks: [] };
    case 'none': return { kind: 'none' };
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
